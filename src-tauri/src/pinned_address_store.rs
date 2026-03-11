use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tracing::error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedAddress {
    pub module_name: Option<String>,
    pub module_offset: Option<u64>,
    pub raw_address: Option<String>,
    pub value_type: String,
    pub label: Option<String>,
}

fn pinned_addresses_file_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(base)
                .join("JoybugTauri")
                .join("pinned_addresses.json");
        }
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base)
                .join("JoybugTauri")
                .join("pinned_addresses.json");
        }
    }
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(base)
            .join("joybug-tauri")
            .join("pinned_addresses.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("joybug-tauri")
            .join("pinned_addresses.json");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("joybug_tauri_pinned_addresses.json")
}

pub fn load_pinned_addresses(launch_command: &str) -> Vec<PinnedAddress> {
    let path = pinned_addresses_file_path();
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let map: HashMap<String, Vec<PinnedAddress>> = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            error!("Failed to parse pinned addresses file: {}", e);
            return Vec::new();
        }
    };
    map.get(launch_command).cloned().unwrap_or_default()
}

pub fn save_pinned_addresses(launch_command: &str, addresses: &[PinnedAddress]) {
    let path = pinned_addresses_file_path();

    let mut map: HashMap<String, Vec<PinnedAddress>> = if let Ok(bytes) = fs::read(&path) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if addresses.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), addresses.to_vec());
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match serde_json::to_vec_pretty(&map) {
        Ok(data) => {
            if let Err(e) = fs::File::create(&path).and_then(|mut f| f.write_all(&data)) {
                error!("Failed to save pinned addresses: {}", e);
            }
        }
        Err(e) => {
            error!("Failed to serialize pinned addresses: {}", e);
        }
    }
}
