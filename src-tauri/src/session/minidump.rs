//! `UICommand::WriteMinidump` — write a dump of the paused target: a dbghelp
//! minidump on Windows, an ELF core file on Linux.
//!
//! The dump is produced by the joybug-core server (`MiniDumpWriteDump`, or
//! its own core writer in `linux_platform/coredump.rs`), so
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
    // What the file is called where it is written: the server is this
    // machine for every session that can reach this command.
    let (noun, full, mini) = if cfg!(windows) {
        ("Minidump", "full memory dump", "minidump")
    } else {
        ("Core dump", "full core dump", "core dump")
    };
    let label = match kind {
        MinidumpKind::Full => full,
        MinidumpKind::Mini => mini,
    };
    info!(pid, path, ?kind, "WriteMinidump command received");
    if let Some(handle) = app_handle {
        crate::ui_logger::log_info(handle, &format!("Writing {} to {}…", label, path), Some(session_id.clone()));
    }

    let result = match session.write_minidump(pid, &path, kind) {
        Ok(size) => {
            let message = format!("{} written: {} ({})", noun, path, format_bytes(size));
            info!("{}", message);
            MinidumpResult { message, error: false }
        }
        Err(e) => {
            let message = format!("{} failed: {}", noun, e);
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
