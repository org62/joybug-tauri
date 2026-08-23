use crate::error::Result;
use crate::session::UICommand;
use crate::session::breakpoints::{
    process_enable_breakpoint, process_enable_breakpoint_group,
    process_remove_breakpoint, process_remove_breakpoints, process_set_breakpoints,
    process_set_hardware_breakpoint, process_toggle_breakpoint,
    remove_breakpoint_rows_offline, set_breakpoint_enabled_offline, update_breakpoint_offline,
};
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn toggle_breakpoint(
    session_id: String,
    address: String,
    single_shot: Option<bool>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;
    let single_shot = single_shot.unwrap_or(false);

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::ToggleBreakpoint { address, single_shot }) {
        Ok(()) => {
            info!("Toggle breakpoint request sent for session {} at 0x{:X} (single_shot={})", session_id, address, single_shot);
        }
        Err(_) => {
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
                process_toggle_breakpoint(oob, &Some(app_handle), pid, address, single_shot);
            })?;
            info!("OOB toggle breakpoint for session {} at 0x{:X} (single_shot={})", session_id, address, single_shot);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_breakpoints(
    session_id: String,
    addresses: Vec<String>,
    group: Option<String>,
    single_shot: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let addresses: Vec<u64> = addresses
        .iter()
        .map(|a| super::parse_hex_u64(a, "address"))
        .collect::<Result<Vec<u64>>>()?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::SetBreakpoints { addresses: addresses.clone(), group: group.clone(), single_shot }) {
        Ok(()) => {
            info!("Set breakpoints request sent for session {}, {} addresses", session_id, addresses.len());
        }
        Err(_) => {
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
                process_set_breakpoints(oob, &Some(app_handle), pid, &addresses, group.clone(), single_shot);
            })?;
            info!("OOB set breakpoints for session {}, {} addresses", session_id, addresses.len());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_breakpoint(
    session_id: String,
    breakpoint_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let handle = app_handle.clone();
    let route = super::paused_or_offline_or_oob(
        &session_arc, &session_id, &oob_pool,
        UICommand::RemoveBreakpoint { breakpoint_id: breakpoint_id.clone() },
        || remove_breakpoint_rows_offline(&session_arc, &handle, std::slice::from_ref(&breakpoint_id)),
        |oob, pid| process_remove_breakpoint(oob, &Some(app_handle), pid, &breakpoint_id),
    )?;
    info!("Remove breakpoint for session {}, bp_id {} ({:?})", session_id, breakpoint_id, route);
    Ok(())
}

#[tauri::command]
pub fn remove_breakpoints(
    session_id: String,
    breakpoint_ids: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let handle = app_handle.clone();
    let route = super::paused_or_offline_or_oob(
        &session_arc, &session_id, &oob_pool,
        UICommand::RemoveBreakpoints { breakpoint_ids: breakpoint_ids.clone() },
        || remove_breakpoint_rows_offline(&session_arc, &handle, &breakpoint_ids),
        |oob, pid| process_remove_breakpoints(oob, &Some(app_handle), pid, &breakpoint_ids),
    )?;
    info!("Remove breakpoints for session {}, {} breakpoints ({:?})", session_id, breakpoint_ids.len(), route);
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint(
    session_id: String,
    breakpoint_id: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let handle = app_handle.clone();
    let route = super::paused_or_offline_or_oob(
        &session_arc, &session_id, &oob_pool,
        UICommand::EnableBreakpoint { breakpoint_id: breakpoint_id.clone(), enabled },
        || set_breakpoint_enabled_offline(&session_arc, &handle, |bp| bp.id == breakpoint_id, enabled),
        |oob, pid| process_enable_breakpoint(oob, &Some(app_handle), pid, &breakpoint_id, enabled),
    )?;
    info!("Enable breakpoint for session {}, bp_id {}, enabled={} ({:?})", session_id, breakpoint_id, enabled, route);
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint_group(
    session_id: String,
    group: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let handle = app_handle.clone();
    let route = super::paused_or_offline_or_oob(
        &session_arc, &session_id, &oob_pool,
        UICommand::EnableBreakpointGroup { group: group.clone(), enabled },
        || set_breakpoint_enabled_offline(&session_arc, &handle, |bp| bp.group.as_deref() == Some(group.as_str()), enabled),
        |oob, pid| process_enable_breakpoint_group(oob, &Some(app_handle), pid, &group, enabled),
    )?;
    info!("Enable breakpoint group for session {}, group '{}', enabled={} ({:?})", session_id, group, enabled, route);
    Ok(())
}

#[tauri::command]
pub fn set_hardware_breakpoint(
    session_id: String,
    address: String,
    hw_type: String,
    hw_size: u8,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::SetHardwareBreakpoint { address, hw_type: hw_type.clone(), hw_size }) {
        Ok(()) => {
            info!("Set hardware breakpoint request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
                process_set_hardware_breakpoint(oob, &Some(app_handle), pid, address, &hw_type, hw_size);
            })?;
            info!("OOB set hardware breakpoint for session {} at 0x{:X}", session_id, address);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_breakpoint(
    session_id: String,
    breakpoint_id: String,
    name: Option<String>,
    group: Option<String>,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    // Metadata-only: nothing to say to the server on any path, so when the
    // paused channel isn't available the state edit is the whole operation —
    // no OOB connection needed (and none to fail) whether running or stopped.
    match super::try_send_paused_command(&session_arc, UICommand::UpdateBreakpoint { breakpoint_id: breakpoint_id.clone(), name: name.clone(), group: group.clone() }) {
        Ok(()) => {
            info!("Update breakpoint request sent for session {}, bp_id {}", session_id, breakpoint_id);
        }
        Err(_) => {
            update_breakpoint_offline(&session_arc, &app_handle, &breakpoint_id, name, group);
            info!("Update breakpoint applied to state for session {}, bp_id {}", session_id, breakpoint_id);
        }
    }
    Ok(())
}
