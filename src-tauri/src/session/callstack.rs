use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{find_module_for_address, get_modules_snapshot};
use super::types::{CallStackData, DebugSession};

/// Converts raw stack frames into the serializable CallStackData format
pub(crate) fn convert_frames_to_callstack(frames: &[joybug2::interfaces::CallFrame], modules: &[joybug2::protocol_io::ModuleInfo]) -> Vec<CallStackData> {
    frames.iter().enumerate().map(|(i, frame)| {
        let symbol_info = if let Some(ref sym) = frame.symbol {
            Some(format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset))
        } else if let Some((mod_name, offset)) = find_module_for_address(modules, frame.instruction_pointer) {
            Some(format!("{}+0x{:x}", mod_name, offset))
        } else {
            None
        };
        CallStackData {
            frame_number: i,
            instruction_pointer: format!("0x{:016x}", frame.instruction_pointer),
            stack_pointer: format!("0x{:016x}", frame.stack_pointer),
            frame_pointer: format!("0x{:016x}", frame.frame_pointer),
            symbol_info,
        }
    }).collect()
}

/// Processes a callstack request and emits results to the frontend
pub(crate) fn process_callstack_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let tid = event.tid();
    debug!("📤 Processing callstack request: pid={}, tid={}", pid, tid);

    let modules = get_modules_snapshot(session);
    match session.get_call_stack(pid, tid) {
        Ok(frames) => {
            debug!("📥 Received {} frames from get_call_stack", frames.len());

            let call_stack = convert_frames_to_callstack(&frames, &modules);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct CallStackResult<'a> {
                    session_id: String,
                    frames: &'a Vec<CallStackData>,
                }

                let result = CallStackResult {
                    session_id,
                    frames: &call_stack,
                };

                if let Err(e) = handle.emit("callstack-updated", &result) {
                    error!("Failed to emit callstack-updated event: {}", e);
                } else {
                    debug!("📡 Emitted callstack-updated event for pid {}, tid {}", pid, tid);
                }
            }
        }
        Err(e) => {
            error!("Failed to get call stack: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct CallStackError {
                    session_id: String,
                    error: String,
                }

                let error_result = CallStackError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("callstack-error", &error_result) {
                    error!("Failed to emit callstack-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a callstack request for a specific thread and emits results to the frontend
pub(crate) fn process_thread_callstack_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    tid: u32,
) {
    debug!("📤 Processing thread callstack request: pid={}, tid={}", pid, tid);

    let modules = get_modules_snapshot(session);
    match session.get_call_stack(pid, tid) {
        Ok(frames) => {
            debug!("📥 Received {} frames from get_call_stack for tid={}", frames.len(), tid);

            let call_stack = convert_frames_to_callstack(&frames, &modules);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct ThreadCallStackResult<'a> {
                    session_id: String,
                    tid: u32,
                    frames: &'a Vec<CallStackData>,
                }

                let result = ThreadCallStackResult {
                    session_id,
                    tid,
                    frames: &call_stack,
                };

                if let Err(e) = handle.emit("thread-callstack-updated", &result) {
                    error!("Failed to emit thread-callstack-updated event: {}", e);
                } else {
                    debug!("📡 Emitted thread-callstack-updated event for pid {}, tid {}", pid, tid);
                }
            }
        }
        Err(e) => {
            error!("Failed to get thread call stack for tid {}: {}", tid, e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct ThreadCallStackError {
                    session_id: String,
                    tid: u32,
                    error: String,
                }

                let error_result = ThreadCallStackError {
                    session_id,
                    tid,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("thread-callstack-error", &error_result) {
                    error!("Failed to emit thread-callstack-error event: {}", emit_err);
                }
            }
        }
    }
}
