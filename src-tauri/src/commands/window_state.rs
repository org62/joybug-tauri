use crate::error::{Error, Result};
use crate::session::emit_session_event;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn update_window_state(
    session_id: String,
    window_type: String,
    is_open: bool,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    {
        let mut state = session_state.lock().unwrap();
        match window_type.as_str() {
            "disassembly" => state.is_disassembly_window_open = is_open,
            "registers" => state.is_registers_window_open = is_open,
            "callstack" => state.is_callstack_window_open = is_open,
            _ => return Err(Error::InvalidSessionState(format!(
                "Unknown window type: {}",
                window_type
            ))),
        }
    }

    emit_session_event(&session_state, &app_handle);

    debug!("Updated window state for session {}: {} = {}", session_id, window_type, is_open);
    Ok(())
}
