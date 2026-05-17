use crate::error::Result;
use crate::session::UICommand;
use crate::session::breakpoints::{
    process_enable_breakpoint, process_enable_breakpoint_group,
    process_remove_breakpoint, process_remove_breakpoints, process_set_hardware_breakpoint,
    process_toggle_breakpoint, process_update_breakpoint,
};
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn toggle_breakpoint(
    session_id: String,
    address: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::ToggleBreakpoint { address }) {
        Ok(()) => {
            info!("Toggle breakpoint request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_toggle_breakpoint(&mut oob, &Some(app_handle), pid, address);
            info!("OOB toggle breakpoint for session {} at 0x{:X}", session_id, address);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_breakpoint(
    session_id: String,
    breakpoint_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::RemoveBreakpoint { breakpoint_id: breakpoint_id.clone() }) {
        Ok(()) => {
            info!("Remove breakpoint request sent for session {}, bp_id {}", session_id, breakpoint_id);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_remove_breakpoint(&mut oob, &Some(app_handle), pid, &breakpoint_id);
            info!("OOB remove breakpoint for session {}, bp_id {}", session_id, breakpoint_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_breakpoints(
    session_id: String,
    breakpoint_ids: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::RemoveBreakpoints { breakpoint_ids: breakpoint_ids.clone() }) {
        Ok(()) => {
            info!("Remove breakpoints request sent for session {}, {} breakpoints", session_id, breakpoint_ids.len());
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_remove_breakpoints(&mut oob, &Some(app_handle), pid, &breakpoint_ids);
            info!("OOB remove breakpoints for session {}, {} breakpoints", session_id, breakpoint_ids.len());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint(
    session_id: String,
    breakpoint_id: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::EnableBreakpoint { breakpoint_id: breakpoint_id.clone(), enabled }) {
        Ok(()) => {
            info!("Enable breakpoint request sent for session {}, bp_id {}, enabled={}", session_id, breakpoint_id, enabled);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_enable_breakpoint(&mut oob, &Some(app_handle), pid, &breakpoint_id, enabled);
            info!("OOB enable breakpoint for session {}, bp_id {}, enabled={}", session_id, breakpoint_id, enabled);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint_group(
    session_id: String,
    group: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::EnableBreakpointGroup { group: group.clone(), enabled }) {
        Ok(()) => {
            info!("Enable breakpoint group request sent for session {}, group '{}', enabled={}", session_id, group, enabled);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_enable_breakpoint_group(&mut oob, &Some(app_handle), pid, &group, enabled);
            info!("OOB enable breakpoint group for session {}, group '{}', enabled={}", session_id, group, enabled);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_hardware_breakpoint(
    session_id: String,
    address: String,
    hw_type: String,
    hw_size: u8,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::SetHardwareBreakpoint { address, hw_type: hw_type.clone(), hw_size }) {
        Ok(()) => {
            info!("Set hardware breakpoint request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            process_set_hardware_breakpoint(&mut oob, &Some(app_handle), pid, address, &hw_type, hw_size);
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
    match super::try_send_paused_command(&session_arc, UICommand::UpdateBreakpoint { breakpoint_id: breakpoint_id.clone(), name: name.clone(), group: group.clone() }) {
        Ok(()) => {
            info!("Update breakpoint request sent for session {}, bp_id {}", session_id, breakpoint_id);
        }
        Err(_) => {
            // update_breakpoint is metadata-only, no server communication needed.
            // Create OOB client just to share state and emit events.
            let (oob, _pid) = super::create_oob_client(&session_arc)?;
            process_update_breakpoint(&oob, &Some(app_handle), &breakpoint_id, name, group);
            info!("OOB update breakpoint for session {}, bp_id {}", session_id, breakpoint_id);
        }
    }
    Ok(())
}
