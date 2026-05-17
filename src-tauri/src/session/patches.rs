use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use super::helpers::module_short_name;
use super::types::DebugSession;
use crate::state::{PatchInfo, SessionStateUI};

#[derive(serde::Serialize)]
struct AssemblePatchError {
    session_id: String,
    error: String,
}

fn emit_assemble_patch_error(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
    msg: String,
) {
    if let Some(ref handle) = app_handle_clone {
        let session_id = session.state.lock().unwrap().id.clone();
        let _ = handle.emit(
            "assemble-patch-error",
            &AssemblePatchError { session_id, error: msg },
        );
    }
}

pub(crate) fn persist_patches(session_state: &Arc<Mutex<SessionStateUI>>) {
    let state = session_state.lock().unwrap();
    crate::patch_store::save_patches(&state.launch_command, &state.patches);
}

pub(crate) fn emit_patches_event(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
) {
    if let Some(ref handle) = app_handle_clone {
        let (session_id, patches) = {
            let state = session.state.lock().unwrap();
            (state.id.clone(), state.patches.clone())
        };

        #[derive(serde::Serialize)]
        struct PatchesUpdatedEvent {
            session_id: String,
            patches: Vec<PatchInfo>,
        }

        let payload = PatchesUpdatedEvent { session_id, patches };
        if let Err(e) = handle.emit("patches-updated", &payload) {
            error!("Failed to emit patches-updated event: {}", e);
        }
    }
}

/// Active software breakpoint addresses that fall inside `[address, address+size)`.
/// Software breakpoints overwrite memory with int3/BRK, so they must be temporarily
/// suspended before reading or writing real patch bytes in that range.
fn get_overlapping_software_breakpoints(
    state: &SessionStateUI,
    address: u64,
    size: usize,
) -> Vec<u64> {
    let range_end = address + size as u64;
    state
        .breakpoints
        .iter()
        .filter(|bp| {
            bp.is_active
                && bp.bp_kind == "software"
                && bp.address != 0
                && bp.address >= address
                && bp.address < range_end
        })
        .map(|bp| bp.address)
        .collect()
}

fn suspend_overlapping_breakpoints(
    session: &mut DebugSession,
    pid: u32,
    address: u64,
    size: usize,
) -> Vec<u64> {
    let bp_addrs = {
        let state = session.state.lock().unwrap();
        get_overlapping_software_breakpoints(&state, address, size)
    };
    for &addr in &bp_addrs {
        if let Err(e) = session.remove_breakpoint(pid, addr) {
            warn!(
                "Failed to suspend breakpoint at 0x{:X} for patch operation: {}",
                addr, e
            );
        }
    }
    bp_addrs
}

/// Re-arm previously suspended breakpoints. The re-arm path reads current memory
/// (which may now contain patched bytes) as the breakpoint's new "original" before
/// writing the breakpoint instruction on top, letting patches and BPs coexist.
fn restore_suspended_breakpoints(
    session: &mut DebugSession,
    pid: u32,
    bp_addrs: &[u64],
) {
    for &addr in bp_addrs {
        if let Err(e) = session.rearm_breakpoint(pid, addr) {
            warn!(
                "Failed to restore breakpoint at 0x{:X} after patch operation: {}",
                addr, e
            );
        }
    }
}

fn nop_bytes(arch: joybug2::interfaces::Architecture) -> &'static [u8] {
    match arch {
        joybug2::interfaces::Architecture::X64 => &[0x90],
        joybug2::interfaces::Architecture::Arm64 => &[0x1F, 0x20, 0x03, 0xD5],
    }
}

/// Find the module containing `address` and return its canonical lowercased short
/// name plus offset. Falls back to ("unknown", address) for unresolved ranges.
fn resolve_module_for_patch(state: &SessionStateUI, address: u64) -> (String, u64) {
    for m in &state.modules {
        let module_size = m.size.unwrap_or(0);
        if address >= m.base && (module_size == 0 || address < m.base + module_size) {
            return (module_short_name(&m.name).to_lowercase(), address - m.base);
        }
    }
    ("unknown".to_string(), address)
}

pub(crate) fn process_assemble_patch(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    assembly_text: String,
    arch: joybug2::interfaces::Architecture,
    nop_pad: bool,
) {
    let pid = event.pid();

    {
        let state = session.state.lock().unwrap();
        if state.patches.iter().any(|p| p.address == address && p.is_applied) {
            drop(state);
            emit_assemble_patch_error(
                session,
                app_handle_clone,
                "A patch already exists at this address. Undo it first.".to_string(),
            );
            return;
        }
    }

    let assembled = match joybug2::assembler::assemble(arch, &assembly_text, address) {
        Ok(a) => a,
        Err(e) => {
            emit_assemble_patch_error(session, app_handle_clone, format!("Assembly failed: {}", e));
            return;
        }
    };

    let assembled_len = assembled.bytes.len();

    // disassemble_memory already handles breakpoint byte fixup, so this is safe
    // to call before suspending overlapping BPs.
    let original_disassembly;
    let (patched_bytes, patch_len) = if nop_pad {
        let original_insts = session
            .disassemble_memory(pid, address, 16, arch)
            .unwrap_or_default();

        original_disassembly = if !original_insts.is_empty() {
            format!("{} {}", original_insts[0].mnemonic, original_insts[0].op_str)
        } else {
            String::new()
        };

        let mut covered = 0usize;
        for inst in &original_insts {
            if covered >= assembled_len {
                break;
            }
            covered += inst.bytes.len();
        }

        if covered > assembled_len {
            let nop = nop_bytes(arch);
            let mut padded = assembled.bytes.clone();
            let remaining = covered - assembled_len;
            let mut filled = 0;
            while filled + nop.len() <= remaining {
                padded.extend_from_slice(nop);
                filled += nop.len();
            }
            // Residual bytes shouldn't happen for aligned ARM64 but stay safe.
            for _ in 0..(remaining - filled) {
                padded.push(0x90);
            }
            (padded, covered)
        } else {
            (assembled.bytes.clone(), assembled_len)
        }
    } else {
        original_disassembly = match session.disassemble_memory(pid, address, 1, arch) {
            Ok(insts) if !insts.is_empty() => {
                format!("{} {}", insts[0].mnemonic, insts[0].op_str)
            }
            _ => String::new(),
        };
        (assembled.bytes.clone(), assembled_len)
    };

    let suspended_bps = suspend_overlapping_breakpoints(session, pid, address, patch_len);

    let original_bytes = match session.read_memory(pid, address, patch_len) {
        Ok(b) => b,
        Err(e) => {
            error!("Failed to read original bytes at 0x{:X}: {}", address, e);
            restore_suspended_breakpoints(session, pid, &suspended_bps);
            emit_assemble_patch_error(
                session,
                app_handle_clone,
                format!("Failed to read original bytes: {}", e),
            );
            return;
        }
    };

    let (module_name, module_offset) = {
        let state = session.state.lock().unwrap();
        resolve_module_for_patch(&state, address)
    };

    if let Err(e) = session.write_memory(pid, address, patched_bytes.clone()) {
        error!("Failed to write patched bytes at 0x{:X}: {}", address, e);
        restore_suspended_breakpoints(session, pid, &suspended_bps);
        emit_assemble_patch_error(
            session,
            app_handle_clone,
            format!("Failed to write patched bytes: {}", e),
        );
        return;
    }

    restore_suspended_breakpoints(session, pid, &suspended_bps);

    let patch = PatchInfo {
        id: uuid::Uuid::new_v4().to_string(),
        address,
        module_name,
        module_offset,
        original_bytes,
        patched_bytes,
        assembly_text,
        original_disassembly,
        enabled: true,
        is_applied: true,
        group: None,
    };

    info!(
        "Applied patch at 0x{:X}: {} ({} bytes{})",
        address,
        patch.assembly_text,
        patch_len,
        if nop_pad && patch_len > assembled_len {
            format!(", {} NOP bytes padded", patch_len - assembled_len)
        } else {
            String::new()
        }
    );

    {
        let mut state = session.state.lock().unwrap();
        state.patches.push(patch);
    }

    persist_patches(&session.state);
    emit_patches_event(session, app_handle_clone);
}

pub(crate) fn process_undo_patch(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    patch_id: &str,
) {
    process_undo_patches(session, app_handle_clone, event, std::slice::from_ref(&patch_id.to_string()));
}

pub(crate) fn process_undo_patches(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    patch_ids: &[String],
) {
    let pid = event.pid();

    let patches_to_undo: Vec<PatchInfo> = {
        let state = session.state.lock().unwrap();
        state.patches.iter()
            .filter(|p| patch_ids.contains(&p.id))
            .cloned()
            .collect()
    };

    for patch in &patches_to_undo {
        if patch.is_applied && patch.address != 0 {
            let size = patch.original_bytes.len();
            let suspended_bps = suspend_overlapping_breakpoints(session, pid, patch.address, size);
            if let Err(e) = session.write_memory(pid, patch.address, patch.original_bytes.clone()) {
                warn!("Failed to restore original bytes at 0x{:X}: {}", patch.address, e);
            } else {
                info!("Restored original bytes at 0x{:X}", patch.address);
            }
            restore_suspended_breakpoints(session, pid, &suspended_bps);
        }
    }

    {
        let mut state = session.state.lock().unwrap();
        state.patches.retain(|p| !patch_ids.contains(&p.id));
    }

    persist_patches(&session.state);
    emit_patches_event(session, app_handle_clone);
}

/// Enable/disable one patch without persisting or emitting. Used both standalone
/// and inside the group flow, which persists/emits once at the end.
fn apply_enable_patch(
    session: &mut DebugSession,
    pid: u32,
    patch_id: &str,
    enabled: bool,
) {
    let patch_info = {
        let state = session.state.lock().unwrap();
        state.patches.iter().find(|p| p.id == patch_id).cloned()
    };

    let Some(patch) = patch_info else { return; };

    // Pure metadata flip: nothing to write.
    if (enabled && patch.is_applied) || (!enabled && !patch.is_applied) || patch.address == 0 {
        let mut state = session.state.lock().unwrap();
        if let Some(p) = state.patches.iter_mut().find(|p| p.id == patch_id) {
            p.enabled = enabled;
        }
        return;
    }

    let bytes_to_write = if enabled { &patch.patched_bytes } else { &patch.original_bytes };
    let size = bytes_to_write.len();
    let suspended_bps = suspend_overlapping_breakpoints(session, pid, patch.address, size);
    let write_result = session.write_memory(pid, patch.address, bytes_to_write.clone());
    restore_suspended_breakpoints(session, pid, &suspended_bps);

    let mut state = session.state.lock().unwrap();
    let Some(p) = state.patches.iter_mut().find(|p| p.id == patch_id) else { return; };
    p.enabled = enabled;
    match write_result {
        Ok(()) => {
            p.is_applied = enabled;
            info!("{} patch at 0x{:X}", if enabled { "Enabled" } else { "Disabled" }, patch.address);
        }
        Err(e) => {
            warn!("Failed to {} patch at 0x{:X}: {}", if enabled { "enable" } else { "disable" }, patch.address, e);
        }
    }
}

pub(crate) fn process_enable_patch(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    patch_id: &str,
    enabled: bool,
) {
    apply_enable_patch(session, event.pid(), patch_id, enabled);
    persist_patches(&session.state);
    emit_patches_event(session, app_handle_clone);
}

pub(crate) fn process_update_patch(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
    patch_id: &str,
    group: Option<String>,
) {
    {
        let mut state = session.state.lock().unwrap();
        if let Some(p) = state.patches.iter_mut().find(|p| p.id == patch_id) {
            p.group = group;
        }
    }
    emit_patches_event(session, app_handle_clone);
    persist_patches(&session.state);
}

pub(crate) fn process_enable_patch_group(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    group: &str,
    enabled: bool,
) {
    let patch_ids: Vec<String> = {
        let state = session.state.lock().unwrap();
        state.patches.iter()
            .filter(|p| p.group.as_deref() == Some(group))
            .map(|p| p.id.clone())
            .collect()
    };
    let pid = event.pid();
    for patch_id in patch_ids {
        apply_enable_patch(session, pid, &patch_id, enabled);
    }
    persist_patches(&session.state);
    emit_patches_event(session, app_handle_clone);
}

/// Re-apply patches for a newly loaded module.
///
/// MUST run before reapply_breakpoints_for_module so patches see real binary bytes
/// (not 0xCC) when reading original_bytes, and so breakpoints then store patched
/// bytes as their own originals.
pub(crate) fn reapply_patches_for_module(
    session: &mut DebugSession,
    pid: u32,
    module_name: &str,
    module_base: u64,
) {
    // Snapshot everything we need in one lock so the IPC loop doesn't re-lock per patch.
    let pending: Vec<(String, u64, bool, Vec<u8>)> = {
        let state = session.state.lock().unwrap();
        state.patches.iter()
            .filter(|p| !p.is_applied && p.module_name.eq_ignore_ascii_case(module_name))
            .map(|p| (p.id.clone(), module_base + p.module_offset, p.enabled, p.patched_bytes.clone()))
            .collect()
    };

    // Per-patch IPC, no locks held.
    let mut results: Vec<(String, u64, Option<Vec<u8>>, bool)> = Vec::with_capacity(pending.len());
    for (patch_id, addr, enabled, patched_bytes) in pending {
        if !enabled {
            results.push((patch_id, addr, None, false));
            continue;
        }
        let fresh_original = session.read_memory(pid, addr, patched_bytes.len()).ok();
        let written = session.write_memory(pid, addr, patched_bytes).is_ok();
        results.push((patch_id, addr, fresh_original, written));
    }

    // Single lock to commit all results.
    let mut state = session.state.lock().unwrap();
    for (patch_id, addr, fresh_original, written) in results {
        let Some(p) = state.patches.iter_mut().find(|p| p.id == patch_id) else { continue; };
        p.address = addr;
        if let Some(bytes) = fresh_original {
            p.original_bytes = bytes;
        }
        if written {
            p.is_applied = true;
            info!("Re-applied patch {} at 0x{:X}", p.id, addr);
        } else if !p.enabled {
            info!("Resolved address for disabled patch {} at 0x{:X}", p.id, addr);
        }
    }
}

pub(crate) fn deactivate_patches_for_module(
    state: &mut SessionStateUI,
    module_name: &str,
) {
    for patch in &mut state.patches {
        if patch.module_name.eq_ignore_ascii_case(module_name) && patch.is_applied {
            patch.is_applied = false;
            patch.address = 0;
            info!("Deactivated patch {} (module {} unloaded)", patch.id, module_name);
        }
    }
}
