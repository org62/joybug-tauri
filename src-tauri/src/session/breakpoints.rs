use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use super::helpers::{format_symbol, module_short_name};
use super::types::DebugSession;
use crate::state::SessionStateUI;

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

/// Processes a toggle breakpoint request
pub(crate) fn process_toggle_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
) {
    let pid = event.pid();

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

        match session.set_breakpoint_at(pid, address, None, |_session, _pid, _tid, _addr| {
            Ok(joybug2::protocol_io::BreakpointDecision::Keep)
        }) {
            Ok(()) => {
                is_active = true;
                info!("Set breakpoint at 0x{:X} ({}+0x{:X})", address, module_name, module_offset);
            }
            Err(e) => {
                error!("Failed to set breakpoint at 0x{:X}: {}", address, e);
                if let Some(ref handle) = app_handle_clone {
                    crate::ui_logger::toast_error(handle, &format!("Failed to set breakpoint: {}", e));
                }
            }
        }

        let symbol = match session.resolve_address_to_symbol(pid, address) {
            Ok((Some(m), Some(sym), Some(offset))) => {
                Some(format_symbol(&m, &sym.name, offset))
            }
            _ => None,
        };

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
            });
        }
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes a remove breakpoint request
pub(crate) fn process_remove_breakpoint(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    breakpoint_id: &str,
) {
    let pid = event.pid();
    let bp_info = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter().find(|bp| bp.id == breakpoint_id).cloned()
    };

    if let Some(bp) = bp_info {
        if bp.is_active {
            if let Err(e) = session.remove_breakpoint(pid, bp.address) {
                warn!("Failed to remove breakpoint at 0x{:X}: {}", bp.address, e);
            }
        }
        {
            let mut state = session.state.lock().unwrap();
            state.breakpoints.retain(|b| b.id != breakpoint_id);
        }
        info!("Removed breakpoint {}", breakpoint_id);
    }

    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Core logic for enabling/disabling a single breakpoint (no emit/persist).
pub(crate) fn apply_enable_breakpoint(
    session: &mut DebugSession,
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
            state.modules.iter()
                .find(|m| m.name.eq_ignore_ascii_case(&bp.module_name) ||
                      module_short_name(&m.name).eq_ignore_ascii_case(&bp.module_name))
                .map(|m| m.base + bp.module_offset)
                .unwrap_or(0)
        } else {
            bp.address
        };

        if enabled && !bp.is_active && address != 0 {
            match session.set_breakpoint_at(pid, address, None, |_s, _p, _t, _a| {
                Ok(joybug2::protocol_io::BreakpointDecision::Keep)
            }) {
                Ok(()) => {
                    let mut state = session.state.lock().unwrap();
                    if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                        b.enabled = true;
                        b.is_active = true;
                        b.address = address;
                    }
                }
                Err(e) => {
                    warn!("Failed to enable breakpoint: {}", e);
                    let mut state = session.state.lock().unwrap();
                    if let Some(b) = state.breakpoints.iter_mut().find(|b| b.id == breakpoint_id) {
                        b.enabled = true;
                    }
                }
            }
        } else if !enabled && bp.is_active {
            if let Err(e) = session.remove_breakpoint(pid, address) {
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
    event: &joybug2::protocol_io::DebugEvent,
    breakpoint_id: &str,
    enabled: bool,
) {
    apply_enable_breakpoint(session, event.pid(), breakpoint_id, enabled);
    emit_breakpoints_event(session, app_handle_clone);
    persist_breakpoints(&session.state);
}

/// Processes an enable/disable breakpoint group request
pub(crate) fn process_enable_breakpoint_group(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
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

    let pid = event.pid();
    for bp_id in bp_ids {
        apply_enable_breakpoint(session, pid, &bp_id, enabled);
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

/// Re-apply breakpoints for a newly loaded module
pub(crate) fn reapply_breakpoints_for_module(
    session: &mut DebugSession,
    pid: u32,
    module_name: &str,
    module_base: u64,
) {
    let breakpoints_to_apply: Vec<(String, u64, bool)> = {
        let state = session.state.lock().unwrap();
        state.breakpoints.iter()
            .filter(|bp| !bp.is_active && bp.module_name.eq_ignore_ascii_case(module_name))
            .map(|bp| (bp.id.clone(), module_base + bp.module_offset, bp.enabled))
            .collect()
    };

    for (bp_id, addr, enabled) in breakpoints_to_apply {
        if enabled {
            if session.set_breakpoint_at(pid, addr, None, |_s, _p, _t, _a| {
                Ok(joybug2::protocol_io::BreakpointDecision::Keep)
            }).is_ok() {
                let mut state = session.state.lock().unwrap();
                if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == bp_id) {
                    bp.address = addr;
                    bp.is_active = true;
                    info!("Re-applied breakpoint {} at 0x{:X}", bp.id, addr);
                }
            }
        } else {
            let mut state = session.state.lock().unwrap();
            if let Some(bp) = state.breakpoints.iter_mut().find(|b| b.id == bp_id) {
                bp.address = addr;
                info!("Resolved address for disabled breakpoint {} at 0x{:X}", bp.id, addr);
            }
        }
    }
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
