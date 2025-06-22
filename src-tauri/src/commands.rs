use crate::error::{Error, Result};
use crate::session::run_debug_session;
use crate::state::{
    DebugSession, LogEntry, LogsState, SessionState, SessionStatesMap, SessionStatus,
};
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
) -> Result<String> {
    let session_id = format!("session_{}", chrono::Utc::now().timestamp_millis());

    // Create new session state
    let session_state = Arc::new(Mutex::new(SessionState::new(
        session_id.clone(),
        name,
        server_url,
        launch_command,
    )));

    // Store session state
    {
        let mut states = session_states.lock().unwrap();
        states.insert(session_id.clone(), session_state.clone());
    }

    // Log session creation
    crate::ui_logger::log_info(
        &app_handle,
        &format!("Debug session created: {}", session_id),
        Some(session_id.clone()),
    );

    // Emit session-updated event for the new session
    emit_session_update(&session_state, &app_handle);

    info!("Created debug session: {}", session_id);
    Ok(session_id)
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
        .send(true)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send step signal: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn stop_debug_session(
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
        
        // Verify session can be stopped
        if matches!(state.status, SessionStatus::Finished | SessionStatus::Error(_)) {
            return Err(Error::InvalidSessionState(
                "Session is already finished".to_string()
            ));
        }
        
        state
            .step_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session step sender not available".to_string()))?
            .clone()
    };

    // Send stop signal - let session thread handle status updates
    step_sender
        .send(false)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send stop signal: {}", e)))?;

    Ok(())
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

    // Assuming x64 for now, this should ideally be part of session info
    let arch = joybug2::interfaces::Architecture::X64;

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