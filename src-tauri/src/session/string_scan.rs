use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info};

use joybug_core::protocol::{ScanRegionFilter, StringEncodingFilter, StringSortKey};

use super::helpers::emit_scan_error;
use super::types::*;

/// Processes a string scan start request over the OOB scan client and emits
/// `string-scan-start-result`. `thread_count = None` uses all cores.
#[allow(clippy::too_many_arguments)]
pub(crate) fn process_string_scan_start(
    session: &mut DebugSession,
    handle: &AppHandle,
    pid: u32,
    start_address: u64,
    size: u64,
    min_length: u32,
    thread_count: Option<usize>,
    region_filter: &str,
    encodings: &str,
    contains: String,
) {
    debug!(
        "📤 Processing string scan start: pid={}, start=0x{:X}, size=0x{:X}, min_length={}, region_filter={}, encodings={}, contains={:?}",
        pid, start_address, size, min_length, region_filter, encodings, contains
    );

    let session_id = session.state.lock().unwrap().id.clone();
    let region_filter: ScanRegionFilter = region_filter.parse().unwrap_or_default();
    let encodings: StringEncodingFilter = encodings.parse().unwrap_or_default();

    match session.string_scan_start(pid, start_address, size, min_length, None, thread_count, region_filter, encodings, contains) {
        Ok((results_path, match_count, scan_time_us, capped)) => {
            info!("📥 String scan started: results_path={}, strings={}, time={}μs, capped={}", results_path, match_count, scan_time_us, capped);
            let result = StringScanStartResult { session_id, results_path, match_count, scan_time_us, capped };
            if let Err(e) = handle.emit("string-scan-start-result", &result) {
                error!("Failed to emit string-scan-start-result: {}", e);
            }
        }
        Err(e) => {
            error!("String scan start failed: {}", e);
            emit_scan_error(handle, "string-scan-error", session_id, e);
        }
    }
}

/// Processes a string scan get-results request and emits a page of strings.
#[allow(clippy::too_many_arguments)]
pub(crate) fn process_string_scan_get_results(
    session: &mut DebugSession,
    handle: &AppHandle,
    results_path: String,
    offset: u64,
    count: u64,
    filter: String,
    sort_key: &str,
    ascending: bool,
) {
    debug!("📤 Processing string scan get results: results_path={}, offset={}, count={}, filter={:?}, sort={}, asc={}", results_path, offset, count, filter, sort_key, ascending);

    let session_id = session.state.lock().unwrap().id.clone();
    let sort: StringSortKey = sort_key.parse().unwrap_or_default();

    match session.string_scan_get_results(results_path.clone(), offset, count, filter, sort, ascending) {
        Ok((strings, total_count)) => {
            debug!("📥 String scan results: {} strings, total={}", strings.len(), total_count);
            let entries = strings
                .into_iter()
                .map(|s| StringEntry {
                    address: format!("0x{:016X}", s.address),
                    encoding: s.encoding.as_str().to_string(),
                    length: s.length,
                    text: s.text,
                    truncated: s.truncated,
                })
                .collect();
            let result = StringScanResultsPayload { session_id, results_path, strings: entries, total_count };
            if let Err(e) = handle.emit("string-scan-results", &result) {
                error!("Failed to emit string-scan-results: {}", e);
            }
        }
        Err(e) => {
            error!("String scan get results failed: {}", e);
            emit_scan_error(handle, "string-scan-error", session_id, e);
        }
    }
}

/// Processes a string scan reset request (deletes the results file).
pub(crate) fn process_string_scan_reset(
    session: &mut DebugSession,
    handle: &AppHandle,
    results_path: String,
) {
    debug!("📤 Processing string scan reset: results_path={}", results_path);

    if let Err(e) = session.string_scan_reset(results_path.clone()) {
        error!("String scan reset failed: {}", e);
        let session_id = session.state.lock().unwrap().id.clone();
        emit_scan_error(handle, "string-scan-error", session_id, e);
    } else {
        debug!("📥 String scan reset complete for results_path={}", results_path);
    }
}
