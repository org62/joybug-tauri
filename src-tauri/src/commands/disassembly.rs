use crate::error::Result;
use crate::session::disassembly::{process_disassembly_backward_request, process_disassembly_request, process_function_disassembly_request};
use crate::session::symbols::process_module_extra_info_request;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use super::types::{ModuleData, ThreadData, ThreadTebData};
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    compare_image: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Disassembly request for session {} at 0x{:X}", session_id, address);
    let arch = super::get_session_arch(&super::get_session_arc(&session_id, &session_states)?);
    let handle = Some(app_handle);
    // Same processing on both paths: the paused loop and the OOB fallback (running
    // or non-invasive Open) run `process_disassembly_request`, which emits the
    // `disassembly-updated`/`-error` events either way.
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::Disassembly { arch, address, count: count as u32, compare_image },
        |client, pid| process_disassembly_request(client, &handle, pid, arch, address, count as u32, compare_image),
    )
}

#[tauri::command]
pub fn request_function_disassembly(
    session_id: String,
    address: u64,
    max_instructions: usize,
    compare_image: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Function disassembly request for session {} at 0x{:X}", session_id, address);
    let arch = super::get_session_arch(&super::get_session_arc(&session_id, &session_states)?);
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::DisassembleFunction { arch, address, max_instructions: max_instructions as u32, compare_image },
        |client, pid| process_function_disassembly_request(client, &handle, pid, arch, address, max_instructions as u32, compare_image),
    )
}

#[tauri::command]
pub fn request_disassembly_backward(
    session_id: String,
    target: u64,
    count: usize,
    compare_image: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Backward disassembly request for session {} at 0x{:X} (count {})", session_id, target, count);
    let arch = super::get_session_arch(&super::get_session_arc(&session_id, &session_states)?);
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::DisassembleBackward { arch, target, count: count as u32, compare_image },
        |client, pid| process_disassembly_backward_request(client, &handle, pid, arch, target, count as u32, compare_image),
    )
}

#[tauri::command]
pub fn get_session_modules(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<ModuleData>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    // Polled every second while live — map the cached list under the lock instead
    // of cloning the whole Vec, and only fall back to OOB when the cache is empty.
    let to_data = |module: &joybug_core::protocol_io::ModuleInfo| ModuleData {
        name: module.name.clone(),
        base_address: format!("0x{:X}", module.base),
        size: module.size.unwrap_or(0),
        path: module.name.clone(),
    };
    let cached: Vec<ModuleData> = { session_arc.lock().unwrap().modules.iter().map(to_data).collect() };
    if !cached.is_empty() {
        return Ok(cached);
    }
    let modules = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.list_modules(pid).unwrap_or_default())
        .unwrap_or_default();
    Ok(modules.iter().map(to_data).collect())
}

#[tauri::command]
pub fn get_session_threads(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<ThreadData>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    // Same polled pattern as get_session_modules: map under the lock, no Vec clone.
    let to_data = |thread: &joybug_core::protocol_io::ThreadInfo| ThreadData {
        id: thread.tid,
        status: "Running".to_string(),
        start_address: format!("0x{:X}", thread.start_address),
    };
    let cached: Vec<ThreadData> = { session_arc.lock().unwrap().threads.iter().map(to_data).collect() };
    if !cached.is_empty() {
        return Ok(cached);
    }
    let threads = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.list_threads(pid).unwrap_or_default())
        .unwrap_or_default();
    Ok(threads.iter().map(to_data).collect())
}

/// Per-thread TEB base addresses — anchors for overlaying `_TEB` on a specific thread.
/// Runs over OOB (like `get_session_teb_peb`), so it works while Paused, Running, or
/// non-invasively Open. Threads whose TEB can't be read (e.g. terminated) yield `teb: None`.
#[tauri::command]
pub fn get_session_thread_tebs(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<ThreadTebData>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let tids: Vec<u32> = { session_arc.lock().unwrap().threads.iter().map(|t| t.tid).collect() };
    super::with_oob_client(&session_arc, &session_id, &oob_pool, move |client, pid| {
        // Non-invasive Open sessions never populate the cached thread list —
        // same OOB fallback as get_session_threads.
        let tids = if tids.is_empty() {
            client
                .list_threads(pid)
                .map(|ts| ts.iter().map(|t| t.tid).collect())
                .unwrap_or_default()
        } else {
            tids
        };
        tids.into_iter()
            .map(|tid| ThreadTebData {
                tid,
                teb: client.get_teb_address(pid, tid).ok().map(|a| format!("0x{:X}", a)),
            })
            .collect()
    })
}

#[tauri::command]
pub fn request_module_extra_info(
    session_id: String,
    module_base: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let module_base_val = super::parse_hex_u64(&module_base, "module base")?;
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::GetModuleExtraInfo { module_base: module_base_val },
        |client, pid| process_module_extra_info_request(client, &handle, pid, module_base_val),
    )
}
