use crate::error::Result;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;

#[tauri::command]
pub fn step_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::Go)
}

#[tauri::command]
pub fn step_in_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::StepIn)
}

#[tauri::command]
pub fn step_over_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::StepOver)
}

#[tauri::command]
pub fn step_out_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::StepOut)
}
