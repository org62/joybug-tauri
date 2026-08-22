use tauri::AppHandle;
use tracing::{debug, error, info};

use super::runner::emit_session_event;
use super::types::DebugSession;

/// Switches the UI context thread to `tid` (WinDbg `~Ns`): re-reads that
/// thread's context into `current_context` and records the selection so the
/// call stack and register writes target it too. Stepping is unaffected — the
/// debug loop always continues the event thread — and every new pause resets
/// the selection back to the event thread.
pub(crate) fn process_select_thread(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    tid: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing select thread request: pid={}, tid={}", pid, tid);

    let known = session.state.lock().unwrap().threads.iter().any(|t| t.tid == tid);
    if !known {
        error!("Select thread: unknown tid {}", tid);
        if let Some(ref handle) = app_handle_clone {
            crate::ui_logger::toast_error(handle, &format!("Unknown thread {}", tid));
        }
        return;
    }

    let ctx = match session.get_thread_context(pid, tid) {
        Ok(ctx) => ctx,
        Err(e) => {
            error!("Failed to get thread context for tid {}: {}", tid, e);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::toast_error(handle, &format!("Failed to switch to thread {}: {}", tid, e));
            }
            return;
        }
    };
    {
        let mut state = session.state.lock().unwrap();
        state.current_context = Some(crate::events::convert_raw_context_to_serializable(ctx));
        // Recorded even when it is the event thread: an explicit pick is a
        // selection (the Call Stack panel labels it), cleared on next pause.
        state.selected_tid = Some(tid);
    }

    // The emitted session event carries the new selection; the Call Stack panel
    // re-requests its stack off that (and only while it is actually open), so
    // walking it here as well would just duplicate the work.
    if let Some(ref handle) = app_handle_clone {
        emit_session_event(&session.state, handle);
    }
    info!("Switched context thread to {}", tid);
}
