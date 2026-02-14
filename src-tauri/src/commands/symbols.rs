use crate::error::Result;
use crate::session::{UICommand, SymbolData};
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::{debug, info};

#[tauri::command]
pub fn search_session_symbols(
    session_id: String,
    pattern: String,
    limit: Option<usize>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<SymbolData>> {
    debug!("Searching for symbols in session {} with pattern '{}'", session_id, pattern);
    super::send_paused_command(&session_id, &session_states, UICommand::SearchSymbols {
        pattern: pattern.clone(),
        limit: limit.unwrap_or(30) as u32,
    })?;
    info!("Symbol search request sent for session {} with pattern '{}'", session_id, pattern);
    Ok(Vec::new())
}

#[tauri::command]
pub fn request_resolve_thread_symbols(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ResolveThreadSymbols)?;
    info!("Resolve thread symbols request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_thread_callstack(
    session_id: String,
    tid: u32,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::GetThreadCallStack { tid })?;
    info!("Thread callstack request sent for session {}, tid {}", session_id, tid);
    Ok(())
}

#[tauri::command]
pub fn request_session_callstack(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::GetCallStack)?;
    info!("Request for call stack sent for session {}", session_id);
    Ok(())
}
