use std::collections::HashMap;

use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info};

use super::helpers::{extract_module_name, find_module_for_address, format_symbol, get_modules_snapshot};
use super::types::*;

fn emit_pointer_scan_error(handle: &AppHandle, session_id: String, error: impl std::fmt::Display) {
    let err = ScanError { session_id, error: error.to_string() };
    let _ = handle.emit("pointer-scan-error", &err);
}

/// Processes a pointer scan start request. Uses all cores (thread_count = None).
pub(crate) fn process_pointer_scan_start(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    target_address: u64,
    max_offset: u64,
    max_depth: u32,
    max_results: Option<u64>,
    modules: Option<Vec<u64>>,
    writable_only: bool,
) {
    let pid = event.pid();
    debug!("📤 Processing pointer scan start: pid={}, target=0x{:X}, max_offset=0x{:X}, max_depth={}, modules={:?}, writable_only={}",
        pid, target_address, max_offset, max_depth, modules.as_ref().map(|m| m.len()), writable_only);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    // thread_count = None => use all available cores.
    match session.pointer_scan_start(pid, target_address, max_offset, max_depth, None, max_results, modules, None, writable_only) {
        Ok((results_path, match_count, scan_time_us)) => {
            info!("📥 Pointer scan started: results_path={}, paths={}, time={}μs", results_path, match_count, scan_time_us);
            let result = PointerScanStartResult { session_id, results_path, match_count, scan_time_us };
            if let Err(e) = handle.emit("pointer-scan-start-result", &result) {
                error!("Failed to emit pointer-scan-start-result: {}", e);
            }
        }
        Err(e) => {
            error!("Pointer scan start failed: {}", e);
            emit_pointer_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a pointer scan rescan: narrows a prior scan to paths still resolving
/// to `target_address`, then emits the updated count via `pointer-scan-start-result`
/// (so the frontend refreshes the same way it does after a fresh scan).
pub(crate) fn process_pointer_scan_rescan(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    results_path: String,
    target_address: u64,
) {
    let pid = event.pid();
    debug!("📤 Processing pointer scan rescan: results_path={}, target=0x{:X}", results_path, target_address);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    match session.pointer_scan_rescan(pid, results_path, target_address) {
        Ok((results_path, match_count, scan_time_us)) => {
            info!("📥 Pointer rescan: results_path={}, paths={}, time={}μs", results_path, match_count, scan_time_us);
            let result = PointerScanStartResult { session_id, results_path, match_count, scan_time_us };
            if let Err(e) = handle.emit("pointer-scan-start-result", &result) {
                error!("Failed to emit pointer-scan-start-result (rescan): {}", e);
            }
        }
        Err(e) => {
            error!("Pointer rescan failed: {}", e);
            emit_pointer_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a pointer scan get-results request and emits a page of paths.
/// The static base of each path is symbolized ("module!name+0xoff").
pub(crate) fn process_pointer_scan_get_results(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    results_path: String,
    offset: u64,
    count: u64,
    offset_filter: Vec<u64>,
) {
    debug!("📤 Processing pointer scan get results: results_path={}, offset={}, count={}, filter={:?}", results_path, offset, count, offset_filter);

    let Some(ref handle) = app_handle_clone else { return };
    let pid = event.pid();
    let session_id = session.state.lock().unwrap().id.clone();

    match session.pointer_scan_get_results(pid, results_path.clone(), offset, count, offset_filter) {
        Ok((paths, total_count)) => {
            debug!("📥 Pointer scan results: {} paths, total={}", paths.len(), total_count);
            // Resolve each distinct static base address to a symbol once. The
            // static root is usually a .data/.bss global with no exported symbol,
            // so fall back to the containing module + offset (like bookmarks do)
            // rather than showing a bare address.
            let modules = get_modules_snapshot(session);
            let mut sym_cache: HashMap<u64, Option<String>> = HashMap::new();
            let mut entries = Vec::with_capacity(paths.len());
            for p in &paths {
                let base_addr = p.module_base.wrapping_add(p.base_offset);
                if !sym_cache.contains_key(&base_addr) {
                    let sym = match session.resolve_address_to_symbol(pid, base_addr) {
                        Ok((Some(m), Some(s), Some(off))) => {
                            Some(format_symbol(&extract_module_name(&m), &s.name, off))
                        }
                        _ => find_module_for_address(&modules, base_addr)
                            .map(|(name, off)| format!("{}+0x{:X}", name, off)),
                    };
                    sym_cache.insert(base_addr, sym);
                }
                entries.push(PointerPathEntry {
                    module_index: p.module_index,
                    module_base: format!("0x{:016X}", p.module_base),
                    base_offset: format!("0x{:X}", p.base_offset),
                    base_symbol: sym_cache.get(&base_addr).cloned().flatten(),
                    offsets: p.offsets.iter().map(|o| format!("0x{:X}", o)).collect(),
                    resolved: format!("0x{:016X}", p.resolved),
                });
            }
            let result = PointerScanResultsPayload { session_id, results_path, paths: entries, total_count };
            if let Err(e) = handle.emit("pointer-scan-results", &result) {
                error!("Failed to emit pointer-scan-results: {}", e);
            }
        }
        Err(e) => {
            error!("Pointer scan get results failed: {}", e);
            emit_pointer_scan_error(handle, session_id, e);
        }
    }
}

/// Commits a quick filter: reduces the results file to only paths whose chain
/// offsets contain all `offset_filter` values, then emits the new file via
/// `pointer-scan-start-result` so the frontend refreshes like after a fresh scan.
pub(crate) fn process_pointer_scan_apply_filter(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    results_path: String,
    offset_filter: Vec<u64>,
) {
    debug!("📤 Processing pointer scan apply filter: results_path={}, filter={:?}", results_path, offset_filter);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    match session.pointer_scan_apply_filter(results_path, offset_filter) {
        Ok((results_path, match_count, scan_time_us)) => {
            info!("📥 Pointer filter committed: results_path={}, paths={}, time={}μs", results_path, match_count, scan_time_us);
            let result = PointerScanStartResult { session_id, results_path, match_count, scan_time_us };
            if let Err(e) = handle.emit("pointer-scan-start-result", &result) {
                error!("Failed to emit pointer-scan-start-result (apply filter): {}", e);
            }
        }
        Err(e) => {
            error!("Pointer scan apply filter failed: {}", e);
            emit_pointer_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a pointer scan reset request.
pub(crate) fn process_pointer_scan_reset(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    results_path: String,
) {
    debug!("📤 Processing pointer scan reset: results_path={}", results_path);

    if let Err(e) = session.pointer_scan_reset(results_path.clone()) {
        error!("Pointer scan reset failed: {}", e);
        if let Some(ref handle) = app_handle_clone {
            let session_id = session.state.lock().unwrap().id.clone();
            emit_pointer_scan_error(handle, session_id, e);
        }
    } else {
        debug!("📥 Pointer scan reset complete for results_path={}", results_path);
    }
}
