use crate::error::Result;
use crate::session::helpers::format_bytes;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::{Emitter, State};
use tracing::{error, info};

#[tauri::command]
pub fn request_memory_read(
    session_id: String,
    address: u64,
    size: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::ReadMemory { address, size }) {
        Ok(()) => {
            info!("Memory read request sent for session {} at 0x{:X}, size {}", session_id, address, size);
        }
        Err(_) => {
            let read = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.read_memory(pid, address, size));
            match super::flatten_oob(read) {
                Ok(data) => {
                    let result = crate::session::types::MemoryReadResult {
                        session_id: session_id.clone(), address, requested_size: size, data,
                    };
                    let _ = app_handle.emit("memory-read-updated", &result);
                }
                Err(e) => {
                    error!("OOB memory read failed: {}", e);
                    let _ = app_handle.emit("memory-read-error", &crate::session::types::MemoryReadError {
                        session_id: session_id.clone(), address, error: e,
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_memory_write(
    session_id: String,
    address: u64,
    data: Vec<u8>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::WriteMemory { address, data: data.clone() }) {
        Ok(()) => {
            info!("Memory write request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let written = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.write_memory(pid, address, data.clone()));
            match super::flatten_oob(written) {
                Ok(_) => {
                    let result = crate::session::types::MemoryWriteResult {
                        session_id: session_id.clone(), address, success: true, bytes_written: data.len(),
                    };
                    let _ = app_handle.emit("memory-write-result", &result);
                    info!("OOB memory write for session {} at 0x{:X}", session_id, address);
                }
                Err(e) => {
                    error!("OOB memory write failed: {}", e);
                    let _ = app_handle.emit("memory-write-error", &crate::session::types::MemoryWriteError {
                        session_id: session_id.clone(), address, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

/// Read a small chunk at each address in one call over the pooled live OOB
/// connection (works Paused, Running, and non-invasive Open). Returns bytes
/// per address, None where unreadable. Used by result lists (memory search)
/// for live byte previews, bypassing the event-based single-read path.
#[tauri::command]
pub fn read_memory_batch(
    session_id: String,
    addresses: Vec<String>,
    size: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<Option<Vec<u8>>>> {
    let size = size.clamp(1, 64);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        addresses
            .iter()
            .take(256)
            .map(|s| {
                super::parse_hex_u64(s, "address")
                    .ok()
                    .and_then(|addr| client.read_memory(pid, addr, size).ok())
            })
            .collect()
    })
}

/// Read `size` bytes at a hex `address` over the pooled OOB client, returning the
/// bytes in the command result ("sync") instead of via an event. Unlike
/// `read_memory_batch` (capped at 64 bytes), this supports arbitrary sizes — used
/// to read a whole struct blob for the type overlay. `None` when the read fails
/// (e.g. unmapped page). Async so the socket round-trip stays off the main thread —
/// the type overlay calls this per node on a 500ms cadence.
#[tauri::command]
pub async fn read_memory_sync(
    session_id: String,
    address: String,
    size: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Option<Vec<u8>>> {
    let addr = super::parse_hex_u64(&address, "address")?;
    let size = size.clamp(1, 1024 * 1024);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        client.read_memory(pid, addr, size)
    });
    Ok(super::flatten_oob(result).ok())
}

#[tauri::command]
pub fn request_set_register(
    session_id: String,
    register_name: String,
    value: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let value = super::parse_hex_u64(&value, "hex value")?;

    super::send_paused_command(&session_id, &session_states, UICommand::SetRegister { register_name: register_name.clone(), value })?;
    info!("Set register request sent for session {}: {} = 0x{:X}", session_id, register_name, value);
    Ok(())
}

#[tauri::command]
pub fn request_memory_regions(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::GetMemoryRegions) {
        Ok(()) => {
            info!("Memory regions request sent for session {}", session_id);
        }
        Err(_) => {
            let enumerated = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.enumerate_memory_regions(pid));
            match super::flatten_oob(enumerated) {
                Ok(regions) => {
                    let serializable_regions: Vec<crate::session::types::SerializableMemoryRegion> = regions.iter().map(|r| {
                        crate::session::types::SerializableMemoryRegion {
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
                        }
                    }).collect();
                    let result = crate::session::types::MemoryRegionsResult {
                        session_id: session_id.clone(), regions: serializable_regions,
                    };
                    let _ = app_handle.emit("memory-regions-updated", &result);
                    info!("OOB memory regions for session {}", session_id);
                }
                Err(e) => {
                    error!("OOB memory regions failed: {}", e);
                    let _ = app_handle.emit("memory-regions-error", &crate::session::types::MemoryRegionsError {
                        session_id: session_id.clone(), error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_memory_search(
    session_id: String,
    pattern: Vec<u8>,
    max_results: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::SearchMemory { pattern: pattern.clone(), max_results }) {
        Ok(()) => {
            info!("Memory search request sent for session {}", session_id);
        }
        Err(_) => {
            let searched = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.search_memory(pid, pattern, max_results));
            match super::flatten_oob(searched) {
                Ok((addresses, capped)) => {
                    let result = crate::session::types::MemorySearchResult {
                        session_id: session_id.clone(),
                        addresses: addresses.iter().map(|a| format!("0x{:016X}", a)).collect(),
                        capped,
                    };
                    let _ = app_handle.emit("memory-search-result", &result);
                    info!("OOB memory search for session {}", session_id);
                }
                Err(e) => {
                    error!("OOB memory search failed: {}", e);
                    let _ = app_handle.emit("memory-search-error", &crate::session::types::MemorySearchError {
                        session_id: session_id.clone(), error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_dereference(
    session_id: String,
    address: String,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::Dereference { address, count }) {
        Ok(()) => {
            info!("Dereference request sent for session {} at 0x{:X}, count {}", session_id, address, count);
        }
        Err(_) => {
            let derefed = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.dereference(pid, address, count, None));
            match super::flatten_oob(derefed) {
                Ok(entries) => {
                    let result = crate::session::types::DereferenceResult {
                        session_id: session_id.clone(),
                        base_address: format!("0x{:016X}", address),
                        entries: crate::session::memory::serialize_dereference_entries(&entries),
                    };
                    let _ = app_handle.emit("dereference-updated", &result);
                    info!("OOB dereference for session {} at 0x{:X}", session_id, address);
                }
                Err(e) => {
                    error!("OOB dereference failed: {}", e);
                    let _ = app_handle.emit("dereference-error", &crate::session::types::DereferenceError {
                        session_id: session_id.clone(),
                        address: format!("0x{:016X}", address),
                        error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_dereference_batch(
    session_id: String,
    addresses: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let parsed: std::result::Result<Vec<u64>, _> = addresses
        .iter()
        .map(|a| super::parse_hex_u64(a, "address"))
        .collect();
    let addresses = parsed?;

    let count = addresses.len();
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::DereferenceBatch { addresses: addresses.clone() }) {
        Ok(()) => {
            info!("Batch dereference request sent for session {} with {} addresses", session_id, count);
        }
        Err(_) => {
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
                for &addr in &addresses {
                    match oob.dereference(pid, addr, 1, None) {
                        Ok(entries) => {
                            let result = crate::session::types::DereferenceResult {
                                session_id: session_id.clone(),
                                base_address: format!("0x{:016X}", addr),
                                entries: crate::session::memory::serialize_dereference_entries(&entries),
                            };
                            let _ = app_handle.emit("dereference-updated", &result);
                        }
                        Err(e) => {
                            error!("OOB batch dereference failed for 0x{:X}: {}", addr, e);
                            let _ = app_handle.emit("dereference-error", &crate::session::types::DereferenceError {
                                session_id: session_id.clone(),
                                address: format!("0x{:016X}", addr),
                                error: e.to_string(),
                            });
                        }
                    }
                }
            })?;
            info!("OOB batch dereference for session {} with {} addresses", session_id, count);
        }
    }
    Ok(())
}

// --- Memory scan & pointer scan ---
//
// These are stateful, multi-step flows whose server-side scanner state lives on a
// single TCP connection. They always run over the session's dedicated scan-pool
// connection (`with_oob_scan_client`) — never the paused loop channel — so the
// whole start→next→get_results flow stays on one connection that survives
// pause↔resume and works identically in non-invasive (Open) sessions. The shared
// `process_*` helpers emit the same events the debug loop would.

use crate::session::memory::{
    process_scan_memory_get_results, process_scan_memory_next, process_scan_memory_reset,
    process_scan_memory_start,
};
use crate::session::pointer_scan::{
    process_pointer_scan_apply_filter, process_pointer_scan_get_results,
    process_pointer_scan_rescan, process_pointer_scan_reset, process_pointer_scan_start,
};
use crate::session::string_scan::{
    process_string_scan_get_results, process_string_scan_reset, process_string_scan_start,
};

/// Scanner thread count from settings; `0` (the default) means "all cores",
/// mapped to `None` for the scanner.
fn scan_thread_count(settings: &crate::settings::SettingsState) -> Option<usize> {
    match settings.lock().map(|s| s.scan_thread_count).unwrap_or(0) {
        0 => None,
        n => Some(n),
    }
}

#[tauri::command]
pub fn request_scan_memory_start(
    session_id: String,
    value_type: String,
    compare_type: String,
    value: Option<String>,
    value2: Option<String>,
    alignment: Option<usize>,
    float_tolerance: Option<f64>,
    writable_only: bool,
    session_states: State<'_, SessionStatesMap>,
    settings: State<'_, crate::settings::SettingsState>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let thread_count = scan_thread_count(&settings);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        process_scan_memory_start(client, &app_handle, pid, &value_type, &compare_type, value, value2, alignment, float_tolerance, writable_only, thread_count);
    })?;
    info!("Scan memory start processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_scan_memory_next(
    session_id: String,
    scan_id: u64,
    value_type: String,
    compare_type: String,
    value: Option<String>,
    value2: Option<String>,
    float_tolerance: Option<f64>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_scan_memory_next(client, &app_handle, scan_id, &value_type, &compare_type, value, value2, float_tolerance);
    })?;
    info!("Scan memory next processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_scan_memory_get_results(
    session_id: String,
    scan_id: u64,
    offset: u64,
    count: u64,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_scan_memory_get_results(client, &app_handle, scan_id, offset, count);
    })?;
    info!("Scan memory get results processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_scan_memory_reset(
    session_id: String,
    scan_id: u64,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_scan_memory_reset(client, &app_handle, scan_id);
    })?;
    info!("Scan memory reset processed for session {}", session_id);
    Ok(())
}

// --- Pointer Scan ---

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn request_pointer_scan_start(
    session_id: String,
    target_address: u64,
    max_offset: u64,
    max_depth: u32,
    max_results: Option<u64>,
    modules: Option<Vec<u64>>,
    writable_only: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        process_pointer_scan_start(client, &app_handle, pid, target_address, max_offset, max_depth, max_results, modules, writable_only);
    })?;
    info!("Pointer scan start processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_pointer_scan_get_results(
    session_id: String,
    results_path: String,
    offset: u64,
    count: u64,
    offset_filter: Vec<u64>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        process_pointer_scan_get_results(client, &app_handle, pid, results_path, offset, count, offset_filter);
    })?;
    info!("Pointer scan get results processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_pointer_scan_reset(
    session_id: String,
    results_path: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_pointer_scan_reset(client, &app_handle, results_path);
    })?;
    info!("Pointer scan reset processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_pointer_scan_apply_filter(
    session_id: String,
    results_path: String,
    offset_filter: Vec<u64>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_pointer_scan_apply_filter(client, &app_handle, results_path, offset_filter);
    })?;
    info!("Pointer scan apply-filter processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_pointer_scan_rescan(
    session_id: String,
    results_path: String,
    target_address: u64,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        process_pointer_scan_rescan(client, &app_handle, pid, results_path, target_address);
    })?;
    info!("Pointer scan rescan processed for session {} (target 0x{:X})", session_id, target_address);
    Ok(())
}

// --- String Scan ---

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn request_string_scan_start(
    session_id: String,
    // `None` span bounds mean "the whole address space" — JS numbers can't
    // carry u64::MAX exactly, so the frontend omits them instead.
    start_address: Option<u64>,
    size: Option<u64>,
    min_length: u32,
    region_filter: String,
    encodings: String,
    contains: String,
    session_states: State<'_, SessionStatesMap>,
    settings: State<'_, crate::settings::SettingsState>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let thread_count = scan_thread_count(&settings);
    let start_address = start_address.unwrap_or(0);
    let size = size.unwrap_or(u64::MAX);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, pid| {
        process_string_scan_start(
            client, &app_handle, pid, start_address, size, min_length, thread_count,
            &region_filter, &encodings, contains,
        );
    })?;
    info!("String scan start processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn request_string_scan_get_results(
    session_id: String,
    results_path: String,
    offset: u64,
    count: u64,
    filter: String,
    sort_key: String,
    ascending: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_string_scan_get_results(client, &app_handle, results_path, offset, count, filter, &sort_key, ascending);
    })?;
    info!("String scan get results processed for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_string_scan_reset(
    session_id: String,
    results_path: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::with_oob_scan_client(&session_arc, &session_id, &oob_pool, |client, _pid| {
        process_string_scan_reset(client, &app_handle, results_path);
    })?;
    info!("String scan reset processed for session {}", session_id);
    Ok(())
}
