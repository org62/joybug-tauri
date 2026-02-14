use crate::error::Result;
use crate::settings::{DebugSettings, SettingsState, save_settings_to_disk};
use tauri::State;
use tracing::error;

#[tauri::command]
pub fn get_debug_settings(settings: State<'_, SettingsState>) -> Result<DebugSettings> {
    let s = settings.lock().unwrap();
    Ok(s.clone())
}

#[tauri::command]
pub fn update_debug_settings(
    new_settings: DebugSettings,
    settings: State<'_, SettingsState>,
) -> Result<()> {
    {
        let mut s = settings.lock().unwrap();
        *s = new_settings.clone();
    }
    if let Err(e) = save_settings_to_disk(&new_settings) {
        error!("Failed to save settings: {}", e);
    }
    Ok(())
}
