use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info};

use super::helpers::format_bytes;
use super::types::*;

/// Processes a memory read request and emits results to the frontend
pub(crate) fn process_memory_read(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    size: usize,
) {
    let pid = event.pid();
    debug!("📤 Processing memory read request: pid={}, address=0x{:X}, size={}", pid, address, size);

    match session.read_memory(pid, address, size) {
        Ok(data) => {
            let bytes_read = data.len();
            let is_partial = bytes_read < size && bytes_read > 0;

            if is_partial {
                info!(
                    "📥 Partial memory read: {} of {} bytes at 0x{:X}",
                    bytes_read, size, address
                );
            } else {
                debug!("📥 Received {} bytes from read_memory", bytes_read);
            }

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryReadResult {
                    session_id,
                    address,
                    requested_size: size,
                    data,
                };

                if let Err(e) = handle.emit("memory-read-updated", &result) {
                    error!("Failed to emit memory-read-updated event: {}", e);
                } else {
                    debug!("📡 Emitted memory-read-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to read memory at 0x{:X}: {}", address, e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryReadError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-read-error", &error_result) {
                    error!("Failed to emit memory-read-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory write request and emits results to the frontend
pub(crate) fn process_memory_write(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    data: &[u8],
) {
    let pid = event.pid();
    debug!("📤 Processing memory write request: pid={}, address=0x{:X}, size={}", pid, address, data.len());

    match session.write_memory(pid, address, data.to_vec()) {
        Ok(_) => {
            debug!("📥 Successfully wrote {} bytes to memory", data.len());

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryWriteResult {
                    session_id,
                    address,
                    success: true,
                    bytes_written: data.len(),
                };

                if let Err(e) = handle.emit("memory-write-result", &result) {
                    error!("Failed to emit memory-write-result event: {}", e);
                } else {
                    debug!("📡 Emitted memory-write-result event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to write memory: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryWriteError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-write-error", &error_result) {
                    error!("Failed to emit memory-write-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory regions request and emits results to the frontend
pub(crate) fn process_memory_regions_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    debug!("📤 Processing memory regions request: pid={}", pid);

    match session.enumerate_memory_regions(pid) {
        Ok(regions) => {
            debug!("📥 Received {} memory regions", regions.len());

            let serializable_regions: Vec<SerializableMemoryRegion> = regions
                .iter()
                .map(|r| SerializableMemoryRegion {
                    base_address: format!("0x{:016X}", r.base_address),
                    allocation_base: format!("0x{:016X}", r.allocation_base),
                    region_size: r.region_size,
                    region_size_formatted: format_bytes(r.region_size),
                    state: joybug2::formatting::memory::state_to_str(r.state).to_string(),
                    state_raw: r.state,
                    protect: joybug2::formatting::memory::protect_to_str(r.protect).to_string(),
                    protect_raw: r.protect,
                    region_type: joybug2::formatting::memory::type_to_str(r.region_type).to_string(),
                    type_raw: r.region_type,
                })
                .collect();

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryRegionsResult {
                    session_id,
                    regions: serializable_regions,
                };

                if let Err(e) = handle.emit("memory-regions-updated", &result) {
                    error!("Failed to emit memory-regions-updated event: {}", e);
                } else {
                    debug!("📡 Emitted memory-regions-updated event with {} regions", result.regions.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to enumerate memory regions: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryRegionsError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-regions-error", &error_result) {
                    error!("Failed to emit memory-regions-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory search request and emits results to the frontend
pub(crate) fn process_memory_search(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    pattern: Vec<u8>,
    max_results: usize,
) {
    let pid = event.pid();
    debug!("📤 Processing memory search request: pid={}, pattern_len={}, max_results={}", pid, pattern.len(), max_results);

    match session.search_memory(pid, pattern, max_results) {
        Ok((addresses, capped)) => {
            debug!("📥 Memory search found {} addresses (capped={})", addresses.len(), capped);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemorySearchResult {
                    session_id,
                    addresses: addresses.iter().map(|a| format!("0x{:016X}", a)).collect(),
                    capped,
                };

                if let Err(e) = handle.emit("memory-search-result", &result) {
                    error!("Failed to emit memory-search-result event: {}", e);
                } else {
                    debug!("📡 Emitted memory-search-result event with {} addresses", result.addresses.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to search memory: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemorySearchError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-search-error", &error_result) {
                    error!("Failed to emit memory-search-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a dereference request and emits results to the frontend
pub(crate) fn process_dereference_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    count: usize,
) {
    let pid = event.pid();
    debug!("📤 Processing dereference request: pid={}, address=0x{:X}, count={}", pid, address, count);

    match session.dereference(pid, address, count, None) {
        Ok(entries) => {
            debug!("📥 Received {} dereference entries", entries.len());

            let serializable_entries: Vec<SerializableDereferenceEntry> = entries
                .iter()
                .map(|entry| {
                    let chain: Vec<SerializableDereferenceValue> = entry.chain.iter().map(|v| {
                        match v {
                            joybug2::protocol::DereferenceValue::Pointer(addr, sym) => {
                                SerializableDereferenceValue::Pointer {
                                    address: format!("0x{:016X}", addr),
                                    symbol: sym.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::Value(val) => {
                                SerializableDereferenceValue::Value {
                                    value: format!("0x{:X}", val),
                                }
                            }
                            joybug2::protocol::DereferenceValue::String(s) => {
                                SerializableDereferenceValue::String {
                                    value: s.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::Instruction(instr, sym) => {
                                SerializableDereferenceValue::Instruction {
                                    value: instr.clone(),
                                    symbol: sym.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::LoopDetected(addr) => {
                                SerializableDereferenceValue::LoopDetected {
                                    address: format!("0x{:016X}", addr),
                                }
                            }
                        }
                    }).collect();

                    SerializableDereferenceEntry {
                        address: format!("0x{:016X}", entry.address),
                        offset: entry.offset,
                        chain,
                    }
                })
                .collect();

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = DereferenceResult {
                    session_id,
                    base_address: format!("0x{:016X}", address),
                    entries: serializable_entries,
                };

                if let Err(e) = handle.emit("dereference-updated", &result) {
                    error!("Failed to emit dereference-updated event: {}", e);
                } else {
                    debug!("📡 Emitted dereference-updated event with {} entries", result.entries.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to dereference at 0x{:X}: {}", address, e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = DereferenceError {
                    session_id,
                    address: format!("0x{:016X}", address),
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("dereference-error", &error_result) {
                    error!("Failed to emit dereference-error event: {}", emit_err);
                }
            }
        }
    }
}

fn parse_scan_value_type(s: &str) -> joybug2::protocol::ScanValueType {
    match s {
        "U8" => joybug2::protocol::ScanValueType::U8,
        "U16" => joybug2::protocol::ScanValueType::U16,
        "U32" => joybug2::protocol::ScanValueType::U32,
        "U64" => joybug2::protocol::ScanValueType::U64,
        "F32" => joybug2::protocol::ScanValueType::F32,
        "F64" => joybug2::protocol::ScanValueType::F64,
        _ => joybug2::protocol::ScanValueType::U32,
    }
}

fn parse_scan_compare_type(s: &str) -> joybug2::protocol::ScanCompareType {
    match s {
        "ExactValue" => joybug2::protocol::ScanCompareType::ExactValue,
        "UnknownInitialValue" => joybug2::protocol::ScanCompareType::UnknownInitialValue,
        "BiggerThan" => joybug2::protocol::ScanCompareType::BiggerThan,
        "SmallerThan" => joybug2::protocol::ScanCompareType::SmallerThan,
        "ValueBetween" => joybug2::protocol::ScanCompareType::ValueBetween,
        "IncreasedValue" => joybug2::protocol::ScanCompareType::IncreasedValue,
        "DecreasedValue" => joybug2::protocol::ScanCompareType::DecreasedValue,
        "IncreasedValueBy" => joybug2::protocol::ScanCompareType::IncreasedValueBy,
        "DecreasedValueBy" => joybug2::protocol::ScanCompareType::DecreasedValueBy,
        "Changed" => joybug2::protocol::ScanCompareType::Changed,
        "Unchanged" => joybug2::protocol::ScanCompareType::Unchanged,
        _ => joybug2::protocol::ScanCompareType::ExactValue,
    }
}

fn parse_scan_value(value_type: joybug2::protocol::ScanValueType, s: &str) -> Option<joybug2::protocol::ScanValue> {
    use joybug2::protocol::{ScanValue, ScanValueType};
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let is_hex = s.starts_with("0x") || s.starts_with("0X");
    match value_type {
        ScanValueType::U8 => {
            let v = if is_hex { u8::from_str_radix(&s[2..], 16).ok()? } else { s.parse().ok()? };
            Some(ScanValue::U8(v))
        }
        ScanValueType::U16 => {
            let v = if is_hex { u16::from_str_radix(&s[2..], 16).ok()? } else { s.parse().ok()? };
            Some(ScanValue::U16(v))
        }
        ScanValueType::U32 => {
            let v = if is_hex { u32::from_str_radix(&s[2..], 16).ok()? } else { s.parse().ok()? };
            Some(ScanValue::U32(v))
        }
        ScanValueType::U64 => {
            let v = if is_hex { u64::from_str_radix(&s[2..], 16).ok()? } else { s.parse().ok()? };
            Some(ScanValue::U64(v))
        }
        ScanValueType::F32 => {
            let v: f32 = s.parse().ok()?;
            Some(ScanValue::F32(v))
        }
        ScanValueType::F64 => {
            let v: f64 = s.parse().ok()?;
            Some(ScanValue::F64(v))
        }
    }
}

fn format_scan_value(val: &joybug2::protocol::ScanValue) -> ScanValueEntry {
    use joybug2::protocol::ScanValue;
    match val {
        ScanValue::U8(v) => ScanValueEntry { value_type: "U8".to_string(), display: format!("{} (0x{:02X})", v, v) },
        ScanValue::U16(v) => ScanValueEntry { value_type: "U16".to_string(), display: format!("{} (0x{:04X})", v, v) },
        ScanValue::U32(v) => ScanValueEntry { value_type: "U32".to_string(), display: format!("{} (0x{:08X})", v, v) },
        ScanValue::U64(v) => ScanValueEntry { value_type: "U64".to_string(), display: format!("{} (0x{:016X})", v, v) },
        ScanValue::F32(v) => ScanValueEntry { value_type: "F32".to_string(), display: format!("{}", v) },
        ScanValue::F64(v) => ScanValueEntry { value_type: "F64".to_string(), display: format!("{}", v) },
    }
}

fn emit_scan_error(handle: &AppHandle, session_id: String, error: impl std::fmt::Display) {
    let err = ScanError { session_id, error: error.to_string() };
    let _ = handle.emit("scan-memory-error", &err);
}

/// Processes a scan memory start request
pub(crate) fn process_scan_memory_start(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    value_type_str: &str,
    compare_type_str: &str,
    value: Option<String>,
    value2: Option<String>,
    alignment: Option<usize>,
    float_tolerance: Option<f64>,
    writable_only: bool,
) {
    let pid = event.pid();
    let vt = parse_scan_value_type(value_type_str);
    let ct = parse_scan_compare_type(compare_type_str);
    let val = value.as_deref().and_then(|s| parse_scan_value(vt, s));
    let val2 = value2.as_deref().and_then(|s| parse_scan_value(vt, s));

    debug!("📤 Processing scan memory start: pid={}, type={:?}, compare={:?}", pid, vt, ct);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    match session.scan_memory_start(pid, vt, ct, val, val2, alignment, float_tolerance, writable_only) {
        Ok((scan_id, match_count, scan_time_us)) => {
            info!("📥 Scan started: scan_id={}, matches={}, time={}μs", scan_id, match_count, scan_time_us);
            let result = ScanMatchResult { session_id, scan_id, match_count, scan_time_us };
            if let Err(e) = handle.emit("scan-memory-start-result", &result) {
                error!("Failed to emit scan-memory-start-result: {}", e);
            }
        }
        Err(e) => {
            error!("Scan memory start failed: {}", e);
            emit_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a scan memory next request
pub(crate) fn process_scan_memory_next(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    scan_id: u64,
    value_type_str: &str,
    compare_type_str: &str,
    value: Option<String>,
    value2: Option<String>,
) {
    let vt = parse_scan_value_type(value_type_str);
    let ct = parse_scan_compare_type(compare_type_str);
    let val = value.as_deref().and_then(|s| parse_scan_value(vt, s));
    let val2 = value2.as_deref().and_then(|s| parse_scan_value(vt, s));

    debug!("📤 Processing scan memory next: scan_id={}, compare={:?}", scan_id, ct);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    match session.scan_memory_next(scan_id, ct, val, val2) {
        Ok((match_count, scan_time_us)) => {
            info!("📥 Scan next: scan_id={}, matches={}, time={}μs", scan_id, match_count, scan_time_us);
            let result = ScanMatchResult { session_id, scan_id, match_count, scan_time_us };
            if let Err(e) = handle.emit("scan-memory-next-result", &result) {
                error!("Failed to emit scan-memory-next-result: {}", e);
            }
        }
        Err(e) => {
            error!("Scan memory next failed: {}", e);
            emit_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a scan memory get results request
pub(crate) fn process_scan_memory_get_results(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    scan_id: u64,
    offset: u64,
    count: u64,
) {
    debug!("📤 Processing scan memory get results: scan_id={}, offset={}, count={}", scan_id, offset, count);

    let Some(ref handle) = app_handle_clone else { return };
    let session_id = session.state.lock().unwrap().id.clone();

    match session.scan_memory_get_results(scan_id, offset, count) {
        Ok((addresses, values, total_count)) => {
            debug!("📥 Scan results: {} addresses, total={}", addresses.len(), total_count);
            let result = ScanResultsPayload {
                session_id,
                scan_id,
                addresses: addresses.iter().map(|a| format!("0x{:016X}", a)).collect(),
                values: values.iter().map(format_scan_value).collect(),
                total_count,
            };
            if let Err(e) = handle.emit("scan-memory-results", &result) {
                error!("Failed to emit scan-memory-results: {}", e);
            }
        }
        Err(e) => {
            error!("Scan memory get results failed: {}", e);
            emit_scan_error(handle, session_id, e);
        }
    }
}

/// Processes a scan memory reset request
pub(crate) fn process_scan_memory_reset(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    scan_id: u64,
) {
    debug!("📤 Processing scan memory reset: scan_id={}", scan_id);

    if let Err(e) = session.scan_memory_reset(scan_id) {
        error!("Scan memory reset failed: {}", e);
        if let Some(ref handle) = app_handle_clone {
            let session_id = session.state.lock().unwrap().id.clone();
            emit_scan_error(handle, session_id, e);
        }
    } else {
        debug!("📥 Scan reset complete for scan_id={}", scan_id);
    }
}

/// Processes a batch dereference request (multiple addresses in one command) and emits individual results.
pub(crate) fn process_dereference_batch(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    addresses: &[u64],
) {
    for &address in addresses {
        process_dereference_request(session, app_handle_clone, event, address, 1);
    }
}
