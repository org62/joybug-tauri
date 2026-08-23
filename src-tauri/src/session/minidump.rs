//! `UICommand::WriteMinidump` — write a dbghelp minidump of the paused target.
//!
//! The dump is produced by the joybug-core server (`MiniDumpWriteDump`), so
//! `path` is interpreted on the server's machine; for local sessions that is
//! this machine. The outcome goes to the session log and to a `minidump-result`
//! event that the frontend toasts directly — not through `toast_info`, whose
//! burst dispatcher can collapse a user-initiated result into a "N× ..."
//! summary right after a pause (DLL-load toasts share its global window).

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use joybug_core::protocol::MinidumpKind;

use super::helpers::format_bytes;
use super::types::DebugSession;

/// Pre-formatted outcome: the frontend toasts `message` as-is, so the toast and
/// the session-log line can never disagree about the same dump.
#[derive(Serialize, Clone)]
pub struct MinidumpResult {
    pub message: String,
    pub error: bool,
}

pub(super) fn process_write_minidump(
    session: &mut DebugSession,
    app_handle: &Option<AppHandle>,
    pid: u32,
    path: String,
    kind: MinidumpKind,
) {
    let session_id = session.state.lock().unwrap().id.clone();
    let label = match kind {
        MinidumpKind::Full => "full memory dump",
        MinidumpKind::Mini => "minidump",
    };
    info!(pid, path, ?kind, "WriteMinidump command received");
    if let Some(handle) = app_handle {
        crate::ui_logger::log_info(handle, &format!("Writing {} to {}…", label, path), Some(session_id.clone()));
    }

    let result = match session.write_minidump(pid, &path, kind) {
        Ok(size) => {
            let message = format!("Minidump written: {} ({})", path, format_bytes(size));
            info!("{}", message);
            MinidumpResult { message, error: false }
        }
        Err(e) => {
            let message = format!("Minidump failed: {}", e);
            warn!("{}", message);
            MinidumpResult { message, error: true }
        }
    };

    if let Some(handle) = app_handle {
        if result.error {
            crate::ui_logger::log_error(handle, &result.message, Some(session_id));
        } else {
            crate::ui_logger::log_info(handle, &result.message, Some(session_id));
        }
        let _ = handle.emit("minidump-result", result);
    }
}
