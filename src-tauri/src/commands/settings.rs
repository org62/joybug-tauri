use crate::error::Result;
use crate::session::UICommand;
use crate::settings::{DebugSettings, SettingsState, save_settings_to_disk};
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::error;

/// The settings fields that drive auto breakpoints (module entry / TLS callbacks),
/// as a comparable snapshot for change detection.
fn auto_breakpoint_toggles(s: &DebugSettings) -> (bool, bool, bool, bool) {
    (
        s.break_on_user_module_entry,
        s.break_on_system_module_entry,
        s.break_on_user_tls_callbacks,
        s.break_on_system_tls_callbacks,
    )
}

#[tauri::command]
pub fn get_debug_settings(settings: State<'_, SettingsState>) -> Result<DebugSettings> {
    let s = settings.lock().unwrap();
    Ok(s.clone())
}

#[tauri::command]
pub fn update_debug_settings(
    new_settings: DebugSettings,
    settings: State<'_, SettingsState>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let auto_bp_changed = {
        let mut s = settings.lock().unwrap();
        let changed = auto_breakpoint_toggles(&s) != auto_breakpoint_toggles(&new_settings);
        *s = new_settings.clone();
        changed
    };
    if let Err(e) = save_settings_to_disk(&new_settings) {
        error!("Failed to save settings: {}", e);
    }

    // Live-sync settings-driven auto breakpoints (module entry / TLS callbacks) for
    // every active session when one of those toggles changed, so the rows update
    // immediately instead of waiting for the next run. Skipped for unrelated settings
    // edits — the sync sweeps every loaded module per session.
    if auto_bp_changed {
        let session_ids: Vec<String> = {
            let map = session_states.lock().unwrap();
            map.keys().cloned().collect()
        };
        for session_id in session_ids {
            let _ = super::paused_or_oob(&session_id, &session_states, &oob_pool, UICommand::SyncAutoBreakpoints, |oob, pid| {
                crate::session::breakpoints::process_sync_auto_breakpoints(oob, &Some(app_handle.clone()), pid);
            });
        }
    }

    Ok(())
}
