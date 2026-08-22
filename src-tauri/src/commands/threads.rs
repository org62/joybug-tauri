//! Thread commands for the Threads panel: the context-thread switch, and bulk
//! control (suspend / resume / terminate).
//!
//! The bulk actions run over the OOB connection so they work while Paused,
//! Running, or non-invasively Open. Each tid is handled independently and
//! reports its own error, so one dead thread doesn't abort the rest of a
//! selection. The switch is a paused-only UICommand.

use tauri::State;
use tracing::info;

use super::types::ThreadActionResult;
use super::SessionStatesMap;
use crate::error::Result;
use crate::session::types::UICommand;

/// Switch the context thread of a paused session (registers, call stack and
/// register writes follow it until the next pause).
#[tauri::command]
pub fn select_thread(
    session_id: String,
    tid: u32,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::SelectThread { tid })?;
    info!("Select thread {} sent for session {}", tid, session_id);
    Ok(())
}

fn run_thread_action(
    session_id: &str,
    tids: Vec<u32>,
    session_states: &SessionStatesMap,
    oob_pool: &super::OobPool,
    app_handle: &tauri::AppHandle,
    label: &str,
    mut call: impl FnMut(&mut crate::session::types::DebugSession, u32, u32) -> std::result::Result<(), String>,
) -> Result<Vec<ThreadActionResult>> {
    let session_arc = super::get_session_arc(session_id, session_states)?;
    let results = super::with_oob_client(&session_arc, session_id, oob_pool, move |client, pid| {
        tids.into_iter()
            .map(|tid| ThreadActionResult { tid, error: call(client, pid, tid).err() })
            .collect::<Vec<_>>()
    })?;
    for r in &results {
        match &r.error {
            None => crate::ui_logger::log_info(app_handle, &format!("{} thread {}", label, r.tid), Some(session_id.to_string())),
            Some(e) => crate::ui_logger::log_error(app_handle, &format!("{} thread {} failed: {}", label, r.tid, e), Some(session_id.to_string())),
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn suspend_threads(
    session_id: String,
    tids: Vec<u32>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<ThreadActionResult>> {
    run_thread_action(&session_id, tids, &session_states, &oob_pool, &app_handle, "Suspended", |c, pid, tid| c.suspend_thread(pid, tid).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn resume_threads(
    session_id: String,
    tids: Vec<u32>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<ThreadActionResult>> {
    run_thread_action(&session_id, tids, &session_states, &oob_pool, &app_handle, "Resumed", |c, pid, tid| c.resume_thread(pid, tid).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn terminate_threads(
    session_id: String,
    tids: Vec<u32>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<ThreadActionResult>> {
    run_thread_action(&session_id, tids, &session_states, &oob_pool, &app_handle, "Terminated", |c, pid, tid| c.terminate_thread(pid, tid, 0).map_err(|e| e.to_string()))
}
