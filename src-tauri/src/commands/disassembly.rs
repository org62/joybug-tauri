use crate::error::Result;
use crate::session::disassembly::{process_disassembly_backward_request, process_disassembly_request, process_function_disassembly_request};
use crate::session::symbols::process_module_extra_info_request;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use super::types::{ModuleData, ThreadData};
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    compare_image: bool,
    request_id: Option<String>,
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
        UICommand::Disassembly { arch, address, count: count as u32, compare_image, request_id: request_id.clone() },
        |client, pid| process_disassembly_request(client, &handle, pid, arch, address, count as u32, compare_image, request_id.clone()),
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
    // Keep transport failure distinct from a target-side query failure. A
    // successful empty inventory is authoritative, never a reason to use cache.
    use joybug_core::protocol::{DebuggerRequest, DebuggerResponse};
    let response = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| {
        oob.send_and_receive(&DebuggerRequest::ListThreads { pid })
    });
    let mut threads: Vec<ThreadData> = match response {
        Ok(Ok(DebuggerResponse::ThreadList { threads })) => threads.iter().map(ThreadData::from).collect(),
        Ok(Ok(DebuggerResponse::Error { message })) => return Err(crate::error::Error::TargetOperation(message)),
        Ok(Ok(_)) => return Err(crate::error::Error::InternalCommunication("Unexpected ListThreads response".into())),
        // No connection/answer: retain cached identities and actual Entry only.
        // Every sampled field must be unavailable rather than a stale value.
        Ok(Err(_)) | Err(_) => session_arc.lock().unwrap().threads.iter().map(|t| {
            ThreadData::from(&joybug_core::protocol_io::ThreadInfo {
                tid: t.tid,
                start_address: t.start_address,
                ..Default::default()
            })
        }).collect(),
    };
    // Sort by tid: the OOB list comes from a `HashMap` on the core side, so its
    // order is arbitrary and reshuffles as threads come and go. Rows would then
    // jump around under the cursor between polls (and the panel's first row
    // would not be a stable thing to point at).
    threads.sort_by_key(|t| t.id);
    Ok(threads)
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
