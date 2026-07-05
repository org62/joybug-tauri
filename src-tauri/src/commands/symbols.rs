use crate::error::Result;
use crate::session::{UICommand, SymbolData};
use crate::state::SessionStatesMap;
use tauri::{Emitter, State};
use tracing::{debug, error, info};

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
