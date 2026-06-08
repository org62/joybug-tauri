use std::path::PathBuf;

/// Resolve the application data directory.
///
/// Checks `JOYBUG_DATA_DIR` first (used by e2e tests for isolation),
/// then falls back to platform-specific defaults:
/// - Windows: `%LOCALAPPDATA%\JoybugTauri` or `%APPDATA%\JoybugTauri`
/// - Unix: `$XDG_CONFIG_HOME/joybug-tauri` or `~/.config/joybug-tauri`
/// - Fallback: current working directory
pub fn joybug_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("JOYBUG_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "windows") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(base).join("JoybugTauri");
        }
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base).join("JoybugTauri");
        }
    }
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(base).join("joybug-tauri");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("joybug-tauri");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
