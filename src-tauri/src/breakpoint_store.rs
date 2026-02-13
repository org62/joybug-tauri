use crate::state::BreakpointInfo;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tracing::error;

fn breakpoints_file_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(base).join("JoybugTauri").join("breakpoints.json");
        }
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base).join("JoybugTauri").join("breakpoints.json");
        }
    }
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(base).join("joybug-tauri").join("breakpoints.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("joybug-tauri")
            .join("breakpoints.json");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("joybug_tauri_breakpoints.json")
}

pub fn load_breakpoints(launch_command: &str) -> Vec<BreakpointInfo> {
    let path = breakpoints_file_path();
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let map: HashMap<String, Vec<BreakpointInfo>> = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            error!("Failed to parse breakpoints file: {}", e);
            return Vec::new();
        }
    };
    match map.get(launch_command) {
        Some(bps) => bps
            .iter()
            .map(|bp| BreakpointInfo {
                id: uuid::Uuid::new_v4().to_string(),
                address: 0,
                module_name: bp.module_name.clone(),
                module_offset: bp.module_offset,
                name: bp.name.clone(),
                group: bp.group.clone(),
                symbol: bp.symbol.clone(),
                enabled: bp.enabled,
                is_active: false,
            })
            .collect(),
        None => Vec::new(),
    }
}

pub fn save_breakpoints(launch_command: &str, breakpoints: &[BreakpointInfo]) {
    let path = breakpoints_file_path();

    // Read existing file to preserve other targets' breakpoints
    let mut map: HashMap<String, Vec<BreakpointInfo>> = if let Ok(bytes) = fs::read(&path) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if breakpoints.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), breakpoints.to_vec());
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match serde_json::to_vec_pretty(&map) {
        Ok(data) => {
            if let Err(e) = fs::File::create(&path).and_then(|mut f| f.write_all(&data)) {
                error!("Failed to save breakpoints: {}", e);
            }
        }
        Err(e) => {
            error!("Failed to serialize breakpoints: {}", e);
        }
    }
}
