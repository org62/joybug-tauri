use crate::error::{Error, Result};
use crate::session::run_debug_session;
use crate::state::{
    DebugSessionUI, LogEntry, LogsState, SessionStateUI, SessionStatesMap, SessionStatusUI,
};
use crate::session::UICommand;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{State, Emitter};
use tracing::{debug, error, info};

// Helper function to emit session-updated event
fn emit_session_update(
    session_state: &Arc<Mutex<SessionStateUI>>,
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
    let session_state_arc = Arc::new(Mutex::new(SessionStateUI::new(
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

        // only allow editing for stopped sessions
        if !matches!(state.status, SessionStatusUI::Stopped) {
            return Err("Session can only be edited when in 'Stopped' state.".to_string());
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
) -> Result<Vec<DebugSessionUI>> {
    let states = session_states.lock().unwrap();
    
    let sessions: Vec<DebugSessionUI> = states
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
) -> Result<Option<DebugSessionUI>> {
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
        // Prevent double-start if already active (ui_receiver taken by running session)
        if state.ui_receiver.is_none() {
            return Err(Error::InvalidSessionState("Session is already running".to_string()));
        }
        if matches!(state.status, SessionStatusUI::Stopped | SessionStatusUI::Error(_)) {
            state.reset();
        }
    }

    // Do not emit here; UI will update on real events from the session thread

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
                    if !matches!(state.status, SessionStatusUI::Stopped) {
                        state.status = SessionStatusUI::Stopped;
                    }
                    info!("Debug session {} completed successfully", session_id_for_thread);
                }
                Err(e) => {
                    state.status = SessionStatusUI::Error(e.to_string());
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
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step".to_string()
            ));
        }
        
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    // Send step signal - let session thread handle status updates
    step_sender
        .send(UICommand::Go)
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
        
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step in".to_string()
            ));
        }
        
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    step_sender
        .send(UICommand::StepIn)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step in signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn step_over_debug_session(
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
        
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step over".to_string()
            ));
        }
        
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    step_sender
        .send(UICommand::StepOver)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step over signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn step_out_debug_session(
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
        
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to step out".to_string()
            ));
        }
        
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    step_sender
        .send(UICommand::StepOut)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step out signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn stop_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states.get(&session_id).cloned()
    };

    if let Some(session_state) = session_state {
        {
            let mut state = session_state.lock().unwrap();
            if let Some(sender) = state.ui_sender.take() {
                // Dropping sender will cause recv() to fail in the debug loop, stopping it
                info!("Stopping session by dropping the step_sender.");
                // Send stop command to ensure immediate exit if loop is waiting
                let _ = sender.send(UICommand::Stop);
            }
            // No special handling for a transient connecting state
        }

        // Emit update so frontend reflects stop request immediately
        emit_session_update(&session_state, &app_handle);
    }
    // Always return Ok, as the goal is to stop the session, and if it's not found, it's already "stopped"
    Ok(())
}

#[tauri::command]
pub fn delete_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // Attempt to stop the session first. We ignore the result because even if stopping fails,
    // we want to proceed with deletion.
    let _ = stop_debug_session(session_id.clone(), session_states.clone(), app_handle.clone());

    // Remove the session from the state map.
    if session_states.lock().unwrap().remove(&session_id).is_some() {
        info!("Successfully deleted session: {}", session_id);
        // Inform frontend that a session was removed
        if let Err(e) = app_handle.emit("session-removed", &session_id) {
            error!("Failed to emit session-removed event: {}", e);
        }
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
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };
    debug!("Disassembly request received for session {} at address 0x{:X}", session_id, address);

    // Determine architecture from current thread context or fallback to compile-time detection
    let arch = {
        let state = session_state.lock().unwrap();
        
        // Verify session can be disassembled
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                format!("Session must be paused to get disassembly, but is: {:?}", state.status),
            ));
        }
        
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

    // Send disassembly command via UI channel
    let ui_sender = {
        let state = session_state.lock().unwrap();
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session UI sender not available".to_string()))?
            .clone()
    };

    // Send disassembly command - results will be emitted via event
    ui_sender
        .send(UICommand::Disassembly { 
            arch, 
            address, 
            count: count as u32 
        })
        .map_err(|e| Error::InternalCommunication(format!("Failed to send disassembly command: {}", e)))?;

    info!("Disassembly request sent for session {} at address 0x{:X}", session_id, address);
    Ok(())
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
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    debug!("Searching for symbols in session {} with pattern '{}'", session_id, pattern);

    let ui_sender = {
        let state = session_state.lock().unwrap();
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session UI sender not available".to_string()))?
            .clone()
    };

    // Send symbol search command - results will be emitted via event
    ui_sender
        .send(UICommand::SearchSymbols { 
            pattern: pattern.clone(),
            limit: limit.unwrap_or(30) as u32
        })
        .map_err(|e| Error::InternalCommunication(format!("Failed to send symbol search command: {}", e)))?;

    info!("Symbol search request sent for session {} with pattern '{}'", session_id, pattern);
    Ok(Vec::new()) // Return empty vector as results will come via events
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

#[derive(serde::Serialize, Clone, Debug)]
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
pub fn request_session_callstack(
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

    let ui_sender = {
        let state = session_state.lock().unwrap();

        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused to get call stack".to_string(),
            ));
        }

        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session UI sender not available".to_string()))?
            .clone()
    };

    ui_sender
        .send(UICommand::GetCallStack)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send GetCallStack command: {}", e)))?;

    info!("Request for call stack sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn update_window_state(
    session_id: String,
    window_type: String,
    is_open: bool,
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

    {
        let mut state = session_state.lock().unwrap();
        match window_type.as_str() {
            "disassembly" => state.is_disassembly_window_open = is_open,
            "registers" => state.is_registers_window_open = is_open,
            "callstack" => state.is_callstack_window_open = is_open,
            _ => return Err(Error::InvalidSessionState(format!(
                "Unknown window type: {}",
                window_type
            ))),
        }
    }

    // Emit session update to notify frontend
    emit_session_update(&session_state, &app_handle);
    
    debug!("Updated window state for session {}: {} = {}", session_id, window_type, is_open);
    Ok(())
} 