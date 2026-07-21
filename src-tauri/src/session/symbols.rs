use std::sync::{Arc, Mutex};

use joybug2::protocol_io::PdbLoadOutcome;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};

use super::helpers::module_short_name;
use super::types::{DebugSession, SymbolData};
use crate::state::{SessionStateUI, SymbolOverrideInfo};

/// Remember a manually-loaded PDB so a session restart re-applies it. Keyed by
/// the module's lowercased short name (the base changes with ASLR). Upserts the
/// entry for that module and persists the whole set for the target.
///
/// `module_base` is resolved to a module short name via the live module list;
/// if no module matches (shouldn't happen for a base the UI just loaded), the
/// override isn't recorded.
pub(crate) fn record_symbol_override(
    state_arc: &Arc<Mutex<SessionStateUI>>,
    module_base: u64,
    pdb_path: &str,
    force: bool,
) {
    let (launch_command, overrides) = {
        let mut state = state_arc.lock().unwrap();
        let Some(module) = state.modules.iter().find(|m| m.base == module_base) else {
            warn!("record_symbol_override: no module at base 0x{:X}", module_base);
            return;
        };
        let name = module_short_name(&module.name).to_lowercase();
        state.symbol_overrides.retain(|o| !o.module_name.eq_ignore_ascii_case(&name));
        state.symbol_overrides.push(SymbolOverrideInfo {
            module_name: name,
            pdb_path: pdb_path.to_string(),
            force,
        });
        (state.launch_command.clone(), state.symbol_overrides.clone())
    };
    crate::symbol_store::save_symbol_overrides(&launch_command, &overrides);
}

/// Re-apply a persisted manual PDB when its module (re)loads. Looks up the
/// override by short name and, if present, loads the PDB at the module's current
/// base **on a background thread** so the debug event loop isn't blocked while
/// the server parses the PDB (seconds for a large one).
///
/// The load runs over a fresh OOB connection; the server's symbol state is shared
/// across connections, so the debug-loop client sees the result. When it lands,
/// symbol status flips to `loaded` (the UI polls this and refreshes symbol-derived
/// views on its own), and we re-resolve source lines for this module's breakpoints
/// — the one thing the old synchronous "symbols before breakpoints" ordering gave
/// us for free.
pub(crate) fn reapply_symbols_for_module(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    module_name: &str,
    module_base: u64,
) {
    let over = {
        let state = session.state.lock().unwrap();
        state
            .symbol_overrides
            .iter()
            .find(|o| o.module_name.eq_ignore_ascii_case(module_name))
            .map(|o| (o.pdb_path.clone(), o.force))
    };
    let Some((pdb_path, force)) = over else { return };

    let state_arc = session.state.clone();
    let handle = app_handle_clone.clone();
    let module_name = module_name.to_string();
    std::thread::spawn(move || {
        let (mut client, _) = match crate::commands::create_oob_client(&state_arc) {
            Ok(c) => c,
            Err(e) => {
                warn!("Async PDB reapply for {}: no OOB client: {}", module_name, e);
                return;
            }
        };
        match client.load_pdb_from_path(pid, module_base, &pdb_path, force) {
            Ok(PdbLoadOutcome::Loaded { symbol_count }) => {
                info!(
                    "Re-applied manual PDB '{}' for {} at 0x{:X} ({} symbols)",
                    pdb_path, module_name, module_base, symbol_count
                );
                // Symbols now exist — re-resolve source lines for breakpoints in
                // this module (they were reapplied before the async load finished).
                super::breakpoints::refresh_breakpoint_source_lines_for_module(
                    &mut client, &handle, pid, &module_name,
                );
            }
            Ok(PdbLoadOutcome::Mismatch(_)) => {
                warn!(
                    "Manual PDB '{}' for {} mismatched on restart; not loaded (force={})",
                    pdb_path, module_name, force
                );
            }
            Err(e) => warn!("Failed to re-apply manual PDB '{}' for {}: {}", pdb_path, module_name, e),
        }
    });
}

/// Processes a symbol search request and emits results to the frontend
pub(crate) fn process_symbol_search(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    pattern: &str,
    limit: u32,
) {
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
    pid: u32,
    module_base: u64,
) {
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
