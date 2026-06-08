use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::types::{DebugSession, SymbolData};

/// Processes a symbol search request and emits results to the frontend
pub(crate) fn process_symbol_search(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    pattern: &str,
    limit: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing symbol search request: pid={}, pattern='{}', limit={}", pid, pattern, limit);

    match session.find_symbols(pattern, limit as usize) {
        Ok(resolved_symbols) => {
            debug!("📥 Received {} symbols from find_symbols", resolved_symbols.len());

            let symbols: Vec<SymbolData> = resolved_symbols.iter().map(|resolved_symbol| {
                let symbol_name = if let Some(pos) = resolved_symbol.name.find('!') {
                    resolved_symbol.name[pos + 1..].to_string()
                } else {
                    resolved_symbol.name.clone()
                };

                SymbolData {
                    name: symbol_name,
                    module_name: resolved_symbol.module_name.clone(),
                    rva: resolved_symbol.rva,
                    va: format!("0x{:X}", resolved_symbol.va),
                    display_name: resolved_symbol.name.clone(),
                    is_function: resolved_symbol.is_function,
                }
            }).collect();

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct SymbolSearchResult<'a> {
                    session_id: String,
                    pattern: &'a str,
                    symbols: &'a Vec<SymbolData>,
                }

                let result = SymbolSearchResult {
                    session_id,
                    pattern,
                    symbols: &symbols,
                };

                if let Err(e) = handle.emit("symbols-updated", &result) {
                    error!("Failed to emit symbols-updated event: {}", e);
                } else {
                    debug!("📡 Emitted symbols-updated event for pattern '{}'", pattern);
                }
            }
        }
        Err(e) => {
            error!("Failed to find symbols for pattern '{}': {}", pattern, e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct SymbolSearchError<'a> {
                    session_id: String,
                    pattern: &'a str,
                    error: String,
                }

                let error_result = SymbolSearchError {
                    session_id,
                    pattern,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("symbols-error", &error_result) {
                    error!("Failed to emit symbols-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Resolves symbols for all thread start addresses and emits results to the frontend
pub(crate) fn process_resolve_thread_symbols(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let threads: Vec<joybug2::protocol_io::ThreadInfo> = {
        let state = session.state.lock().unwrap();
        state.threads.clone()
    };

    #[derive(serde::Serialize, Clone)]
    struct ThreadSymbolEntry {
        tid: u32,
        address: String,
        symbol_info: Option<String>,
        is_function: bool,
    }

    let mut entries: Vec<ThreadSymbolEntry> = Vec::new();

    for thread in &threads {
        let addr = thread.start_address;
        let (symbol_info, is_function) = match session.resolve_address_to_symbol(pid, addr) {
            Ok((Some(module), Some(sym), Some(offset))) => {
                let short_module = module.rsplit(&['\\', '/'][..]).next().unwrap_or(&module);
                let short_module = short_module.rsplitn(2, '.').last().unwrap_or(short_module);
                let display = format!("{}!{}+0x{:x}", short_module, sym.name, offset);
                (Some(display), sym.is_function)
            }
            _ => (None, true),
        };
        entries.push(ThreadSymbolEntry {
            tid: thread.tid,
            address: format!("0x{:016x}", addr),
            symbol_info,
            is_function,
        });
    }

    if let Some(ref handle) = app_handle_clone {
        let session_id = {
            let state = session.state.lock().unwrap();
            state.id.clone()
        };

        #[derive(serde::Serialize, Clone)]
        struct ThreadSymbolsResult {
            session_id: String,
            symbols: Vec<ThreadSymbolEntry>,
        }

        let result = ThreadSymbolsResult {
            session_id,
            symbols: entries,
        };

        if let Err(e) = handle.emit("thread-symbols-updated", &result) {
            error!("Failed to emit thread-symbols-updated event: {}", e);
        }
    }
}

/// Processes a module extra info request and emits PE header data to the frontend
pub(crate) fn process_module_extra_info_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    module_base: u64,
) {
    let pid = event.pid();
    debug!("📤 Processing module extra info request: pid={}, module_base=0x{:X}", pid, module_base);

    if let Some(ref handle) = app_handle_clone {
        let session_id = {
            let state = session.state.lock().unwrap();
            state.id.clone()
        };
        let module_base_str = format!("0x{:X}", module_base);

        match session.get_module_extra_info(pid, module_base) {
            Ok(info) => {
                debug!("📥 Received module extra info for 0x{:X}", module_base);

                #[derive(serde::Serialize)]
                struct ModuleExtraInfoResult {
                    session_id: String,
                    module_base: String,
                    info: joybug2::pe_types::ModuleExtraInfo,
                }

                let result = ModuleExtraInfoResult {
                    session_id,
                    module_base: module_base_str,
                    info,
                };

                if let Err(e) = handle.emit("module-extra-info-updated", &result) {
                    error!("Failed to emit module-extra-info-updated event: {}", e);
                } else {
                    debug!("📡 Emitted module-extra-info-updated event for 0x{:X}", module_base);
                }
            }
            Err(e) => {
                error!("Failed to get module extra info: {}", e);

                #[derive(serde::Serialize)]
                struct ModuleExtraInfoError {
                    session_id: String,
                    module_base: String,
                    error: String,
                }

                let error_result = ModuleExtraInfoError {
                    session_id,
                    module_base: module_base_str,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("module-extra-info-error", &error_result) {
                    error!("Failed to emit module-extra-info-error event: {}", emit_err);
                }
            }
        }
    }
}
