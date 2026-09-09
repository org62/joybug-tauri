use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{find_module_for_address, get_modules_snapshot};
use super::types::{CallStackData, DebugSession};

/// Converts raw stack frames into the serializable CallStackData format.
/// Addresses render at the target's pointer width (8 hex digits for WOW64).
pub(crate) fn convert_frames_to_callstack(
    frames: &[joybug_core::interfaces::CallFrame],
    modules: &[joybug_core::protocol_io::ModuleInfo],
    pointer_size: usize,
) -> Vec<CallStackData> {
    let w = pointer_size * 2;
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
            instruction_pointer: format!("0x{:0w$x}", frame.instruction_pointer, w = w),
            stack_pointer: format!("0x{:0w$x}", frame.stack_pointer, w = w),
            frame_pointer: format!("0x{:0w$x}", frame.frame_pointer, w = w),
            symbol_info,
        }
    }).collect()
}

/// The callstack of `tid`, walked at most once per pause. The first caller on
/// a pause (the exception capture, the Stack panel or a Threads-panel hover)
/// pays for the `GetCallStack` round-trip and fills `callstack_cache`; later
/// callers for the same thread reuse it. The cache is dropped on every new
/// debug event, on process exit, and after any command that mutates the target
/// while paused (register/memory writes, patches) — see `dispatch.rs`.
pub(crate) fn cached_or_walk_call_stack(
    session: &mut DebugSession,
    pid: u32,
    tid: u32,
) -> std::result::Result<Vec<CallStackData>, String> {
    let (cached, pointer_size) = {
        let state = session.state.lock().unwrap();
        (state.callstack_cache.get(&(pid, tid)).cloned(), state.target_arch().pointer_size())
    };
    if let Some(frames) = cached {
        debug!("📥 Serving {} cached frames for pid={}, tid={}", frames.len(), pid, tid);
        return Ok(frames);
    }

    let modules = get_modules_snapshot(session);
    let frames = session.get_call_stack(pid, tid).map_err(|e| e.to_string())?;
    debug!("📥 Received {} frames from get_call_stack", frames.len());
    let call_stack = convert_frames_to_callstack(&frames, &modules, pointer_size);
    session.state.lock().unwrap().callstack_cache.insert((pid, tid), call_stack.clone());
    Ok(call_stack)
}

/// Drop the per-pause callstack cache. Called whenever the stack may have
/// changed: a new debug event, process exit, or a paused-state mutation.
pub(crate) fn invalidate_callstack_cache(session: &DebugSession) {
    session.state.lock().unwrap().callstack_cache.clear();
}

/// Processes a callstack request and emits results to the frontend
pub(crate) fn process_callstack_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let tid = session.state.lock().unwrap().active_tid(event);
    debug!("📤 Processing callstack request: pid={}, tid={}", pid, tid);

    match cached_or_walk_call_stack(session, pid, tid) {
        Ok(call_stack) => {
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
    preview: bool,
) {
    debug!("📤 Processing thread callstack request: pid={}, tid={}", pid, tid);

    match cached_or_walk_call_stack(session, pid, tid) {
        Ok(call_stack) => {
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct ThreadCallStackResult<'a> {
                    session_id: String,
                    tid: u32,
                    preview: bool,
                    frames: &'a Vec<CallStackData>,
                }

                let result = ThreadCallStackResult {
                    session_id,
                    tid,
                    preview,
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
