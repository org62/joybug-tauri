use crate::error::Result;
use crate::state::{LogEntry, LogsState};
use tauri::State;

#[tauri::command]
pub fn get_logs(logs_state: State<'_, LogsState>) -> Result<Vec<LogEntry>> {
    let logs = logs_state.lock().unwrap();
    Ok(logs.clone())
}

#[tauri::command]
pub fn add_log(
    level: String,
    message: String,
    session_id: Option<String>,
    logs_state: State<'_, LogsState>,
) -> Result<()> {
    let mut logs = logs_state.lock().unwrap();
    logs.push(LogEntry::new(&level.to_uppercase(), &message, session_id));
    Ok(())
}

#[tauri::command]
pub fn clear_logs(logs_state: State<'_, LogsState>) -> Result<()> {
    let mut logs = logs_state.lock().unwrap();
    logs.clear();
    Ok(())
}
