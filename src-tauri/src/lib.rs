mod bookmark_store;
mod breakpoint_store;
mod commands;
mod custom_types;
mod data_dir;
mod error;
mod events;
mod patch_store;
mod ui_logger;
mod session;
mod state;
mod settings;

use state::{EmbeddedServersMap, LogsState, SessionStatesMap};
use settings::{SettingsState, load_settings_from_disk};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging.
    // In debug builds, log to stdout (console subsystem is available).
    // In release builds, stdout is invalid (GUI subsystem), so log to a file instead.
    #[cfg(debug_assertions)]
    {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .init();
    }
    #[cfg(not(debug_assertions))]
    {
        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        if let Some(data_dir) = dirs::data_local_dir() {
            let log_dir = data_dir.join("joybug");
            let file_appender = tracing_appender::rolling::daily(&log_dir, "joybug.log");
            tracing_subscriber::fmt()
                .with_writer(file_appender)
                .with_env_filter(filter)
                .with_ansi(false)
                .init();
        } else {
            // Fallback: log to stderr if local data dir is unavailable
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .init();
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all())
                .build()
        )
        .manage(SessionStatesMap::default())
        .manage(EmbeddedServersMap::default())
        .manage(LogsState::default())
        .manage(SettingsState::new(load_settings_from_disk()))
        .manage(commands::OobPool::default())
        .manage(commands::SourceIndexCache::default())
        .manage(commands::PeFilesState::default())
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
            commands::step_pass_exception,
            commands::stop_debug_session,
            commands::pause_debug_session,
            commands::terminate_debug_session,
            commands::detach_debug_session,
            commands::attach_open_session,
            commands::list_processes,
            commands::delete_debug_session,
            commands::request_disassembly,
            commands::request_function_disassembly,
            commands::get_logs,
            commands::add_log,
            commands::clear_logs,
            commands::get_session_modules,
            commands::get_session_threads,
            commands::get_session_thread_tebs,
            commands::search_session_symbols,
            commands::get_session_symbol_status,
            commands::load_module_pdb,
            commands::retry_module_symbols,
            commands::list_session_types,
            commands::get_session_type,
            commands::get_session_type_by_index,
            commands::get_session_teb_peb,
            commands::list_custom_types,
            commands::save_custom_type,
            commands::delete_custom_type,
            commands::parse_custom_type_text,
            commands::resolve_custom_type,
            commands::request_session_callstack,
            commands::request_thread_callstack,
            commands::request_resolve_thread_symbols,
            commands::request_memory_read,
            commands::request_memory_write,
            commands::read_memory_batch,
            commands::read_memory_sync,
            commands::request_set_register,
            commands::request_memory_regions,
            commands::request_dereference,
            commands::request_dereference_batch,
            commands::request_memory_search,
            commands::request_emulation,
            commands::update_window_state,
            commands::get_debug_settings,
            commands::update_debug_settings,
            commands::toggle_breakpoint,
            commands::set_breakpoints,
            commands::remove_breakpoint,
            commands::remove_breakpoints,
            commands::enable_breakpoint,
            commands::enable_breakpoint_group,
            commands::update_breakpoint,
            commands::set_hardware_breakpoint,
            commands::start_watchpoint_trace,
            commands::stop_watchpoint_trace,
            commands::poll_watchpoint_accesses,
            commands::start_code_coverage,
            commands::get_code_coverage,
            commands::stop_code_coverage,
            commands::request_module_extra_info,
            commands::resolve_address_to_line,
            commands::get_source_file_line_map,
            commands::list_source_files,
            commands::open_source_file,
            commands::read_source_window,
            commands::step_over_line_debug_session,
            commands::step_into_line_debug_session,
            commands::request_scan_memory_start,
            commands::request_scan_memory_next,
            commands::request_scan_memory_get_results,
            commands::request_scan_memory_reset,
            commands::request_pointer_scan_start,
            commands::request_pointer_scan_get_results,
            commands::request_pointer_scan_reset,
            commands::request_pointer_scan_rescan,
            commands::request_pointer_scan_apply_filter,
            commands::request_string_scan_start,
            commands::request_string_scan_get_results,
            commands::request_string_scan_reset,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::remove_bookmarks,
            commands::update_bookmark,
            commands::set_bookmark_value,
            commands::toggle_bookmark_lock,
            commands::refresh_bookmarks,
            commands::assemble_patch,
            commands::undo_patch,
            commands::undo_patches,
            commands::enable_patch,
            commands::update_patch,
            commands::enable_patch_group,
            commands::get_patches,
            commands::pe_open,
            commands::pe_read_bytes,
            commands::pe_write_bytes,
            commands::pe_disassemble,
            commands::pe_save,
            commands::pe_close,
            commands::pe_load_symbols,
            commands::pe_search_symbols,
            commands::pe_string_scan,
            commands::pe_set_field,
            commands::pe_field_span,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
