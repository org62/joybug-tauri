use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn toggle_breakpoint(
    session_id: String,
    address: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let address = u64::from_str_radix(address.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid address '{}': {}", address, e)))?;
    super::send_paused_command(&session_id, &session_states, UICommand::ToggleBreakpoint { address })?;
    info!("Toggle breakpoint request sent for session {} at address 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn remove_breakpoint(
    session_id: String,
    breakpoint_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::RemoveBreakpoint { breakpoint_id: breakpoint_id.clone() })?;
    info!("Remove breakpoint request sent for session {}, bp_id {}", session_id, breakpoint_id);
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint(
    session_id: String,
    breakpoint_id: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::EnableBreakpoint { breakpoint_id: breakpoint_id.clone(), enabled })?;
    info!("Enable breakpoint request sent for session {}, bp_id {}, enabled={}", session_id, breakpoint_id, enabled);
    Ok(())
}

#[tauri::command]
pub fn enable_breakpoint_group(
    session_id: String,
    group: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::EnableBreakpointGroup { group: group.clone(), enabled })?;
    info!("Enable breakpoint group request sent for session {}, group '{}', enabled={}", session_id, group, enabled);
    Ok(())
}

#[tauri::command]
pub fn update_breakpoint(
    session_id: String,
    breakpoint_id: String,
    name: Option<String>,
    group: Option<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::UpdateBreakpoint { breakpoint_id: breakpoint_id.clone(), name, group })?;
    info!("Update breakpoint request sent for session {}, bp_id {}", session_id, breakpoint_id);
    Ok(())
}
