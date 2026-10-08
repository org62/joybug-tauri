//! `commands::etw_trace` on every OS but Windows: the same two commands with
//! the same signatures, so `generate_handler!` and the frontend's `invoke`
//! names are identical everywhere, returning what an ETW-less session would.

use tauri::State;

use crate::state::{SandboxHandlesMap, SessionStatesMap};

/// No tracer can have written anything: always empty.
#[tauri::command]
pub async fn poll_etw_events(
    session_id: String,
    from_seq: u64,
    sandbox_handles: State<'_, SandboxHandlesMap>,
) -> std::result::Result<Vec<serde_json::Value>, String> {
    let _ = (session_id, from_seq, sandbox_handles);
    Ok(Vec::new())
}

/// Nothing to symbolize against: the raw frames come back unchanged, which is
/// also what the Windows version does for a detached session.
#[tauri::command]
pub async fn resolve_etw_stack(
    session_id: String,
    pid: u32,
    addresses: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> std::result::Result<Vec<String>, String> {
    let _ = (session_id, pid, session_states, oob_pool);
    Ok(addresses)
}

/// See `etw_trace::evict_cursors`; there are no cursors here.
pub fn evict_cursors(_session_id: &str) {}
