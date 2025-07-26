use crate::error::{Error, Result};
use crate::state::{SessionStateUI, SessionStatusUI};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};
use joybug2::protocol::request_response::StepKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepCommand {
    Go,
    StepIn,
    Stop,
}

/// Updates session state (modules and threads) based on debug events
fn update_session_from_event(state: &mut SessionStateUI, event: &joybug2::protocol_io::DebugEvent) {
    match event {
        joybug2::protocol_io::DebugEvent::DllLoaded { dll_name, base_of_dll, size_of_dll, .. } => {
            let module_name = dll_name.clone().unwrap_or_else(|| format!("Unknown_0x{:X}", base_of_dll));
            let module = joybug2::protocol_io::ModuleInfo {
                name: module_name.clone(),
                base: *base_of_dll,
                size: *size_of_dll,
            };
            // Check if module already exists to avoid duplicates
            if !state.modules.iter().any(|m| m.base == *base_of_dll) {
                state.modules.push(module);
                info!("Added module: {} at 0x{:X}", module_name, base_of_dll);
            }
        }
        joybug2::protocol_io::DebugEvent::ThreadCreated { tid, start_address, .. } => {
            let thread = joybug2::protocol_io::ThreadInfo {
                tid: *tid,
                start_address: *start_address,
            };
            // Check if thread already exists to avoid duplicates
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added thread: {} at 0x{:X}", tid, start_address);
            }
        }
        joybug2::protocol_io::DebugEvent::ProcessCreated { pid, tid, image_file_name, base_of_image, size_of_image, .. } => {
            // Add the main executable as a module
            let module_name = image_file_name.clone().unwrap_or_else(|| "main.exe".to_string());
            let module = joybug2::protocol_io::ModuleInfo {
                name: module_name.clone(),
                base: *base_of_image,
                size: *size_of_image,
            };
            if !state.modules.iter().any(|m| m.base == *base_of_image) {
                state.modules.push(module);
                info!("Added main executable module: {} at 0x{:X}", module_name, base_of_image);
            }
            
            // Add the initial thread for the process
            let thread = joybug2::protocol_io::ThreadInfo {
                tid: *tid,
                start_address: *base_of_image, // Use the base address of the main executable as the start address
            };
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added initial thread: {} for process {} at 0x{:X}", tid, pid, base_of_image);
            }
        }
        joybug2::protocol_io::DebugEvent::ThreadExited { tid, .. } => {
            // Remove thread when it exits
            state.threads.retain(|t| t.tid != *tid);
            info!("Removed thread: {}", tid);
        }
        joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } => {
            // Remove module when DLL is unloaded
            state.modules.retain(|m| m.base != *base_of_dll);
            info!("Removed module at 0x{:X}", base_of_dll);
        }
        joybug2::protocol_io::DebugEvent::ProcessExited { .. } => {
            // Process has exited, clear all modules and threads
            state.modules.clear();
            state.threads.clear();
            info!("Process exited, cleared all modules and threads.");
        }
        _ => {
            // Other events don't affect modules/threads
        }
    }
}

pub fn run_debug_session(
    session_state: Arc<Mutex<SessionStateUI>>,
    app_handle: Option<AppHandle>,
) -> Result<()> {
    let (session_id, server_url, launch_command) = {
        let state = session_state.lock().unwrap();
        (state.id.clone(), state.server_url.clone(), state.launch_command.clone())
    };

    info!("Starting debug session: {}", session_id);

    // Connect to debug server
    let mut client = joybug2::protocol_io::DebugSession::new((), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;

    // Connect auxiliary client
    let aux_client = joybug2::protocol_io::DebugSession::new((), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;

    info!("Successfully connected to debug server");

    // Mark as successfully connected and store aux_client
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatusUI::Connected;
        state.aux_client = Some(Arc::new(Mutex::new(aux_client)));
    }

    // Emit session update for Connected status
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    // Get step receiver from session state
    let step_receiver = {
        let mut state = session_state.lock().unwrap();
        state.step_receiver.take().unwrap()
    };

    // Launch process and manually manage the debug loop
    let launch_req = joybug2::protocol::DebuggerRequest::Launch { command: launch_command.clone() };
    if let Err(e) = client.send(&launch_req) {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatusUI::Error(e.to_string());
        emit_session_event(&session_state, app_handle.as_ref().unwrap());
        return Err(Error::DebugLoop(e.to_string()));
    }

    loop {
        match client.receive() {
            Ok(resp) => {
                let should_break = handle_debugger_response(
                    resp,
                    &session_state,
                    &step_receiver,
                    app_handle.as_ref(),
                    &mut client,
                );
                if should_break {
                    break;
                }
            }
            Err(e) => {
                error!("Failed to receive from debug server: {}", e);
                let mut state = session_state.lock().unwrap();
                state.status = SessionStatusUI::Error(e.to_string());
                if let Some(handle) = app_handle.as_ref() {
                    emit_session_event(&session_state, handle);
                }
                break;
            }
        }
    }


    // Mark session as finished
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatusUI::Finished;
        state.current_event = None;
    }

    // Emit final session update
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    info!("Debug session {} finished", session_id);
    Ok(())
}

fn handle_debugger_response(
    resp: joybug2::protocol::DebuggerResponse,
    session_state: &Arc<Mutex<SessionStateUI>>,
    step_receiver: &std::sync::mpsc::Receiver<StepCommand>,
    app_handle: Option<&AppHandle>,
    client: &mut joybug2::protocol_io::DebugSession<()>,
) -> bool {
    use joybug2::protocol::{DebuggerRequest, DebuggerResponse};

    match resp {
        DebuggerResponse::Event { event } => {
            info!("Debug event: {}", event);

            if let Some(handle) = app_handle {
                crate::ui_logger::log_debug(
                    handle,
                    &format!("Received debug event: {}", event),
                    Some(session_state.lock().unwrap().id.clone()),
                );
            }

            let aux_client_arc = {
                let mut state = session_state.lock().unwrap();
                state.current_event = Some(event.clone());
                state.events.push(event.clone());
                state.status = SessionStatusUI::Paused;
                state.current_context = None;
                update_session_from_event(&mut state, &event);
                state.aux_client.clone()
            };

            if let Some(aux_client_mutex) = aux_client_arc {
                let pid = event.pid();
                let tid = event.tid();

                if pid != 0 && tid != 0 {
                    let req = DebuggerRequest::GetThreadContext { pid, tid };
                    if let Ok(mut aux_client) = aux_client_mutex.lock() {
                        match aux_client.send_and_receive(&req) {
                            Ok(DebuggerResponse::ThreadContext { context: raw_context }) => {
                                let mut state = session_state.lock().unwrap();
                                state.current_context = Some(crate::events::convert_raw_context_to_serializable(raw_context));
                            }
                            Ok(other_resp) => warn!("Expected ThreadContext response, got {:?}", other_resp),
                            Err(e) => error!("Failed to get thread context: {}", e),
                        }
                    }
                }
            }

            if let Some(handle) = app_handle {
                emit_session_event(session_state, handle);
            }

            info!("Debug event received, waiting for user command");

            match step_receiver.recv() {
                Ok(command) => {
                    info!("Received step command: {:?}", command);
                    let pid = event.pid();
                    let tid = event.tid();

                    let maybe_req = match command {
                        StepCommand::Go => Some(DebuggerRequest::Continue { pid, tid }),
                        StepCommand::StepIn => Some(DebuggerRequest::Step { pid, tid, kind: StepKind::Into }),
                        StepCommand::Stop => None,
                    };

                    if let Some(req) = maybe_req {
                        if pid != 0 && tid != 0 {
                             {
                                let mut state = session_state.lock().unwrap();
                                state.status = SessionStatusUI::Running;
                            }
                            if let Some(handle) = app_handle {
                                emit_session_event(session_state, handle);
                            }
                            if let Err(e) = client.send(&req) {
                                error!("Failed to send command to debug server: {}", e);
                                return true; // break loop
                            }
                        }
                    } else {
                        // Stop command
                        return true; // break loop
                    }
                }
                Err(_) => {
                    warn!("Debug session receiver disconnected");
                    return true; // break loop
                }
            }
        }
        DebuggerResponse::Error { message } => {
            error!("Debug server error: {}", message);
            let mut state = session_state.lock().unwrap();
            state.status = SessionStatusUI::Error(message.clone());
            if let Some(handle) = app_handle {
                emit_session_event(session_state, handle);
            }
            return true; // break loop on error
        }
        _ => {
            // Handle other responses if needed, but don't break loop
        }
    }
    false // continue loop
}


// Helper function to emit session-updated events
fn emit_session_event(
    session_state: &Arc<Mutex<SessionStateUI>>,
    app_handle: &AppHandle,
) {
    // Create a DebugSession snapshot from SessionState
    let debug_session = {
        let state = session_state.lock().unwrap();
        state.to_debug_session()
    };
    
    if let Err(e) = app_handle.emit("session-updated", &debug_session) {
        error!("Failed to emit session-updated event for {}: {}", debug_session.id, e);
    }
} 