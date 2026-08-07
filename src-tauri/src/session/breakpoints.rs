use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use super::helpers::{format_symbol, is_system_module_path, module_short_name};
use super::types::DebugSession;
use crate::state::SessionStateUI;

/// Convert hw_type string to joybug-core HardwareBreakpointType
fn parse_hw_type(hw_type: &str) -> Option<joybug_core::protocol::HardwareBreakpointType> {
    match hw_type {
        "Execute" => Some(joybug_core::protocol::HardwareBreakpointType::Execute),
        "Write" => Some(joybug_core::protocol::HardwareBreakpointType::Write),
        "ReadWrite" => Some(joybug_core::protocol::HardwareBreakpointType::ReadWrite),
        _ => None,
    }
}

/// Resolve an address to a source file/line for breakpoint display (best-effort).
fn resolve_source_line(session: &mut DebugSession, pid: u32, address: u64) -> (Option<String>, Option<u32>) {
    match super::source::resolve_file_line(session, pid, address) {
        Some((path, line)) => (Some(path), Some(line)),
        None => (None, None),
    }
}

/// Convert hw_size u8 to joybug-core HardwareBreakpointSize
fn parse_hw_size(hw_size: u8) -> Option<joybug_core::protocol::HardwareBreakpointSize> {
    match hw_size {
        1 => Some(joybug_core::protocol::HardwareBreakpointSize::Byte1),
        2 => Some(joybug_core::protocol::HardwareBreakpointSize::Byte2),
        4 => Some(joybug_core::protocol::HardwareBreakpointSize::Byte4),
        8 => Some(joybug_core::protocol::HardwareBreakpointSize::Byte8),
        _ => None,
    }
}

/// Remove a breakpoint of any kind at `address` from the debuggee. Watchpoints are
/// torn down via `stop_watchpoint_trace`; hardware breakpoints via
/// `remove_hardware_breakpoint`; software via `remove_breakpoint`.
fn remove_bp_of_kind(session: &mut DebugSession, pid: u32, address: u64, bp_kind: &str) -> Result<(), String> {
    match bp_kind {
        "hardware" => session.remove_hardware_breakpoint(pid, address),
        "watchpoint" => session.stop_watchpoint_trace(pid, address),
        _ => session.remove_breakpoint(pid, address),
    }
    .map_err(|e| e.to_string())
}

/// Arm a software breakpoint at `address`, single-shot (auto-removed by the server on
/// first hit) or persistent (Keep handler) depending on `single_shot`.
fn arm_software_breakpoint(session: &mut DebugSession, pid: u32, address: u64, single_shot: bool) -> Result<(), String> {
    if single_shot {
        session.set_single_shot_breakpoint_at(pid, address, |_s, _p, _t, _a| Ok(()))
    } else {
        session.set_breakpoint_at(pid, address, None, |_s, _p, _t, _a| {
            Ok(joybug_core::protocol_io::BreakpointDecision::Keep)
        })
    }
    .map_err(|e| e.to_string())
}

/// Arm a breakpoint of any kind at `address` in the debuggee: a fresh silent access
/// trace for watchpoints, a Keep-handler hardware breakpoint for `"hardware"`, and a
/// software breakpoint (single-shot or persistent) otherwise.
fn arm_bp_of_kind(session: &mut DebugSession, pid: u32, address: u64, bp_kind: &str, hw_type: Option<&str>, hw_size: Option<u8>, single_shot: bool) -> Result<(), String> {
    match bp_kind {
        "hardware" | "watchpoint" => {
            let t = hw_type.and_then(parse_hw_type)
                .unwrap_or(joybug_core::protocol::HardwareBreakpointType::Execute);
            let s = hw_size.and_then(parse_hw_size)
                .unwrap_or(joybug_core::protocol::HardwareBreakpointSize::Byte1);
            if bp_kind == "watchpoint" {
                session.start_watchpoint_trace(pid, address, t, s)
                    .map_err(|e| e.to_string())
            } else {
                session.set_hardware_breakpoint_at(pid, address, t, s, |_s, _p, _t, _a| {
                    Ok(joybug_core::protocol_io::BreakpointDecision::Keep)
                })
                .map_err(|e| e.to_string())
            }
        }
        _ => arm_software_breakpoint(session, pid, address, single_shot),
    }
}

/// Identity of a module's on-disk file ("size:mtime_ns"), recorded per
/// breakpoint so a rebuilt binary can be detected before persisted RVAs are
/// re-armed at (now wrong) instructions. None when the file can't be inspected
/// (remote target, device path) — the check is then skipped, not failed.
pub(crate) fn module_file_fingerprint(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let ns = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{}", meta.len(), ns))
}

/// Fingerprint of the on-disk file of the module containing `address`, if any.
fn module_fingerprint_at(session: &DebugSession, address: u64) -> Option<String> {
    let path = {
        let state = session.state.lock().unwrap();
        state.modules.iter()
            .find(|m| {
                let size = m.size.unwrap_or(0);
                address >= m.base && (size == 0 || address < m.base + size)
            })
            .map(|m| m.name.clone())
    };
    path.as_deref().and_then(module_file_fingerprint)
}

/// Persist breakpoints to disk for the current session's launch command
pub(crate) fn persist_breakpoints(session_state: &Arc<Mutex<SessionStateUI>>) {
    let state = session_state.lock().unwrap();
    crate::breakpoint_store::save_breakpoints(&state.launch_command, &state.breakpoints);
}

/// Emit a breakpoints-updated event to the frontend
pub(crate) fn emit_breakpoints_event(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
) {
    if let Some(ref handle) = app_handle_clone {
        let (session_id, breakpoints) = {
            let state = session.state.lock().unwrap();
            (state.id.clone(), state.breakpoints.clone())
        };

        #[derive(serde::Serialize)]
        struct BreakpointsUpdatedEvent {
            session_id: String,
            breakpoints: Vec<crate::state::BreakpointInfo>,
        }

        let payload = BreakpointsUpdatedEvent { session_id, breakpoints };
        if let Err(e) = handle.emit("breakpoints-updated", &payload) {
            error!("Failed to emit breakpoints-updated event: {}", e);
        }
    }
}

/// Build a friendly hit message for a breakpoint-type debug event by looking up the
/// matching row at `address`: names the group + module/label (e.g. entry/TLS), or the
/// user's breakpoint name. Returns None when no row matches (the caller falls back to
/// the raw event `Display` string).
pub(crate) fn breakpoint_hit_message(session: &DebugSession, address: u64) -> Option<String> {
    let state = session.state.lock().unwrap();
    let bp = state.breakpoints.iter().find(|b| b.address == address)?;
    let label = bp.name.clone()
        .unwrap_or_else(|| format!("{}+0x{:X}", bp.module_name, bp.module_offset));
    let msg = match bp.group.as_deref() {
        Some(group) => format!("{} hit: {} @ 0x{:X}", group, label, address),
        None => format!("Breakpoint hit: {} @ 0x{:X}", label, address),
    };
    Some(msg)
}

/// Drop the (already server-removed) single-shot breakpoint row at `address` after its
/// one hit. Returns true if a row was removed (the caller emits `breakpoints-updated`).
pub(crate) fn remove_single_shot_row_on_hit(session: &mut DebugSession, address: u64) -> bool {
    let mut state = session.state.lock().unwrap();
    let before = state.breakpoints.len();
    state.breakpoints.retain(|b| !(b.address == address && b.single_shot));
    state.breakpoints.len() != before
}

/// Snapshot the addresses that currently have a breakpoint row. Callers doing batch
/// inserts add each newly armed address to the returned set as they go, so the loop
/// stays O(N) without re-scanning (and re-locking) the growing list per address.
fn existing_breakpoint_addresses(session: &DebugSession) -> std::collections::HashSet<u64> {
    let state = session.state.lock().unwrap();
    state.breakpoints.iter().map(|bp| bp.address).collect()
}

/// Arm a software breakpoint at `address` and push a new `BreakpointInfo` row (tagged
/// with `group` / `name`) into session state. `single_shot` arms a one-shot breakpoint
/// (auto-removed by the server on first hit). Does NOT emit or persist — callers batch
/// that. The caller must ensure no breakpoint already exists at `address`.
fn add_software_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    address: u64,
    group: Option<String>,
    name: Option<String>,
    auto: bool,
    single_shot: bool,
) {
    let (module_name, module_offset, module_path) = {
        let state = session.state.lock().unwrap();
        let mut found = None;
        for m in &state.modules {
            let module_size = m.size.unwrap_or(0);
            if address >= m.base && (module_size == 0 || address < m.base + module_size) {
                let name = module_short_name(&m.name).to_lowercase();
                found = Some((name, address - m.base, Some(m.name.clone())));
                break;
            }
        }
        found.unwrap_or_else(|| ("unknown".to_string(), address, None))
    };

    let bp_id = uuid::Uuid::new_v4().to_string();
    let mut is_active = false;

    match arm_software_breakpoint(session, pid, address, single_shot) {
        Ok(()) => {
            is_active = true;
            info!("Set {}breakpoint at 0x{:X} ({}+0x{:X})", if single_shot { "single-shot " } else { "" }, address, module_name, module_offset);
        }
        Err(e) => {
            let msg = format!("Failed to set breakpoint at 0x{:X}: {}", address, e);
            error!("{}", msg);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::log_error(handle, &msg, None);
                crate::ui_logger::toast_error(handle, &msg);
            }
        }
    }

    // Symbol/source are display-only. Auto rows are planted from the module-load
    // event, while the module's PDB load (kicked off by that same event) is still
    // in flight — the server-side resolvers block on pending symbol loads, which
    // would stall the event loop once per module. Skip resolution for them; the
    // row still shows module+offset and its group name.
    let (symbol, source_file, source_line) = if auto {
        (None, None, None)
    } else {
        let symbol = match session.resolve_address_to_symbol(pid, address) {
            Ok((Some(m), Some(sym), Some(offset))) => {
                Some(format_symbol(&m, &sym.name, offset))
            }
            _ => None,
        };
        let (source_file, source_line) = resolve_source_line(session, pid, address);
        (symbol, source_file, source_line)
    };

    let module_fingerprint = module_path.as_deref().and_then(module_file_fingerprint);

    let mut state = session.state.lock().unwrap();
    state.breakpoints.push(crate::state::BreakpointInfo {
        id: bp_id,
        address,
        module_name,
        module_offset,
        name,
        group,
        symbol,
        enabled: true,
        is_active,
        bp_kind: "software".to_string(),
        hw_type: None,
        hw_size: None,
        source_file,
        source_line,
        auto,
        single_shot,
        module_fingerprint,
    });
}

/// Group names for the settings-driven auto breakpoints (module entry / TLS callbacks).
const GROUP_MODULE_ENTRY: &str = "Module Entry";
const GROUP_TLS_CALLBACKS: &str = "TLS Callbacks";

/// The four settings-driven auto-breakpoint toggles, split by user/system module
/// scope for each of entry point / TLS callbacks.
#[derive(Clone, Copy, Default)]
struct AutoBpToggles {
    user_entry: bool,
    system_entry: bool,
    user_tls: bool,
    system_tls: bool,
}

impl AutoBpToggles {
    fn any(self) -> bool {
        self.user_entry || self.system_entry || self.user_tls || self.system_tls
    }
}

/// Read the settings-driven auto-breakpoint toggles. Absent app handle → all off.
fn read_auto_settings(app_handle_clone: &Option<AppHandle>) -> AutoBpToggles {
    match app_handle_clone {
        Some(handle) => {
            let s = handle.state::<crate::settings::SettingsState>();
            let s = s.lock().unwrap();
            AutoBpToggles {
                user_entry: s.break_on_user_module_entry,
                system_entry: s.break_on_system_module_entry,
                user_tls: s.break_on_user_tls_callbacks,
                system_tls: s.break_on_system_tls_callbacks,
            }
        }
        None => AutoBpToggles::default(),
    }
}

/// Compute the auto-breakpoint targets `(address, group, row-name)` for one loaded
/// module, given the settings toggles. The module's full `path` selects the
/// user vs system (System32/SysWOW64) scope for each of entry / TLS.
fn module_auto_targets(
    session: &mut DebugSession,
    pid: u32,
    base: u64,
    path: &str,
    toggles: AutoBpToggles,
) -> Vec<(u64, &'static str, String)> {
    let is_system = is_system_module_path(path);
    let break_entry = if is_system { toggles.system_entry } else { toggles.user_entry };
    let break_tls = if is_system { toggles.system_tls } else { toggles.user_tls };

    let mut targets: Vec<(u64, &'static str, String)> = Vec::new();
    if !break_entry && !break_tls {
        return targets;
    }

    let info = match session.get_module_extra_info(pid, base) {
        Ok(info) => info,
        Err(e) => {
            warn!("Auto breakpoints: failed to read PE info for module @ 0x{:X}: {}", base, e);
            return targets;
        }
    };

    let short = module_short_name(path);
    if break_entry {
        let entry_rva = info.nt_headers.OptionalHeader.AddressOfEntryPoint;
        // RVA 0 means no entry point (e.g. resource-only DLLs) — skip.
        if entry_rva != 0 {
            targets.push((base + entry_rva as u64, GROUP_MODULE_ENTRY, short.clone()));
        }
    }
    if break_tls {
        for (i, &rva) in info.tls_callbacks.iter().enumerate() {
            targets.push((base + rva as u64, GROUP_TLS_CALLBACKS, format!("{} TLS[{}]", short, i)));
        }
    }
    targets
}

/// Plant settings-driven single-shot software breakpoints for a freshly loaded module:
/// at its entry point and/or each TLS callback, gated by the user/system entry/TLS
/// toggles read from `SettingsState`. The resulting rows are tagged `auto` + `single_shot`
/// (grouped, visible, individually removable, auto-removed on first hit, never persisted).
/// Addresses already covered by an existing breakpoint are skipped, so this composes with
/// `reapply_breakpoints_for_module` (which runs first).
///
/// Call AFTER `reapply_breakpoints_for_module` so user breakpoints win the address.
pub(crate) fn apply_auto_module_breakpoints(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    module_base: u64,
) {
    let toggles = read_auto_settings(app_handle_clone);
    if !toggles.any() {
        return;
    }

    let path = {
        let state = session.state.lock().unwrap();
        state.modules.iter().find(|m| m.base == module_base).map(|m| m.name.clone())
    };
    let path = match path {
        Some(p) => p,
        None => return,
    };

    let targets = module_auto_targets(session, pid, module_base, &path, toggles);
    if targets.is_empty() {
        return;
    }

    // Skip addresses already covered (user breakpoints, or rows just re-armed by
    // reapply_breakpoints_for_module). Inserting as we go also dedups within this batch.
    let mut seen = existing_breakpoint_addresses(session);

    let mut planted = false;
    for (address, group, name) in targets {
        if !seen.insert(address) {
            continue;
        }
        add_software_breakpoint(session, app_handle_clone, pid, address, Some(group.to_string()), Some(name), true, true);
        planted = true;
    }

    if planted {
        emit_breakpoints_event(session, app_handle_clone);
        // Not persisted: auto rows are regenerated from settings on each run.
    }
}

/// Reconcile the settings-driven auto breakpoints across ALL loaded modules against the
/// current settings. Invoked when the user toggles an entry/TLS setting mid-session:
/// removes auto rows whose category is now disabled (so stale rows don't linger in the
/// list) and plants auto rows for categories now enabled on already-loaded modules.
/// Un-hit auto rows only — hit ones are already gone. Never persisted.
pub(crate) fn process_sync_auto_breakpoints(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
) {
    let toggles = read_auto_settings(app_handle_clone);

    // Desired address -> (group, name) across every loaded module. Empty when all
    // toggles are off — only stale removal can change anything then.
    let mut desired: std::collections::HashMap<u64, (&'static str, String)> = std::collections::HashMap::new();
    if toggles.any() {
        let modules: Vec<(u64, String)> = {
            let state = session.state.lock().unwrap();
            state.modules.iter().map(|m| (m.base, m.name.clone())).collect()
        };
        for (base, path) in &modules {
            for (address, group, name) in module_auto_targets(session, pid, *base, path, toggles) {
                desired.entry(address).or_insert((group, name));
            }
        }
    }

    // Remove auto rows no longer desired (disarm active ones on the server first).
    let stale_ids: Vec<String> = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .filter(|bp| bp.auto && !desired.contains_key(&bp.address))
            .map(|bp| bp.id.clone())
            .collect()
    };
    let mut changed = false;
    for id in &stale_ids {
        changed |= apply_remove_breakpoint(session, pid, id);
    }

    // Add desired targets not already covered by a breakpoint row.
    let mut seen = existing_breakpoint_addresses(session);
    for (address, (group, name)) in desired {
        if !seen.insert(address) {
            continue;
        }
        add_software_breakpoint(session, app_handle_clone, pid, address, Some(group.to_string()), Some(name), true, true);
        changed = true;
    }

    if changed {
        emit_breakpoints_event(session, app_handle_clone);
    }
}

/// Processes a toggle breakpoint request. When adding a new breakpoint, `single_shot`
/// arms it as a one-shot (auto-removed on first hit).
pub(crate) fn process_toggle_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    address: u64,
    single_shot: bool,
) {

    let existing_bp_id = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter().find(|bp| bp.address == address).map(|bp| bp.id.clone())
    };

    if let Some(bp_id) = existing_bp_id {
        let is_active = {
            let state = session.state.lock().unwrap();
            state.breakpoints.iter().find(|bp| bp.id == bp_id).map(|bp| bp.is_active).unwrap_or(false)
        };
        if is_active {
            if let Err(e) = session.remove_breakpoint(pid, address) {
                warn!("Failed to remove breakpoint at 0x{:X}: {}", address, e);
            }
        }
        {
            let mut state = session.state.lock().unwrap();
            state.breakpoints.retain(|bp| bp.id != bp_id);
        }
        info!("Removed breakpoint at 0x{:X}", address);
    } else {
        add_software_breakpoint(session, app_handle_clone, pid, address, None, None, false, single_shot);
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes a batch set-breakpoints request: arm a software breakpoint at each address,
/// tagging every new row with `group`. Addresses that already have a breakpoint are
/// skipped (idempotent). Emits + persists once at the end.
pub(crate) fn process_set_breakpoints(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    addresses: &[u64],
    group: Option<String>,
    single_shot: bool,
) {
    // Addresses that already have a breakpoint are skipped; inserting each armed
    // address as we go also skips duplicates within this batch.
    let mut seen = existing_breakpoint_addresses(session);
    for &address in addresses {
        if !seen.insert(address) {
            continue;
        }
        add_software_breakpoint(session, app_handle_clone, pid, address, group.clone(), None, false, single_shot);
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes a remove breakpoint request
/// Core logic for removing a single breakpoint by id: disarm on the server if
/// active (kind-aware), drop the row. No emit/persist — callers batch that.
/// Returns true if a row was removed.
fn apply_remove_breakpoint(session: &mut DebugSession, pid: u32, breakpoint_id: &str) -> bool {
    let bp_info = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter().find(|bp| bp.id == breakpoint_id).cloned()
    };
    let bp = match bp_info {
        Some(bp) => bp,
        None => return false,
    };

    if bp.is_active {
        if let Err(e) = remove_bp_of_kind(session, pid, bp.address, &bp.bp_kind) {
            warn!("Failed to remove breakpoint at 0x{:X}: {}", bp.address, e);
        }
    }
    {
        let mut state = session.state.lock().unwrap();
        state.breakpoints.retain(|b| b.id != breakpoint_id);
    }
    info!("Removed breakpoint {}", breakpoint_id);
    true
}

pub(crate) fn process_remove_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    breakpoint_id: &str,
) {
    apply_remove_breakpoint(session, pid, breakpoint_id);

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes a batch remove breakpoints request (single event + persist at the end)
pub(crate) fn process_remove_breakpoints(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    breakpoint_ids: &[String],
) {
    for breakpoint_id in breakpoint_ids {
        apply_remove_breakpoint(session, pid, breakpoint_id);
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Core logic for enabling/disabling a single breakpoint (no emit/persist).
pub(crate) fn apply_enable_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    breakpoint_id: &str,
    enabled: bool,
) {
    let bp_info = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter().find(|bp| bp.id == breakpoint_id).cloned()
    };

    if let Some(bp) = bp_info {
        let address = if bp.address == 0 && enabled {
            let state = session.state.lock().unwrap();
            super::helpers::find_module_by_name(&state.modules, &bp.module_name)
                .map(|m| m.base + bp.module_offset)
                .unwrap_or(0)
        } else {
            bp.address
        };

        if enabled && !bp.is_active && address != 0 {
            let set_result = arm_bp_of_kind(session, pid, address, &bp.bp_kind, bp.hw_type.as_deref(), bp.hw_size, bp.single_shot);
            match set_result {
                Ok(()) => {
                    // An explicit enable accepts the module file as it is now —
                    // refresh the recorded identity (see reapply invalidation).
                    let module_fingerprint = module_fingerprint_at(session, address);
                    let mut state = session.state.lock().unwrap();
                    if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                        b.enabled = true;
                        b.is_active = true;
                        b.address = address;
                        if module_fingerprint.is_some() {
                            b.module_fingerprint = module_fingerprint;
                        }
                    }
                }
                Err(e) => {
                    let msg = format!("Failed to enable breakpoint at 0x{:X}: {}", address, e);
                    warn!("{}", msg);
                    if let Some(ref handle) = app_handle_clone {
                        crate::ui_logger::log_error(handle, &msg, None);
                        crate::ui_logger::toast_error(handle, &msg);
                    }
                    let mut state = session.state.lock().unwrap();
                    if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                        b.enabled = true;
                    }
                }
            }
        } else if !enabled && bp.is_active {
            if let Err(e) = remove_bp_of_kind(session, pid, address, &bp.bp_kind) {
                warn!("Failed to disable breakpoint: {}", e);
            }
            let mut state = session.state.lock().unwrap();
            if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                b.enabled = false;
                b.is_active = false;
            }
        } else {
            let mut state = session.state.lock().unwrap();
            if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                b.enabled = enabled;
            }
        }
    }
}

/// Processes an enable/disable breakpoint request
pub(crate) fn process_enable_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    breakpoint_id: &str,
    enabled: bool,
) {
    apply_enable_breakpoint(session, app_handle_clone, pid, breakpoint_id, enabled);
    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes an enable/disable breakpoint group request
pub(crate) fn process_enable_breakpoint_group(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    group: &str,
    enabled: bool,
) {
    let bp_ids: Vec<String> = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .filter(|bp| bp.group.as_deref() == Some(group))
            .map(|bp| bp.id.clone())
            .collect()
    };
    for bp_id in bp_ids {
        apply_enable_breakpoint(session, app_handle_clone, pid, &bp_id, enabled);
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes an update breakpoint (name/group) request
pub(crate) fn process_update_breakpoint(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
    breakpoint_id: &str,
    name: Option<String>,
    group: Option<String>,
) {
    {
        let mut state = session.state.lock().unwrap();
        if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
            bp.name = name;
            bp.group = group;
        }
    }
    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Re-resolve source file/line for a module's active breakpoints and, if any
/// changed, emit + persist. Called after a manual PDB finishes loading
/// asynchronously (see `reapply_symbols_for_module`), so breakpoints that were
/// re-applied before the symbols were ready pick up their source lines. Runs
/// over whichever client the caller holds (the async path uses an OOB client).
pub(crate) fn refresh_breakpoint_source_lines_for_module(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    module_name: &str,
) {
    let targets: Vec<(String, u64)> = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .filter(|bp| bp.is_active && bp.address != 0 && bp.module_name.eq_ignore_ascii_case(module_name))
            .map(|bp| (bp.id.clone(), bp.address))
            .collect()
    };
    if targets.is_empty() {
        return;
    }

    let mut changed = false;
    for (bp_id, addr) in targets {
        let (source_file, source_line) = resolve_source_line(session, pid, addr);
        let mut state = session.state.lock().unwrap();
        if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == bp_id) {
            if bp.source_file != source_file || bp.source_line != source_line {
                bp.source_file = source_file;
                bp.source_line = source_line;
                changed = true;
            }
        }
    }

    if changed {
        emit_breakpoints_event(session, app_handle_clone);
        persist_breakpoints(&session.state);
    }
}

/// Re-apply breakpoints for a newly loaded module.
///
/// Before arming, each persisted breakpoint's recorded module-file fingerprint is
/// compared against the file on disk now: a rebuilt/updated binary invalidates the
/// stored RVAs (they may land mid-instruction), so mismatching breakpoints are
/// auto-disabled with a warning instead of being armed at wrong locations. The
/// fingerprint is refreshed on that pass, so explicitly re-enabling a row accepts
/// the new binary.
pub(crate) fn reapply_breakpoints_for_module(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    module_name: &str,
    module_base: u64,
) {
    let module_path: Option<String> = {
        let state = session.state.lock().unwrap();
        state.modules.iter().find(|m| m.base == module_base).map(|m| m.name.clone())
    };
    let current_fp = module_path.as_deref().and_then(module_file_fingerprint);

    let breakpoints_to_apply: Vec<crate::state::BreakpointInfo> = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .filter(|bp| !bp.is_active && bp.module_name.eq_ignore_ascii_case(module_name))
            .cloned()
            .collect()
    };

    let mut invalidated: usize = 0;
    for snap in breakpoints_to_apply {
        let addr = module_base + snap.module_offset;
        // Only a definite mismatch invalidates; an unknown side (legacy entry,
        // uninspectable file) keeps today's trust-the-RVA behavior.
        let stale = matches!((&snap.module_fingerprint, &current_fp), (Some(s), Some(c)) if s != c);
        if stale {
            let mut state = session.state.lock().unwrap();
            if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == snap.id) {
                if bp.enabled {
                    invalidated += 1;
                }
                bp.enabled = false;
                bp.is_active = false;
                bp.address = addr;
                // Accept the new binary's identity so the warning fires once, not
                // on every future run; the row stays disabled until the user
                // re-enables it deliberately.
                bp.module_fingerprint = current_fp.clone();
                warn!("Breakpoint {} at {}+0x{:X} invalidated: module file changed on disk", bp.id, module_name, bp.module_offset);
            }
            continue;
        }

        let armed = snap.enabled
            && arm_bp_of_kind(session, pid, addr, &snap.bp_kind, snap.hw_type.as_deref(), snap.hw_size, snap.single_shot).is_ok();
        if snap.enabled && !armed {
            continue;
        }
        let (source_file, source_line) = resolve_source_line(session, pid, addr);
        let mut state = session.state.lock().unwrap();
        if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == snap.id) {
            bp.address = addr;
            bp.source_file = source_file;
            bp.source_line = source_line;
            if bp.module_fingerprint.is_none() {
                bp.module_fingerprint = current_fp.clone();
            }
            if armed {
                bp.is_active = true;
                info!("Re-applied breakpoint {} at 0x{:X}", bp.id, addr);
            } else {
                info!("Resolved address for disabled breakpoint {} at 0x{:X}", bp.id, addr);
            }
        }
    }

    if invalidated > 0 {
        let msg = format!(
            "{} breakpoint{} in {} disabled: the module file changed on disk since {} saved",
            invalidated,
            if invalidated == 1 { "" } else { "s" },
            module_name,
            if invalidated == 1 { "it was" } else { "they were" },
        );
        warn!("{}", msg);
        if let Some(ref handle) = app_handle_clone {
            crate::ui_logger::log_warn(handle, &msg, None);
            crate::ui_logger::toast_error(handle, &msg);
        }
        persist_breakpoints(&session.state);
    }
}

/// Processes a set hardware breakpoint request (breaks into the debugger on hit).
pub(crate) fn process_set_hardware_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    address: u64,
    hw_type_str: &str,
    hw_size_val: u8,
) {
    arm_hardware_at(session, app_handle_clone, pid, address, hw_type_str, hw_size_val, false);
}

/// Processes a start-watchpoint-trace request: arm a hardware watchpoint in silent
/// "find what reads/writes this address" mode. Same setup as a hardware breakpoint,
/// but the server records accessors and auto-continues instead of breaking; the
/// breakpoint row is tagged `bp_kind == "watchpoint"` (the frontend shows an
/// active watchpoint as "tracing").
pub(crate) fn process_start_watchpoint_trace(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    address: u64,
    hw_type_str: &str,
    hw_size_val: u8,
) {
    arm_hardware_at(session, app_handle_clone, pid, address, hw_type_str, hw_size_val, true);
}

/// Shared implementation for arming a hardware breakpoint (`is_trace == false`) or a
/// silent access trace (`is_trace == true`) at `address`.
fn arm_hardware_at(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    address: u64,
    hw_type_str: &str,
    hw_size_val: u8,
    is_trace: bool,
) {
    let kind_label = if is_trace { "access trace" } else { "hardware breakpoint" };

    // If a breakpoint already exists at this address, remove it first
    let existing_bp_id = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter().find(|bp| bp.address == address).map(|bp| (bp.id.clone(), bp.bp_kind.clone(), bp.is_active))
    };
    if let Some((bp_id, bp_kind, is_active)) = existing_bp_id {
        if is_active {
            if let Err(e) = remove_bp_of_kind(session, pid, address, &bp_kind) {
                warn!("Failed to remove existing breakpoint at 0x{:X}: {}", address, e);
            }
        }
        let mut state = session.state.lock().unwrap();
        state.breakpoints.retain(|bp| bp.id != bp_id);
        info!("Removed existing breakpoint at 0x{:X} before setting {}", address, kind_label);
    }

    let hw_type = match parse_hw_type(hw_type_str) {
        Some(t) => t,
        None => {
            error!("Invalid hardware breakpoint type: {}", hw_type_str);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::toast_error(handle, &format!("Invalid HW breakpoint type: {}", hw_type_str));
            }
            return;
        }
    };

    let hw_size = match parse_hw_size(hw_size_val) {
        Some(s) => s,
        None => {
            error!("Invalid hardware breakpoint size: {}", hw_size_val);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::toast_error(handle, &format!("Invalid HW breakpoint size: {} (must be 1, 2, 4, or 8)", hw_size_val));
            }
            return;
        }
    };

    let (module_name, module_offset) = {
        let state = session.state.lock().unwrap();
        let mut found = None;
        for m in &state.modules {
            let module_size = m.size.unwrap_or(0);
            if address >= m.base && (module_size == 0 || address < m.base + module_size) {
                let name = module_short_name(&m.name).to_lowercase();
                found = Some((name, address - m.base));
                break;
            }
        }
        found.unwrap_or_else(|| ("unknown".to_string(), address))
    };

    let bp_id = uuid::Uuid::new_v4().to_string();
    let mut is_active = false;

    let arm_result = if is_trace {
        session.start_watchpoint_trace(pid, address, hw_type, hw_size)
    } else {
        session.set_hardware_breakpoint_at(pid, address, hw_type, hw_size, |_session, _pid, _tid, _addr| {
            Ok(joybug_core::protocol_io::BreakpointDecision::Keep)
        })
    };
    match arm_result {
        Ok(()) => {
            is_active = true;
            info!("Set {} at 0x{:X} ({}+0x{:X}, type={}, size={})", kind_label, address, module_name, module_offset, hw_type_str, hw_size_val);
        }
        Err(e) => {
            let msg = format!("Failed to set {} at 0x{:X}: {}", kind_label, address, e);
            error!("{}", msg);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::log_error(handle, &msg, None);
                crate::ui_logger::toast_error(handle, &msg);
            }
        }
    }

    let symbol = match session.resolve_address_to_symbol(pid, address) {
        Ok((Some(m), Some(sym), Some(offset))) => {
            Some(format_symbol(&m, &sym.name, offset))
        }
        _ => None,
    };
    let (source_file, source_line) = resolve_source_line(session, pid, address);

    let module_fingerprint = module_fingerprint_at(session, address);

    {
        let mut state = session.state.lock().unwrap();
        state.breakpoints.push(crate::state::BreakpointInfo {
            id: bp_id,
            address,
            module_name,
            module_offset,
            name: None,
            group: None,
            symbol,
            enabled: true,
            is_active,
            bp_kind: if is_trace { "watchpoint".to_string() } else { "hardware".to_string() },
            hw_type: Some(hw_type_str.to_string()),
            hw_size: Some(hw_size_val),
            source_file,
            source_line,
            auto: false,
            single_shot: false,
            module_fingerprint,
        });
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes a stop-watchpoint-trace request: tear down the hardware watchpoint but
/// keep the breakpoint row (inactive) as a record. The collected accessors live in
/// the frontend panel, which retains them.
pub(crate) fn process_stop_watchpoint_trace(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    breakpoint_id: &str,
) {
    let address = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .find(|bp| bp.id == breakpoint_id && bp.bp_kind == "watchpoint")
            .map(|bp| bp.address)
    };
    let Some(address) = address else {
        warn!("StopWatchpointTrace: no watchpoint with id {}", breakpoint_id);
        return;
    };

    if address != 0 {
        if let Err(e) = session.stop_watchpoint_trace(pid, address) {
            warn!("Failed to stop watchpoint trace at 0x{:X}: {}", address, e);
        }
    }

    {
        let mut state = session.state.lock().unwrap();
        if let Some(bp) = state.breakpoints.iter_mut().find(|bp| bp.id == breakpoint_id) {
            bp.is_active = false;
            // A stopped trace is inert: mark it disabled so a module reload does not
            // silently re-arm it (re-enable from the panel restarts collection).
            bp.enabled = false;
        }
    }
    info!("Stopped access trace (breakpoint {})", breakpoint_id);

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Mark breakpoints as inactive when their module is unloaded
pub(crate) fn deactivate_breakpoints_for_module(
    state: &mut SessionStateUI,
    module_name: &str,
) {
    for bp in &mut state.breakpoints {
        if bp.module_name.eq_ignore_ascii_case(module_name) && bp.is_active {
            bp.is_active = false;
            bp.address = 0;
            info!("Deactivated breakpoint {} (module {} unloaded)", bp.id, module_name);
        }
    }
}
