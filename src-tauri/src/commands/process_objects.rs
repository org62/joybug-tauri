//! The Handles window: kernel handles, windows, TCP connections and token
//! privileges of the target, plus close-handle / toggle-privilege /
//! enable-window.
//!
//! Everything runs over the OOB connection so the window works while Paused,
//! Running, or non-invasively Open; the server does the enumeration (it owns
//! the process handle), and the results are returned directly — no event
//! round trip, the view just awaits the `invoke`.

use tauri::State;
use tracing::info;

use super::SessionStatesMap;
use crate::error::{Error, Result};
use joybug_core::protocol_io::ProcessObjects;

/// Every command here is the same shape: resolve the session, run one call on
/// its pooled OOB client, and flatten the nested result (pool error outside,
/// protocol error inside) into one `Error`. Factored so a new object-window
/// command is its `info!` plus one line.
fn oob_call<T, E: std::fmt::Display>(
    session_id: &str,
    session_states: &SessionStatesMap,
    oob_pool: &super::OobPool,
    call: impl FnOnce(&mut crate::session::types::DebugSession, u32) -> std::result::Result<T, E>,
) -> Result<T> {
    let session_arc = super::get_session_arc(session_id, session_states)?;
    super::with_oob_client(&session_arc, session_id, oob_pool, call)?
        .map_err(|e| Error::TargetOperation(e.to_string()))
}

/// Snapshot of the target's handles / windows / TCP connections / privileges.
#[tauri::command]
pub fn get_process_objects(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<ProcessObjects> {
    oob_call(&session_id, &session_states, &oob_pool, |oob, pid| oob.list_process_objects(pid))
}

/// Close `handle` (hex string) inside the target process.
#[tauri::command]
pub fn close_process_handle(
    session_id: String,
    handle: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    let handle = super::parse_hex_u64(&handle, "handle")?;
    info!(session_id, handle = format!("{:#x}", handle), "Closing target handle");
    oob_call(&session_id, &session_states, &oob_pool, |oob, pid| oob.close_remote_handle(pid, handle))
}

/// Enable or disable a named privilege on the target's primary token.
#[tauri::command]
pub fn set_process_privilege(
    session_id: String,
    name: String,
    enable: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    info!(session_id, name, enable, "Adjusting target privilege");
    oob_call(&session_id, &session_states, &oob_pool, |oob, pid| oob.set_privilege(pid, &name, enable))
}

/// `EnableWindow` on a window (hex HWND) owned by the target.
#[tauri::command]
pub fn set_process_window_enabled(
    session_id: String,
    hwnd: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    let hwnd = super::parse_hex_u64(&hwnd, "hwnd")?;
    info!(session_id, hwnd = format!("{:#x}", hwnd), enabled, "Toggling target window");
    oob_call(&session_id, &session_states, &oob_pool, |oob, pid| oob.set_window_enabled(pid, hwnd, enabled))
}
