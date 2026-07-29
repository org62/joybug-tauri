use crate::error::{Error, Result};
use crate::session::helpers::{find_module_by_name, module_short_name};
use crate::state::SessionStatesMap;
use serde::Serialize;
use std::collections::HashSet;
use tauri::State;
use tracing::info;

/// One armed coverage function, returned to the frontend at scan start. The
/// frontend holds this table and joins live hit counts (from `get_code_coverage`)
/// by `address`.
#[derive(Serialize)]
pub struct CoverageFn {
    pub address: String, // hex "0x..."
    pub symbol: String,
    pub rva: u32,
}

/// A live hit count for one covered address.
#[derive(Serialize)]
pub struct CoverageHit {
    pub address: String, // hex "0x..."
    pub hit_count: u64,
    /// 1-based first-execution order across the coverage run (always >= 1 —
    /// only addresses hit at least once are reported).
    pub first_hit_seq: u64,
    /// Distinct thread ids that hit this address, in first-hit order.
    pub thread_ids: Vec<u32>,
}

/// Enumerate every function in `module_name`, arm silent server-side coverage
/// breakpoints on them, and return the armed function table (address/symbol/rva).
/// `hit_limit` is the hit count after which each breakpoint auto-removes
/// (1 = remove on first hit = pure coverage; >1 = heat map; 0 = never remove).
///
/// Runs on the scan OOB connection: symbol enumeration + arming thousands of
/// breakpoints can take seconds and must not head-of-line-block the live
/// connection's high-frequency polling.
#[tauri::command]
pub fn start_code_coverage(
    session_id: String,
    module_name: String,
    hit_limit: u64,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<CoverageFn>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let (module_path, base) = {
        let state = session_arc.lock().unwrap();
        find_module_by_name(&state.modules, &module_name)
            .map(|m| (m.name.clone(), m.base))
            .ok_or_else(|| Error::InvalidParameter(format!("Module not loaded: {}", module_name)))?
    };
    let short = module_short_name(&module_path);

    let functions = super::flatten_oob(super::with_oob_scan_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| -> std::result::Result<Vec<CoverageFn>, String> {
            let symbols = oob.list_symbols(&module_path).map_err(|e| e.to_string())?;

            // One row per address (functions can share an RVA); keep the first name.
            let mut seen: HashSet<u64> = HashSet::new();
            let mut functions: Vec<CoverageFn> = Vec::new();
            let mut addrs: Vec<u64> = Vec::new();
            for sym in symbols.into_iter().filter(|s| s.is_function) {
                let va = base + sym.rva as u64;
                if !seen.insert(va) {
                    continue;
                }
                addrs.push(va);
                functions.push(CoverageFn {
                    address: format!("0x{:X}", va),
                    symbol: sym.name,
                    rva: sym.rva,
                });
            }

            // Arming nothing looks exactly like "this module was never executed" in
            // the table, so say why instead. `list_symbols` errors while a PDB is
            // still loading, so reaching this means the module really has no
            // function symbols.
            if addrs.is_empty() {
                return Err(format!(
                    "No function symbols in {} — nothing to arm coverage on",
                    module_path
                ));
            }

            oob.start_coverage(pid, addrs, hit_limit).map_err(|e| e.to_string())?;
            Ok(functions)
        },
    ))
    .map_err(Error::DebugLoop)?;

    info!(
        "Started code coverage for session {} on {} ({} functions, limit {})",
        session_id,
        short,
        functions.len(),
        hit_limit
    );
    Ok(functions)
}

/// Poll live hit counts. The server returns only addresses hit at least once;
/// the frontend fills zeros for the rest from the table returned by
/// `start_code_coverage`.
#[tauri::command]
pub fn get_code_coverage(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<CoverageHit>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let hits = super::flatten_oob(super::with_oob_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| oob.get_coverage(pid),
    ))
    .map_err(Error::DebugLoop)?;

    Ok(hits
        .into_iter()
        .map(|h| CoverageHit {
            address: format!("0x{:X}", h.address),
            hit_count: h.hit_count,
            first_hit_seq: h.first_hit_seq,
            thread_ids: h.thread_ids,
        })
        .collect())
}

/// Remove all coverage breakpoints and clear coverage state. On the scan
/// connection like `start_code_coverage` (unwriting thousands of breakpoint
/// bytes is slow).
#[tauri::command]
pub fn stop_code_coverage(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::flatten_oob(super::with_oob_scan_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| oob.stop_coverage(pid),
    ))
    .map_err(Error::DebugLoop)?;

    info!("Stopped code coverage for session {}", session_id);
    Ok(())
}
