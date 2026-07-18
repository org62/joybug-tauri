use crate::error::Result;
use crate::session::disassembly::{applied_patch_ranges, serialize_instructions, DisassemblyBackwardError, DisassemblyBackwardResult};
use crate::session::types::SerializableInstruction;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use super::types::{ModuleData, ThreadData, ThreadTebData};
use tauri::{Emitter, State};
use tracing::{debug, error, info};

#[tauri::command]
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Disassembly request for session {} at 0x{:X}", session_id, address);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let arch = super::get_session_arch(&session_arc);

    match super::try_send_paused_command(&session_arc, UICommand::Disassembly { arch, address, count: count as u32 }) {
        Ok(()) => {
            info!("Disassembly request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let (modules, patched_ranges) = {
                let state = session_arc.lock().unwrap();
                (state.modules.clone(), applied_patch_ranges(&state))
            };
            let disasm = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.disassemble_memory(pid, address, count, arch));
            // A session that stopped between request and dispatch can't serve this.
            // Still emit the error event (the frontend filters it as benign) so the
            // view's in-flight/loading state is always released.
            match super::flatten_oob(disasm) {
                Ok(instructions) => {
                    let serializable = serialize_instructions(&instructions, &modules, &patched_ranges);
                    #[derive(serde::Serialize)]
                    struct DisassemblyResult {
                        session_id: String,
                        address: u64,
                        instructions: Vec<SerializableInstruction>,
                    }
                    let result = DisassemblyResult { session_id: session_id.clone(), address, instructions: serializable };
                    let _ = app_handle.emit("disassembly-updated", &result);
                    info!("OOB disassembly for session {} at 0x{:X}", session_id, address);
                }
                Err(e) => {
                    error!("OOB disassembly failed: {}", e);
                    #[derive(serde::Serialize)]
                    struct DisassemblyError { session_id: String, address: u64, error: String }
                    let _ = app_handle.emit("disassembly-error", &DisassemblyError {
                        session_id: session_id.clone(), address, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_function_disassembly(
    session_id: String,
    address: u64,
    max_instructions: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Function disassembly request for session {} at 0x{:X}", session_id, address);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let arch = super::get_session_arch(&session_arc);

    match super::try_send_paused_command(&session_arc, UICommand::DisassembleFunction { arch, address, max_instructions: max_instructions as u32 }) {
        Ok(()) => {
            info!("Function disassembly request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let (modules, patched_ranges) = {
                let state = session_arc.lock().unwrap();
                (state.modules.clone(), applied_patch_ranges(&state))
            };
            let disasm = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.disassemble_function(pid, address, max_instructions, arch));
            // A session that stopped between request and dispatch can't serve this.
            // Still emit the error event (the frontend filters it as benign) so the
            // view's in-flight/loading state is always released.
            match super::flatten_oob(disasm) {
                Ok((instructions, function_start, function_end, function_name)) => {
                    let serializable = serialize_instructions(&instructions, &modules, &patched_ranges);
                    #[derive(serde::Serialize)]
                    struct FunctionDisassemblyResult {
                        session_id: String,
                        address: u64,
                        instructions: Vec<SerializableInstruction>,
                        function_start: Option<String>,
                        function_end: Option<String>,
                        function_name: Option<String>,
                    }
                    let result = FunctionDisassemblyResult {
                        session_id: session_id.clone(), address, instructions: serializable,
                        function_start: function_start.map(|a| format!("{:#X}", a)),
                        function_end: function_end.map(|a| format!("{:#X}", a)),
                        function_name,
                    };
                    let _ = app_handle.emit("function-disassembly-updated", &result);
                    info!("OOB function disassembly for session {} at 0x{:X}", session_id, address);
                }
                Err(e) => {
                    error!("OOB function disassembly failed: {}", e);
                    #[derive(serde::Serialize)]
                    struct FunctionDisassemblyError { session_id: String, address: u64, error: String }
                    let _ = app_handle.emit("function-disassembly-error", &FunctionDisassemblyError {
                        session_id: session_id.clone(), address, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn request_disassembly_backward(
    session_id: String,
    target: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    debug!("Backward disassembly request for session {} at 0x{:X} (count {})", session_id, target, count);
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let arch = super::get_session_arch(&session_arc);

    match super::try_send_paused_command(&session_arc, UICommand::DisassembleBackward { arch, target, count: count as u32 }) {
        Ok(()) => {
            info!("Backward disassembly request sent for session {} at 0x{:X}", session_id, target);
        }
        Err(_) => {
            let (modules, patched_ranges) = {
                let state = session_arc.lock().unwrap();
                (state.modules.clone(), applied_patch_ranges(&state))
            };
            let disasm = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.disassemble_backward(pid, target, count, arch));
            // A session that stopped between request and dispatch can't serve this.
            // Still emit the (benign-filtered) error event so the view's loading state releases.
            match super::flatten_oob(disasm) {
                Ok(instructions) => {
                    let serializable = serialize_instructions(&instructions, &modules, &patched_ranges);
                    let result = DisassemblyBackwardResult { session_id: session_id.clone(), target, instructions: serializable };
                    let _ = app_handle.emit("disassembly-backward-updated", &result);
                    info!("OOB backward disassembly for session {} at 0x{:X}", session_id, target);
                }
                Err(e) => {
                    error!("OOB backward disassembly failed: {}", e);
                    let _ = app_handle.emit("disassembly-backward-error", &DisassemblyBackwardError {
                        session_id: session_id.clone(), target, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
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
    let to_data = |module: &joybug2::protocol_io::ModuleInfo| ModuleData {
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
    let to_data = |thread: &joybug2::protocol_io::ThreadInfo| ThreadData {
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

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::GetModuleExtraInfo { module_base: module_base_val }) {
        Ok(()) => {
            info!("Module extra info request sent for session {} at base 0x{:X}", session_id, module_base_val);
        }
        Err(_) => {
            let base_str = format!("0x{:X}", module_base_val);
            let extra = super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, pid| oob.get_module_extra_info(pid, module_base_val));
            match super::flatten_oob(extra) {
                Ok(info_data) => {
                    #[derive(serde::Serialize)]
                    struct ModuleExtraInfoResult {
                        session_id: String,
                        module_base: String,
                        info: joybug2::pe_types::ModuleExtraInfo,
                    }
                    let result = ModuleExtraInfoResult {
                        session_id: session_id.clone(), module_base: base_str, info: info_data,
                    };
                    let _ = app_handle.emit("module-extra-info-updated", &result);
                    info!("OOB module extra info for session {} at 0x{:X}", session_id, module_base_val);
                }
                Err(e) => {
                    error!("OOB module extra info failed: {}", e);
                    #[derive(serde::Serialize)]
                    struct ModuleExtraInfoError { session_id: String, module_base: String, error: String }
                    let _ = app_handle.emit("module-extra-info-error", &ModuleExtraInfoError {
                        session_id: session_id.clone(), module_base: base_str, error: e.to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}
