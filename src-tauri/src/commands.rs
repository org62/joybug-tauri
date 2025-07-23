use crate::error::{Error, Result};
use crate::session::run_debug_session;
use crate::state::{
    DebugSession, LogEntry, LogsState, SessionState, SessionStatesMap, SessionStatus,
};
use crate::session::StepCommand;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{State, Emitter};
use tracing::{error, info};

// Helper function to emit session-updated event
fn emit_session_update(
    session_state: &Arc<Mutex<SessionState>>,
    app_handle: &tauri::AppHandle,
) {
    let debug_session = {
        let state = session_state.lock().unwrap();
        state.to_debug_session()
    };
    
    if let Err(e) = app_handle.emit("session-updated", &debug_session) {
        error!("Failed to emit session-updated event: {}", e);
    }
}



// Tauri commands
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub fn create_debug_session(
    name: String,
    server_url: String,
    launch_command: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<String, String> {
    let mut states = session_states.lock().unwrap();

    // Check for duplicate session
    for session_state in states.values() {
        let state = session_state.lock().unwrap();
        if state.server_url == server_url && state.launch_command == launch_command {
            return Err(Error::SessionAlreadyExists.to_string());
        }
    }

    let session_id = format!("session_{}", chrono::Utc::now().timestamp_millis());

    // Create new session state
    let session_state_arc = Arc::new(Mutex::new(SessionState::new(
        session_id.clone(),
        name,
        server_url,
        launch_command,
    )));

    // Store session state
    states.insert(session_id.clone(), session_state_arc.clone());
    
    // an explicit drop to show when we are releasing the lock on states
    drop(states);

    // Log session creation
    crate::ui_logger::log_info(
        &app_handle,
        &format!("Debug session created: {}", session_id),
        Some(session_id.clone()),
    );

    // Emit session-updated event for the new session
    emit_session_update(&session_state_arc, &app_handle);

    info!("Created debug session: {}", session_id);
    Ok(session_id)
}

#[tauri::command]
pub fn update_debug_session(
    session_id: String,
    name: String,
    server_url: String,
    launch_command: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<(), String> {
    let states = session_states.lock().unwrap();

    // Check for duplicate session (excluding the current one)
    for (id, session_state) in states.iter() {
        if id != &session_id {
            let state = session_state.lock().unwrap();
            if state.server_url == server_url && state.launch_command == launch_command {
                return Err(Error::SessionAlreadyExists.to_string());
            }
        }
    }

    if let Some(session_state) = states.get(&session_id) {
        let mut state = session_state.lock().unwrap();

        // only allow editing for created or finished sessions
        if !matches!(state.status, SessionStatus::Created | SessionStatus::Finished) {
            return Err("Session can only be edited when in 'Created' or 'Finished' state.".to_string());
        }

        state.name = name;
        state.server_url = server_url;
        state.launch_command = launch_command;

        let session_state_arc = session_state.clone();

        drop(state);
        drop(states);

        // Log session update
        crate::ui_logger::log_info(
            &app_handle,
            &format!("Debug session updated: {}", session_id),
            Some(session_id.clone()),
        );

        emit_session_update(&session_state_arc, &app_handle);

        info!("Updated debug session: {}", session_id);
        Ok(())
    } else {
        Err(Error::SessionNotFound(session_id).to_string())
    }
}

#[tauri::command]
pub fn get_debug_sessions(
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<DebugSession>> {
    let states = session_states.lock().unwrap();
    
    let sessions: Vec<DebugSession> = states
        .values()
        .map(|session_state| {
            let state = session_state.lock().unwrap();
            state.to_debug_session()
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
pub fn get_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Option<DebugSession>> {
    let states = session_states.lock().unwrap();
    
    if let Some(session_state) = states.get(&session_id) {
        let state = session_state.lock().unwrap();
        Ok(Some(state.to_debug_session()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn start_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    // Reset state if session is being restarted
    {
        let mut state = session_state.lock().unwrap();
        if matches!(state.status, SessionStatus::Finished | SessionStatus::Error(_)) {
            state.reset();
        }
    }

    // Update status to Connecting
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatus::Connecting;
    }

    // Emit session-updated event for the status change to Connecting
    emit_session_update(&session_state, &app_handle);

    // Log session start
    crate::ui_logger::log_info(
        &app_handle,
        &format!("Starting debug session: {}", session_id),
        Some(session_id.clone()),
    );

    // Start debug session in background thread
    let session_state_for_thread = session_state.clone();
    let app_handle_for_thread = app_handle.clone();
    let session_id_for_thread = session_id.clone();
    
    thread::spawn(move || {
        let result = run_debug_session(session_state_for_thread.clone(), Some(app_handle_for_thread.clone()));

        // Update final status based on result
        {
            let mut state = session_state_for_thread.lock().unwrap();
            match &result {
                Ok(_) => {
                    if !matches!(state.status, SessionStatus::Finished) {
                        state.status = SessionStatus::Finished;
                    }
                    info!("Debug session {} completed successfully", session_id_for_thread);
                }
                Err(e) => {
                    state.status = SessionStatus::Error(e.to_string());
                    let error_message = format!("Debug session {} failed: {}", session_id_for_thread, e);
                    error!("{}", &error_message);
                    crate::ui_logger::log_error(
                        &app_handle_for_thread,
                        &error_message,
                        Some(session_id_for_thread.clone()),
                    );
                }
            }
            state.debug_result = Some(result.map_err(|e| e.to_string()));
        }

        // Emit final session-updated event to notify the frontend
        emit_session_update(&session_state_for_thread, &app_handle_for_thread);
    });

    Ok(())
}

#[tauri::command]
pub fn step_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    let step_sender = {
        let state = session_state.lock().unwrap();
        
        // Verify session can be stepped
        if !matches!(state.status, SessionStatus::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step".to_string()
            ));
        }
        
        state
            .step_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    // Send step signal - let session thread handle status updates
    step_sender
        .send(StepCommand::Go)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn step_in_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    let step_sender = {
        let state = session_state.lock().unwrap();
        
        if !matches!(state.status, SessionStatus::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step in".to_string()
            ));
        }
        
        state
            .step_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    step_sender
        .send(StepCommand::StepIn)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step in signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn stop_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    if let Some(session_state) = session_states.lock().unwrap().get(&session_id) {
        let mut state = session_state.lock().unwrap();
        if let Some(sender) = state.step_sender.take() {
            // Dropping sender will cause recv() to fail in the debug loop, stopping it
            info!("Stopping session by dropping the step_sender.");
            // Send stop command to ensure immediate exit if loop is waiting
            let _ = sender.send(StepCommand::Stop);
        }
        // Also handle the case where a session is connecting but not yet in the debug loop
        if matches!(state.status, SessionStatus::Connecting) {
            state.status = SessionStatus::Finished;
        }
    }
    // Always return Ok, as the goal is to stop the session, and if it's not found, it's already "stopped"
    Ok(())
}

#[tauri::command]
pub fn delete_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    // Attempt to stop the session first. We ignore the result because even if stopping fails,
    // we want to proceed with deletion.
    let _ = stop_debug_session(session_id.clone(), session_states.clone());

    // Remove the session from the state map.
    if session_states.lock().unwrap().remove(&session_id).is_some() {
        info!("Successfully deleted session: {}", session_id);
        Ok(())
    } else {
        // If the session was not found, it's already gone, so we can consider this a success.
        info!("Attempted to delete a session that was not found: {}", session_id);
        Ok(())
    }
}

#[tauri::command]
pub fn get_logs(logs_state: State<'_, LogsState>) -> Result<Vec<LogEntry>> {
    let logs = logs_state.lock().unwrap();
    Ok(logs.clone())
}

#[tauri::command]
pub fn clear_logs(logs_state: State<'_, LogsState>) -> Result<()> {
    let mut logs = logs_state.lock().unwrap();
    logs.clear();
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SerializableInstruction {
    pub address: String,
    pub symbol: String,
    pub bytes: String,
    pub mnemonic: String,
    pub op_str: String,
}

#[tauri::command]
pub fn get_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<SerializableInstruction>> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    let (aux_client, pid) = {
        let state = session_state.lock().unwrap();

        let pid = match state.status {
            SessionStatus::Paused => {
                if let Some(event) = &state.current_event {
                    event.pid()
                } else {
                    return Err(Error::InvalidSessionState(
                        "Session is paused but has no current event".to_string(),
                    ));
                }
            }
            _ => {
                return Err(Error::InvalidSessionState(
                    "Session must be paused to get disassembly".to_string(),
                ));
            }
        };

        let client = state
            .aux_client
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::InternalCommunication("Auxiliary client not available".to_string()))?;

        (client, pid)
    };

    // Determine architecture from current thread context or fallback to compile-time detection
    let arch = {
        let state = session_state.lock().unwrap();
        match &state.current_context {
            Some(crate::state::SerializableThreadContext::X64(_)) => joybug2::interfaces::Architecture::X64,
            Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug2::interfaces::Architecture::Arm64,
            None => {
                // Fallback to compile-time architecture detection
                #[cfg(target_arch = "x86_64")]
                { joybug2::interfaces::Architecture::X64 }
                #[cfg(target_arch = "aarch64")]
                { joybug2::interfaces::Architecture::Arm64 }
                #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
                {
                    return Err(Error::InvalidSessionState(
                        "Unsupported target architecture for disassembly".to_string(),
                    ));
                }
            }
        }
    };

    let mut client = aux_client.lock().unwrap();
    let req = joybug2::protocol::DebuggerRequest::DisassembleMemory { pid, address, count, arch };
    let resp = client.send_and_receive(&req).map_err(|e| Error::InternalCommunication(e.to_string()))?;

    if let joybug2::protocol::DebuggerResponse::Instructions { instructions } = resp {
        let serializable_instructions = instructions
            .iter()
            .map(|inst| {
                let address_str = if let Some(ref sym) = inst.symbol_info {
                    format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
                } else {
                    format!("{:#X}", inst.address)
                };

                let op_str = inst.symbolized_op_str.as_ref().unwrap_or(&inst.op_str);

                SerializableInstruction {
                    address: format!("{:#X}", inst.address),
                    symbol: address_str,
                    bytes: inst
                        .bytes
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect::<Vec<String>>()
                        .join(" "),
                    mnemonic: inst.mnemonic.clone(),
                    op_str: op_str.clone(),
                }
            })
            .collect();

        Ok(serializable_instructions)
    } else {
        Err(Error::InternalCommunication(format!(
            "Unexpected response from debug server for DisassembleMemory: {:?}",
            resp
        )))
    }
}

#[tauri::command]
pub fn get_session_modules(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ModuleData>> {
    let sessions = session_states.lock().unwrap();
    
    if let Some(session_arc) = sessions.get(&session_id) {
        let session = session_arc.lock().unwrap();
        
        let modules: Vec<ModuleData> = session.modules.iter().map(|module| {
            ModuleData {
                name: module.name.clone(),
                base_address: format!("0x{:X}", module.base),
                size: module.size.unwrap_or(0),
                path: module.name.clone(), // Use name as path for now
            }
        }).collect();
        
        info!("Retrieved {} modules for session {}", modules.len(), session_id);
        Ok(modules)
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}

#[tauri::command]
pub fn get_session_threads(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ThreadData>> {
    let sessions = session_states.lock().unwrap();
    
    if let Some(session_arc) = sessions.get(&session_id) {
        let session = session_arc.lock().unwrap();
        
        let threads: Vec<ThreadData> = session.threads.iter().map(|thread| {
            ThreadData {
                id: thread.tid,
                status: "Running".to_string(), // ThreadInfo doesn't have status, default to Running
                start_address: format!("0x{:X}", thread.start_address),
            }
        }).collect();
        
        info!("Retrieved {} threads for session {}", threads.len(), session_id);
        Ok(threads)
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}

#[tauri::command]
pub fn search_session_symbols(
    session_id: String,
    pattern: String,
    limit: Option<usize>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<SymbolData>> {
    let sessions = session_states.lock().unwrap();
    let limit = limit.unwrap_or(30);
    
    if let Some(session_arc) = sessions.get(&session_id) {
        let session = session_arc.lock().unwrap();
        
        if let Some(aux_client) = &session.aux_client {
            // Use the new FindSymbol request to search across all modules
            let mut client = aux_client.lock().unwrap();
            let req = joybug2::protocol::DebuggerRequest::FindSymbol { 
                symbol_name: pattern.clone(),
                max_results: limit,
            };
            
            match client.send_and_receive(&req) {
                Ok(joybug2::protocol::DebuggerResponse::ResolvedSymbolList { symbols: resolved_symbols }) => {
                    // Convert ResolvedSymbol to SymbolData
                    let symbols: Vec<SymbolData> = resolved_symbols.iter().map(|resolved_symbol| {
                        // Extract just the symbol name from the full "module!symbol" format
                        let symbol_name = if let Some(pos) = resolved_symbol.name.find('!') {
                            resolved_symbol.name[pos + 1..].to_string()
                        } else {
                            resolved_symbol.name.clone()
                        };
                        
                        SymbolData {
                            name: symbol_name,
                            module_name: resolved_symbol.module_name.clone(),
                            rva: resolved_symbol.rva,
                            va: format!("0x{:X}", resolved_symbol.va),
                            display_name: resolved_symbol.name.clone(), // Use the full name which is already "module!symbol"
                        }
                    }).collect();
                    
                    info!("Retrieved {} symbols matching '{}' for session {}", symbols.len(), pattern, session_id);
                    Ok(symbols)
                }
                Ok(joybug2::protocol::DebuggerResponse::Error { message }) => {
                    error!("Failed to find symbols for pattern '{}': {}", pattern, message);
                    Err(Error::InternalCommunication(format!("Symbol search failed: {}", message)))
                }
                Ok(_) => {
                    let error_msg = "Unexpected response for FindSymbol request";
                    error!("{}", error_msg);
                    Err(Error::InternalCommunication(error_msg.to_string()))
                }
                Err(e) => {
                    error!("Failed to communicate with debug client for symbol search: {}", e);
                    Err(Error::InternalCommunication(format!("Communication failed: {}", e)))
                }
            }
        } else {
            Err(Error::InternalCommunication("Auxiliary client not available".to_string()))
        }
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}



// Data structures for frontend communication
#[derive(serde::Serialize)]
pub struct ModuleData {
    pub name: String,
    pub base_address: String,
    pub size: u64,
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct ThreadData {
    pub id: u32,
    pub status: String,
    pub start_address: String,
}

#[derive(serde::Serialize)]
pub struct CallStackData {
    pub frame_number: usize,
    pub instruction_pointer: String,
    pub stack_pointer: String,
    pub frame_pointer: String,
    pub symbol_info: Option<String>,
}

#[derive(serde::Serialize)]
pub struct SymbolData {
    pub name: String,
    pub module_name: String,
    pub rva: u32,
    pub va: String, // Virtual address (base_address + rva)
    pub display_name: String, // Format: "module!symbol_name"
}

#[tauri::command]
pub fn get_session_callstack(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<CallStackData>> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    let (aux_client, pid, tid) = {
        let state = session_state.lock().unwrap();

        let (pid, tid) = match state.status {
            SessionStatus::Paused => {
                if let Some(event) = &state.current_event {
                    (event.pid(), event.tid())
                } else {
                    return Err(Error::InvalidSessionState(
                        "Session is paused but has no current event".to_string(),
                    ));
                }
            }
            _ => {
                return Err(Error::InvalidSessionState(
                    "Session must be paused to get call stack".to_string(),
                ));
            }
        };

        let client = state
            .aux_client
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::InternalCommunication("Auxiliary client not available".to_string()))?;

        (client, pid, tid)
    };

    // Send request to get call stack
    let request = joybug2::protocol::DebuggerRequest::GetCallStack { pid, tid };
    let mut client = aux_client.lock().unwrap();
    
    match client.send_and_receive(&request) {
        Ok(joybug2::protocol::DebuggerResponse::CallStack { frames }) => {
            // Convert to CallStackData for frontend
            let call_stack: Vec<CallStackData> = frames.iter().enumerate().map(|(i, frame)| {
                CallStackData {
                    frame_number: i,
                    instruction_pointer: format!("0x{:016x}", frame.instruction_pointer),
                    stack_pointer: format!("0x{:016x}", frame.stack_pointer),
                    frame_pointer: format!("0x{:016x}", frame.frame_pointer),
                    symbol_info: frame.symbol.as_ref().map(|sym| {
                        format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
                    }),
                }
            }).collect();
            
            info!("Fetched {} call stack frames for session {}", call_stack.len(), session_id);
            Ok(call_stack)
        }
        Ok(response) => {
            Err(Error::InternalCommunication(format!(
                "Expected CallStack response, got {:?}",
                response
            )))
        }
        Err(e) => Err(Error::InternalCommunication(format!(
            "Failed to fetch call stack: {}",
            e
        ))),
    }
} 