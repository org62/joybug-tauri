use crate::error::{Error, Result};
use crate::state::{SessionState, SessionStatus};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

/// Updates session state (modules and threads) based on debug events
fn update_session_from_event(state: &mut SessionState, event: &joybug2::protocol_io::DebugEvent) {
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
        joybug2::protocol_io::DebugEvent::ProcessCreated { image_file_name, base_of_image, size_of_image, .. } => {
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
        _ => {
            // Other events don't affect modules/threads
        }
    }
}

pub fn run_debug_session(
    session_state: Arc<Mutex<SessionState>>,
    app_handle: Option<AppHandle>,
) -> Result<()> {
    let (session_id, server_url, launch_command) = {
        let state = session_state.lock().unwrap();
        (state.id.clone(), state.server_url.clone(), state.launch_command.clone())
    };

    info!("Starting debug session: {}", session_id);

    // Connect to debug server
    let mut client = joybug2::protocol_io::DebugClient::connect(Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;

    info!("Successfully connected to debug server");

    // Mark as successfully connected (so UI can update status)
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatus::Connected;
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

    // Launch process with debug loop
    client
        .launch(
            launch_command.clone(),
            &mut (),
            |_client, _state, resp| {
                use joybug2::protocol_io::DebuggerResponse;

                match resp {
                    DebuggerResponse::Event { event } => {
                        info!("Debug event: {}", event);

                        if let Some(ref handle) = app_handle {
                            crate::ui_logger::log_debug(
                                handle,
                                &format!("Received debug event: {}", event),
                                Some(session_id.clone()),
                            );
                        }

                        // Store current event in session state and populate modules/threads
                        {
                            let mut state = session_state.lock().unwrap();
                            state.current_event = Some(event.clone());
                            state.events.push(event.clone());
                            state.status = SessionStatus::Paused; // Always pause on every event

                            // Populate modules and threads from events
                            update_session_from_event(&mut state, &event);
                        }

                        // Emit session update for new debug event
                        if let Some(ref handle) = app_handle {
                            emit_session_event(&session_state, handle);
                        }

                        info!("Debug event received, waiting for user command");

                        // Wait for user input to continue or stop
                        match step_receiver.recv() {
                            Ok(should_continue) => {
                                info!("Received step signal: {}", should_continue);

                                if should_continue {
                                    // User chose to continue - update status to Running
                                    {
                                        let mut state = session_state.lock().unwrap();
                                        state.status = SessionStatus::Running;
                                        state.current_event = None;
                                    }
                                    
                                    // Emit session update for Running status
                                    if let Some(ref handle) = app_handle {
                                        emit_session_event(&session_state, handle);
                                    }
                                } else {
                                    // User chose to stop - update status to Finished
                                    {
                                        let mut state = session_state.lock().unwrap();
                                        state.status = SessionStatus::Finished;
                                        state.current_event = None;
                                    }
                                    
                                    // Emit final session update
                                    if let Some(ref handle) = app_handle {
                                        emit_session_event(&session_state, handle);
                                    }
                                }

                                should_continue
                            }
                            Err(_) => {
                                warn!("Debug session {} receiver disconnected", session_id);
                                // Update session status to finished when disconnected
                                {
                                    let mut state = session_state.lock().unwrap();
                                    state.status = SessionStatus::Finished;
                                }
                                
                                // Emit final session update
                                if let Some(ref handle) = app_handle {
                                    emit_session_event(&session_state, handle);
                                }
                                
                                false // Stop debug loop
                            }
                        }
                    }
                    DebuggerResponse::Ack => {
                        info!("Received ACK");
                        true
                    }
                    DebuggerResponse::Error { message } => {
                        error!("Debug server error: {}", message);
                        // Update session status to error
                        {
                            let mut state = session_state.lock().unwrap();
                            state.status = SessionStatus::Error(message.clone());
                        }
                        
                        // Emit session update for error
                        if let Some(ref handle) = app_handle {
                            emit_session_event(&session_state, handle);
                        }
                        
                        false // Stop debug loop on error
                    }
                    DebuggerResponse::ProcessList { processes } => {
                        info!("Process list: {:?}", processes);
                        true
                    }
                    DebuggerResponse::ModuleList { modules } => {
                        {
                            let mut state = session_state.lock().unwrap();
                            state.modules.extend(modules);
                        }
                        true
                    }
                    DebuggerResponse::ThreadList { threads } => {
                        {
                            let mut state = session_state.lock().unwrap();
                            state.threads.extend(threads);
                        }
                        true
                    }
                    DebuggerResponse::MemoryData { .. } => {
                        info!("Received memory data");
                        true
                    }
                    DebuggerResponse::WriteAck => {
                        info!("Received write acknowledgment");
                        true
                    }
                    DebuggerResponse::ThreadContext { .. } => {
                        info!("Received thread context");
                        true
                    }
                    DebuggerResponse::SetContextAck => {
                        info!("Received set context acknowledgment");
                        true
                    }
                    DebuggerResponse::Symbol { .. } => {
                        info!("Received symbol");
                        true
                    }
                    DebuggerResponse::SymbolList { .. } => {
                        info!("Received symbol list");
                        true
                    }
                    DebuggerResponse::AddressSymbol { .. } => {
                        info!("Received address symbol");
                        true
                    }
                    DebuggerResponse::Instructions { .. } => {
                        info!("Received instructions");
                        true
                    }
                }
            },
        )
        .map_err(|e| Error::DebugLoop(e.to_string()))?;

    // Mark session as finished
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatus::Finished;
        state.current_event = None;
    }

    // Emit final session update
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    info!("Debug session {} finished", session_id);
    Ok(())
}

// Helper function to emit session-updated events
fn emit_session_event(
    session_state: &Arc<Mutex<SessionState>>,
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