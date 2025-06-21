use std::sync::Mutex;
use tauri::State;
use serde::{Deserialize, Serialize};
use tracing::{info, error};

// State management for the debug client and server URL
#[derive(Default)]
struct DebugState {
    client: Option<joybug2::protocol_io::DebugClient>,
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
    
    let client = match joybug2::protocol_io::DebugClient::connect(Some(&base_url)) {
        Ok(client) => client,
        Err(e) => {
            let error_msg = format!("Failed to connect to debug server at {}: {}", base_url, e);
            error!("{}", error_msg);
            
            // Also log to the UI logs
            {
                let mut logs = logs_state.lock().unwrap();
                logs.push(LogEntry::new("error", &error_msg));
            }
            
            return Err(error_msg);
        }
    };
    
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
fn launch(
    command: String,
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Launching process via debug server with command: {}", command);
    
    //{
    //    let mut logs = logs_state.lock().unwrap();
    //    logs.push(LogEntry::new("info", &format!("Launching process: {}", command)));
    //}
    
    //// Get the base URL to recreate the client without holding the lock
    //let base_url = {
    //    let client_guard = client_state.lock().unwrap();
    //    match &client_guard.base_url {
    //        Some(url) => url.clone(),
    //        None => {
    //            let mut logs = logs_state.lock().unwrap();
    //            logs.push(LogEntry::new("error", "No debug client connected"));
    //            return Err("No debug client connected".to_string());
    //        },
    //    }
    //};
    
    Ok(format!("TODO: implement launch"))
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
            launch,
            get_logs,
            clear_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
