use std::sync::Mutex;
use tauri::State;
use joybug::debug_client::AsyncDebugClient;
use serde::{Deserialize, Serialize};
use tracing::{info, error};

// State management for the debug client and server URL
#[derive(Default)]
struct DebugState {
    client: Option<AsyncDebugClient>,
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
async fn create_debug_client(
    base_url: String,
    client_state: State<'_, DebugClientState>,
    logs_state: State<'_, LogsState>,
) -> Result<String, String> {
    info!("Creating debug client with URL: {}", base_url);
    
    let client = AsyncDebugClient::new(base_url.clone());
    
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
async fn ping_debug_server(
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
    let temp_client = AsyncDebugClient::new(base_url);
    
    match temp_client.ping().await {
        Ok(()) => {
            info!("Ping successful");
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("success", "✓ Debug server ping successful"));
            Ok("Ping successful".to_string())
        }
        Err(e) => {
            error!("Ping failed: {}", e);
            let mut logs = logs_state.lock().unwrap();
            logs.push(LogEntry::new("error", &format!("✗ Debug server ping failed: {}", e)));
            Err(format!("Ping failed: {}", e))
        }
    }
}

#[tauri::command]
async fn get_logs(logs_state: State<'_, LogsState>) -> Result<Vec<LogEntry>, String> {
    let logs = logs_state.lock().unwrap();
    Ok(logs.clone())
}

#[tauri::command]
async fn clear_logs(logs_state: State<'_, LogsState>) -> Result<(), String> {
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
            ping_debug_server,
            get_logs,
            clear_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
