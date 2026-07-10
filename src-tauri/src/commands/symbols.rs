use crate::error::{Error, Result};
use crate::session::{UICommand, SymbolData};
use crate::state::SessionStatesMap;
use joybug2::protocol_io::{PdbLoadOutcome, SymbolLoadState};
use super::types::{ModuleSymbolStatusData, PdbLoadResultData, PdbMismatchData};
use tauri::{Emitter, State};
use tracing::{debug, error, info, warn};

/// Per-module symbol load status. Pure OOB so it works while Running, Paused, or
/// non-invasively Open. Errors degrade to an empty list — this is advisory data
/// polled every second and must not toast-spam (it also keeps compatibility with
/// older external servers that don't know the request).
#[tauri::command]
pub fn get_session_symbol_status(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<ModuleSymbolStatusData>> {
    let session_arc = match super::get_session_arc(&session_id, &session_states) {
        Ok(arc) => arc,
        Err(_) => return Ok(Vec::new()),
    };
    let statuses = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
        oob.get_symbol_status(pid)
    });
    match super::flatten_oob(statuses) {
        Ok(statuses) => Ok(statuses.into_iter().map(|s| {
            let (status, symbol_count, error) = match s.state {
                SymbolLoadState::Loaded { symbol_count } => ("loaded", Some(symbol_count), None),
                SymbolLoadState::Loading => ("loading", None, None),
                SymbolLoadState::Failed { error } => ("failed", None, Some(error)),
                SymbolLoadState::NotRequested => ("not_requested", None, None),
            };
            ModuleSymbolStatusData {
                module_path: s.module_path,
                base_address: format!("0x{:X}", s.module_base),
                status: status.to_string(),
                symbol_count,
                error,
                pdb_path: s.pdb_path,
            }
        }).collect()),
        Err(e) => {
            warn!("Symbol status query failed for session {}: {}", session_id, e);
            Ok(Vec::new())
        }
    }
}

/// Load symbols for a module from a user-supplied PDB file.
/// A GUID/age mismatch is reported in the result (not as an error) so the UI can
/// offer "Load anyway" (re-invoke with force=true).
#[tauri::command]
pub fn load_module_pdb(
    session_id: String,
    module_base: String,
    pdb_path: String,
    force: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<PdbLoadResultData> {
    let base = super::parse_hex_u64(&module_base, "module base")?;
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let outcome = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
        oob.load_pdb_from_path(pid, base, &pdb_path, force)
    });
    match super::flatten_oob(outcome) {
        Ok(PdbLoadOutcome::Loaded { symbol_count }) => {
            info!("Loaded PDB '{}' for module {} in session {} ({} symbols)", pdb_path, module_base, session_id, symbol_count);
            Ok(PdbLoadResultData { loaded: true, symbol_count: Some(symbol_count), mismatch: None })
        }
        Ok(PdbLoadOutcome::Mismatch(m)) => {
            info!("PDB '{}' mismatches module {} in session {}", pdb_path, module_base, session_id);
            Ok(PdbLoadResultData {
                loaded: false,
                symbol_count: None,
                mismatch: Some(PdbMismatchData {
                    pe_guid: m.pe_guid,
                    pe_age: m.pe_age,
                    pdb_guid: m.pdb_guid,
                    pdb_age: m.pdb_age,
                }),
            })
        }
        Err(e) => Err(Error::InternalCommunication(e)),
    }
}

/// Retry a failed symbol download for a module.
#[tauri::command]
pub fn retry_module_symbols(
    session_id: String,
    module_base: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    let base = super::parse_hex_u64(&module_base, "module base")?;
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
        oob.retry_symbol_load(pid, base)
    });
    super::flatten_oob(result).map_err(Error::InternalCommunication)?;
    info!("Symbol retry requested for module {} in session {}", module_base, session_id);
    Ok(())
}

#[tauri::command]
pub fn search_session_symbols(
    session_id: String,
    pattern: String,
    limit: Option<usize>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<SymbolData>> {
    debug!("Searching for symbols in session {} with pattern '{}'", session_id, pattern);
    let limit_val = limit.unwrap_or(1000) as u32;
    let session_arc = super::get_session_arc(&session_id, &session_states)?;

    match super::try_send_paused_command(&session_arc, UICommand::SearchSymbols {
        pattern: pattern.clone(),
        limit: limit_val,
    }) {
        Ok(()) => {
            info!("Symbol search request sent for session {} with pattern '{}'", session_id, pattern);
        }
        Err(_) => {
            let found = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, _pid| oob.find_symbols(&pattern, limit_val as usize));
            match super::flatten_oob(found) {
                Ok(resolved_symbols) => {
                    let symbols: Vec<SymbolData> = resolved_symbols.iter().map(|rs| {
                        let symbol_name = if let Some(pos) = rs.name.find('!') {
                            rs.name[pos + 1..].to_string()
                        } else {
                            rs.name.clone()
                        };
                        SymbolData {
                            name: symbol_name,
                            module_name: rs.module_name.clone(),
                            rva: rs.rva,
                            va: format!("0x{:X}", rs.va),
                            display_name: rs.name.clone(),
                            is_function: rs.is_function,
                        }
                    }).collect();

                    #[derive(serde::Serialize)]
                    struct SymbolSearchResult<'a> {
                        session_id: String,
                        pattern: &'a str,
                        symbols: &'a Vec<SymbolData>,
                    }
                    let result = SymbolSearchResult {
                        session_id: session_id.clone(),
                        pattern: &pattern,
                        symbols: &symbols,
                    };
                    let _ = app_handle.emit("symbols-updated", &result);
                    info!("OOB symbol search for session {} with pattern '{}'", session_id, pattern);
                }
                Err(e) => {
                    error!("OOB symbol search failed: {}", e);
                    #[derive(serde::Serialize)]
                    struct SymbolSearchError<'a> { session_id: String, pattern: &'a str, error: String }
                    let _ = app_handle.emit("symbols-error", &SymbolSearchError {
                        session_id: session_id.clone(), pattern: &pattern, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
pub fn request_resolve_thread_symbols(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ResolveThreadSymbols)?;
    info!("Resolve thread symbols request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_thread_callstack(
    session_id: String,
    tid: u32,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, UICommand::GetThreadCallStack { tid }, |client, pid| {
        crate::session::callstack::process_thread_callstack_request(client, &handle, pid, tid);
    })?;
    info!("Thread callstack processed for session {}, tid {}", session_id, tid);
    Ok(())
}

#[tauri::command]
pub fn request_session_callstack(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::GetCallStack)?;
    info!("Request for call stack sent for session {}", session_id);
    Ok(())
}
