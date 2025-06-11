use std::sync::Mutex;
use tauri::State;
use serde::{Deserialize, Serialize};
use tracing::{info, error};
use joybug::debug_client::DebugClient;
use joybug::debugger_interface::Debugger;

// State management for the debug client and server URL
#[derive(Default)]
struct DebugState {
    client: Option<DebugClient>,
    base_url: Option<String>,
}

type DebugClientState = Mutex<DebugState>;
type LogsState = Mutex<Vec<LogEntry>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LogEntry {
    timestamp: String,
    level: String,
    message: String,
}

impl LogEntry {
    fn new(level: &str, message: &str) -> Self {
        Self {
            timestamp: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.to_string(),
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn create_debug_client(
    base_url: String,
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Creating debug client with URL: {}", base_url);
    
    let client = DebugClient::new(base_url.clone());
    
    {
        let mut client_guard = client_state.lock().unwrap();
        client_guard.client = Some(client);
        client_guard.base_url = Some(base_url.clone());
    }
    
    {
        let mut logs = logs_state.lock().unwrap();
        logs.push(LogEntry::new("info", &format!("Debug client created with URL: {}", base_url)));
    }
    
    Ok("Debug client created successfully".to_string())
}

#[tauri::command]
fn ping(
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Attempting to ping debug server");
    
    {
        let mut logs = logs_state.lock().unwrap();
        logs.push(LogEntry::new("info", "Attempting to ping debug server"));
    }
    
    // Get the base URL to recreate the client without holding the lock
    let base_url = {
        let client_guard = client_state.lock().unwrap();
        match &client_guard.base_url {
            Some(url) => url.clone(),
            None => return Err("No debug client created".to_string()),
        }
    };
    
    // Create a temporary client to avoid holding the mutex across await
    let temp_client = DebugClient::new(base_url);
    
    match temp_client.ping() {
        Ok(()) => {
            info!("Ping successful");
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("success", "Debug server ping successful"));
            Ok("Ping successful".to_string())
        }
        Err(e) => {
            error!("Ping failed: {}", e);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("error", &format!("Debug server ping failed: {}", e)));
            Err(format!("Ping failed: {}", e))
        }
    }
}

#[tauri::command]
fn launch(
    command: String,
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Launching process via debug server with command: {}", command);
    
    {
        let mut logs = logs_state.lock().unwrap();
        logs.push(LogEntry::new("info", &format!("Launching process: {}", command)));
    }
    
    // Get the base URL to recreate the client without holding the lock
    let base_url = {
        let client_guard = client_state.lock().unwrap();
        match &client_guard.base_url {
            Some(url) => url.clone(),
            None => {
                let mut logs = logs_state.lock().unwrap();
                logs.push(LogEntry::new("error", "No debug client connected"));
                return Err("No debug client connected".to_string());
            },
        }
    };
    
    // Create a temporary client and use its launch method
    let mut temp_client = DebugClient::new(base_url);
    
    let process_info = temp_client.launch(&command).map_err(|e| {
        error!("Failed to launch process: {}", e);
        format!("Launch failed: {e}")
    })?;

    // Store the client with the session
    {
        let mut client_guard = client_state.lock().unwrap();
        client_guard.client = Some(temp_client);
    }

    // Get session ID from the client after launch
    let session_id = {
        let client_guard = client_state.lock().unwrap();
        client_guard.client.as_ref()
            .and_then(|c| c.get_session_id())
            .cloned()
            .unwrap_or_else(|| "unknown".to_string())
    };

    info!(
        "Process launched successfully. Session: {}, PID: {}, TID: {}, Command: {}",
        session_id, process_info.process_id, process_info.thread_id, command
    );

    let mut logs = logs_state.lock().unwrap();
    logs.push(LogEntry::new(
        "success",
        &format!(
            "Process launched successfully - Session: {}, PID: {}, TID: {}, Command: {}",
            session_id, process_info.process_id, process_info.thread_id, command
        )
    ));

    Ok(format!(
        "Process launched successfully. Session: {}, PID: {}, TID: {}, Command: {}",
        session_id, process_info.process_id, process_info.thread_id, command
    ))
}

#[tauri::command]
fn get_logs(logs_state: State<'_, LogsState>) -> Result<Vec<LogEntry>, String> {
    let logs = logs_state.lock().unwrap();
    Ok(logs.clone())
}

#[tauri::command]
fn clear_logs(logs_state: State<'_, LogsState>) -> Result<(), String> {
    let mut logs = logs_state.lock().unwrap();
    logs.clear();
    Ok(())
}

#[tauri::command]
fn list_running_sessions(
    server_url: String,
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<Vec<String>, String> {
    info!("Listing running debug sessions from server: {}", server_url);
    
    {
        let mut logs = logs_state.lock().unwrap();
        logs.push(LogEntry::new("info", &format!("Requesting list of running debug sessions from {}", server_url)));
    }
    
    // Create a temporary client with the provided server URL
    let temp_client = DebugClient::new(server_url.clone());
    
    match temp_client.list_sessions() {
        Ok(sessions) => {
            info!("Retrieved {} running sessions from {}", sessions.len(), server_url);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("success", &format!("Retrieved {} running debug sessions from {}", sessions.len(), server_url)));
            Ok(sessions)
        }
        Err(e) => {
            error!("Failed to list sessions from {}: {}", server_url, e);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("error", &format!("Failed to list debug sessions from {}: {}", server_url, e)));
            Err(format!("Failed to list sessions: {}", e))
        }
    }
}

#[tauri::command]
fn terminate_session(
    server_url: String,
    session_id: String,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Terminating debug session {} on server: {}", session_id, server_url);
    
    {
        let mut logs = logs_state.lock().unwrap();
        logs.push(LogEntry::new("info", &format!("Terminating debug session {} on {}", session_id, server_url)));
    }
    
    // Create a temporary client with the provided server URL and session ID
    let mut temp_client = DebugClient::new(server_url.clone());
    temp_client.set_session_id(session_id.clone());
    
    // For now, we'll use a default process ID of 0 and exit code of 0
    // In a real implementation, you might want to track process IDs or 
    // add a terminate_by_session method to the debug server
    match Debugger::terminate(&mut temp_client, 0, 0) {
        Ok(()) => {
            info!("Successfully terminated session {} on {}", session_id, server_url);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("success", &format!("Successfully terminated debug session {} on {}", session_id, server_url)));
            Ok(format!("Session {} terminated successfully", session_id))
        }
        Err(e) => {
            error!("Failed to terminate session {} on {}: {}", session_id, server_url, e);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("error", &format!("Failed to terminate debug session {} on {}: {}", session_id, server_url, e)));
            Err(format!("Failed to terminate session: {}", e))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DebugClientState::default())
        .manage(LogsState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            create_debug_client,
            ping,
            launch,
            get_logs,
            clear_logs,
            list_running_sessions,
            terminate_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
