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
