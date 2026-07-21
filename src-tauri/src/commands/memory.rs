use crate::error::Result;
use crate::session::memory::{
    process_dereference_batch, process_dereference_request, process_memory_read,
    process_memory_regions_request, process_memory_search, process_memory_write,
};
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn request_memory_read(
    session_id: String,
    address: u64,
    size: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // Both the paused loop and the OOB fallback run `process_memory_read`, which
    // emits `memory-read-updated`/`-error` on either path.
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::ReadMemory { address, size },
        |client, pid| process_memory_read(client, &handle, pid, address, size),
    )
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
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::WriteMemory { address, data: data.clone() },
        move |client, pid| process_memory_write(client, &handle, pid, address, &data),
    )
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
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::GetMemoryRegions,
        |client, pid| process_memory_regions_request(client, &handle, pid),
    )
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
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::SearchMemory { pattern: pattern.clone(), max_results },
        move |client, pid| process_memory_search(client, &handle, pid, pattern, max_results),
    )
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
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::Dereference { address, count },
        |client, pid| process_dereference_request(client, &handle, pid, address, count),
    )
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
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::DereferenceBatch { addresses: addresses.clone() },
        move |client, pid| process_dereference_batch(client, &handle, pid, &addresses),
    )
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
