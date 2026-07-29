use std::sync::{Arc, Mutex};

use joybug_core::protocol_io::PdbLoadOutcome;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};

use super::helpers::{module_key_at_base, module_short_name};
use super::types::{DebugSession, SymbolData};
use crate::state::{SessionStateUI, SymbolOverrideInfo};
use joybug_core::protocol_io::{ModuleSymbolStatus, SymbolLoadState};

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
        let Some(name) = module_key_at_base(&state, module_base) else {
            warn!("record_symbol_override: no module at base 0x{:X}", module_base);
            return;
        };
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

/// Forget a module's persisted manual-PDB override (symbols unloaded by the
/// user). No-op when the base doesn't match a module or no override exists.
pub(crate) fn remove_symbol_override(state_arc: &Arc<Mutex<SessionStateUI>>, module_base: u64) {
    let saved = {
        let mut state = state_arc.lock().unwrap();
        let Some(name) = module_key_at_base(&state, module_base) else {
            return;
        };
        let before = state.symbol_overrides.len();
        state.symbol_overrides.retain(|o| !o.module_name.eq_ignore_ascii_case(&name));
        if state.symbol_overrides.len() == before {
            None
        } else {
            Some((state.launch_command.clone(), state.symbol_overrides.clone()))
        }
    };
    if let Some((launch_command, overrides)) = saved {
        crate::symbol_store::save_symbol_overrides(&launch_command, &overrides);
    }
}

/// Run `mutate` over the in-memory failed-symbols list (lazily initialized
/// from the per-target store) and persist when it reports a change. The
/// in-memory mirror keeps the 1 Hz status poll off the disk entirely: the
/// store is read once per session, then written only on real transitions.
fn with_failed_symbols(
    state_arc: &Arc<Mutex<SessionStateUI>>,
    mutate: impl FnOnce(&mut Vec<String>) -> bool,
) {
    let saved = {
        let mut state = state_arc.lock().unwrap();
        if state.failed_symbols_cache.is_none() {
            let stored = crate::symbol_store::load_failed_symbols(&state.launch_command);
            state.failed_symbols_cache = Some(stored);
        }
        let launch_command = state.launch_command.clone();
        let cache = state.failed_symbols_cache.as_mut().unwrap();
        mutate(cache).then(|| (launch_command, cache.clone()))
    };
    if let Some((launch_command, modules)) = saved {
        crate::symbol_store::save_failed_symbols(&launch_command, &modules);
    }
}

/// Keep the per-target failed-symbols store in sync with the live statuses:
/// newly failed downloads are remembered (so a restart won't re-try them),
/// modules that now have symbols are forgotten. Modules not in the current
/// status list (e.g. unloaded DLLs) keep their entries.
pub(crate) fn sync_failed_symbols(
    state_arc: &Arc<Mutex<SessionStateUI>>,
    statuses: &[ModuleSymbolStatus],
) {
    with_failed_symbols(state_arc, |stored| {
        let mut changed = false;
        for s in statuses {
            match &s.state {
                // ExportsOnly counts as failed here: the PDB is still missing,
                // and the deny entry must persist so the next session skips the
                // download (and gets the export fallback again).
                SymbolLoadState::Failed { .. } | SymbolLoadState::ExportsOnly { .. } => {
                    let short = module_short_name(&s.module_path).to_lowercase();
                    if !stored.contains(&short) {
                        stored.push(short);
                        changed = true;
                    }
                }
                // Nothing to forget while the list is empty — skips the
                // per-module allocation on the steady-state poll.
                SymbolLoadState::Loaded { .. } if !stored.is_empty() => {
                    let short = module_short_name(&s.module_path).to_lowercase();
                    let before = stored.len();
                    stored.retain(|m| m != &short);
                    changed |= stored.len() != before;
                }
                _ => {}
            }
        }
        changed
    });
}

/// Drop a module's entry from the target's persisted failed-symbols store
/// (user retry), looked up by base in the session's module list.
pub(crate) fn forget_failed_symbol(state_arc: &Arc<Mutex<SessionStateUI>>, module_base: u64) {
    let Some(short) = ({
        let state = state_arc.lock().unwrap();
        module_key_at_base(&state, module_base)
    }) else {
        return;
    };
    with_failed_symbols(state_arc, |stored| {
        let before = stored.len();
        stored.retain(|m| m != &short);
        stored.len() != before
    });
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
    event: &joybug_core::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let threads: Vec<joybug_core::protocol_io::ThreadInfo> = {
        let state = session.state.lock().unwrap();
        state.threads.clone()
    };

    // Non-blocking batch resolve, one round-trip for all threads: an address
    // in a module whose PDB is still parsing comes back `None` (shown as a raw
    // address) instead of stalling the debug loop — the threads panel
    // re-requests when `symbolsRefreshKey` flips, upgrading raw → named.
    let start_addresses: Vec<u64> = threads.iter().map(|t| t.start_address).collect();
    let resolved = session
        .try_resolve_addresses_to_symbols(pid, start_addresses)
        .unwrap_or_else(|_| vec![None; threads.len()]);

    #[derive(serde::Serialize, Clone)]
    struct ThreadSymbolEntry {
        tid: u32,
        address: String,
        symbol_info: Option<String>,
        is_function: bool,
    }

    let mut entries: Vec<ThreadSymbolEntry> = Vec::new();

    for (thread, resolved) in threads.iter().zip(resolved) {
        let (symbol_info, is_function) = match resolved {
            Some((module, sym, offset)) => {
                let short_module = module.rsplit(&['\\', '/'][..]).next().unwrap_or(&module);
                let short_module = short_module.rsplitn(2, '.').last().unwrap_or(short_module);
                let display = format!("{}!{}+0x{:x}", short_module, sym.name, offset);
                (Some(display), sym.is_function)
            }
            None => (None, true),
        };
        entries.push(ThreadSymbolEntry {
            tid: thread.tid,
            address: format!("0x{:016x}", thread.start_address),
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
                    info: joybug_core::pe_types::ModuleExtraInfo,
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
