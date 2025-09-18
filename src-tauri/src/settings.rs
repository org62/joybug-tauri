use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSettings {
    pub stop_on_thread_create: bool,
    pub stop_on_thread_exit: bool,
    pub stop_on_dll_load: bool,
    pub stop_on_dll_unload: bool,
    pub stop_on_initial_breakpoint: bool,
    pub stop_on_process_create: bool,
}

impl Default for DebugSettings {
    fn default() -> Self {
        Self {
            stop_on_thread_create: true,
            stop_on_thread_exit: false, // do not pause on thread exit by default
            stop_on_dll_load: true,
            stop_on_dll_unload: true,
            stop_on_initial_breakpoint: true,
            stop_on_process_create: true,
        }
    }
}

pub type SettingsState = Mutex<DebugSettings>;

fn settings_file_path() -> PathBuf {
    // Windows: %LOCALAPPDATA%\JoybugTauri\settings.json
    if cfg!(target_os = "windows") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(base).join("JoybugTauri").join("settings.json");
        }
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base).join("JoybugTauri").join("settings.json");
        }
    }
    // Unix: $XDG_CONFIG_HOME/joybug-tauri/settings.json or ~/.config/joybug-tauri/settings.json
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(base).join("joybug-tauri").join("settings.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("joybug-tauri")
            .join("settings.json");
    }
    // Fallback: current dir (dev only). This may cause hot-reload on file change.
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("joybug_tauri_settings.json")
}

pub fn load_settings_from_disk() -> DebugSettings {
    let path = settings_file_path();
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(settings) = serde_json::from_slice::<DebugSettings>(&bytes) {
            return settings;
        }
    }
    DebugSettings::default()
}

pub fn save_settings_to_disk(settings: &DebugSettings) -> std::io::Result<()> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_vec_pretty(settings).expect("serialize settings");
    let mut file = fs::File::create(path)?;
    file.write_all(&data)?;
    Ok(())
}


