mod commands;
mod error;
mod events;
mod ui_logger;
mod session;
mod state;
mod settings;

use state::{LogsState, SessionStatesMap};
use settings::{SettingsState, load_settings_from_disk};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all())
                .build()
        )
        .manage(SessionStatesMap::default())
        .manage(LogsState::default())
        .manage(SettingsState::new(load_settings_from_disk()))
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::create_debug_session,
            commands::update_debug_session,
            commands::get_debug_sessions,
            commands::get_debug_session,
            commands::start_debug_session,
            commands::step_debug_session,
            commands::step_in_debug_session,
            commands::step_over_debug_session,
            commands::step_out_debug_session,
            commands::stop_debug_session,
            commands::pause_debug_session,
            commands::terminate_debug_session,
            commands::delete_debug_session,
            commands::request_disassembly,
            commands::get_logs,
            commands::clear_logs,
            commands::get_session_modules,
            commands::get_session_threads,
            commands::search_session_symbols,
            commands::request_session_callstack,
            commands::update_window_state,
            commands::get_debug_settings,
            commands::update_debug_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
