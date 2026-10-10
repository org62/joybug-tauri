use crate::error::Result;
use crate::session::UICommand;
use crate::settings::{DebugSettings, SettingsState, save_settings_to_disk};
use crate::state::SessionStatesMap;
use tauri::{Emitter, State};
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

/// The settings that decide whether and where telemetry is delivered.
fn telemetry_switches(s: &DebugSettings) -> (bool, &str, bool) {
    (s.telemetry_enabled, s.telemetry_endpoint.as_str(), s.telemetry_record_to_file)
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
    let (auto_bp_changed, disasm_changed, telemetry_changed) = {
        let mut s = settings.lock().unwrap();
        let changed = (
            auto_breakpoint_toggles(&s) != auto_breakpoint_toggles(&new_settings),
            s.disasm_options() != new_settings.disasm_options(),
            telemetry_switches(&s) != telemetry_switches(&new_settings),
        );
        *s = new_settings.clone();
        changed
    };
    if let Err(e) = save_settings_to_disk(&new_settings) {
        error!("Failed to save settings: {}", e);
    }

    // Telemetry follows the switches at once; the settings that shape the
    // measured paths go on record with every change.
    crate::telemetry::apply_settings(&new_settings);
    if telemetry_changed {
        let _ = app_handle.emit("telemetry-status-changed", crate::telemetry::status());
    }

    // The diagnostic disassembly switches live in each session's debug server:
    // push them, then tell the views their listings are stale. A paused
    // session takes the push through its command queue, ahead of the reloads
    // the event triggers.
    if disasm_changed {
        let options = new_settings.disasm_options();
        let session_ids: Vec<String> = session_states.lock().unwrap().keys().cloned().collect();
        for session_id in session_ids {
            let _ = super::paused_or_oob(&session_id, &session_states, &oob_pool, UICommand::SetDisasmOptions { options }, |oob, _pid| {
                if let Err(e) = oob.set_disasm_options(options) {
                    error!("Failed to apply disassembly options: {}", e);
                }
            });
        }
        let _ = app_handle.emit("disasm-options-changed", ());
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
