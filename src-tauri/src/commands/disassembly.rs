use crate::error::{Error, Result};
use crate::session::disassembly::serialize_instructions;
use crate::session::types::SerializableInstruction;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use super::types::{ModuleData, ThreadData};
use tauri::{Emitter, State};
use tracing::{debug, error, info};

#[tauri::command]
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
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
            let modules = session_arc.lock().unwrap().modules.clone();
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.disassemble_memory(pid, address, count, arch) {
                Ok(instructions) => {
                    let serializable = serialize_instructions(&instructions, &modules);
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
            let modules = session_arc.lock().unwrap().modules.clone();
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.disassemble_function(pid, address, max_instructions, arch) {
                Ok((instructions, function_start, function_end, function_name)) => {
                    let serializable = serialize_instructions(&instructions, &modules);
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
pub fn get_session_modules(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ModuleData>> {
    let sessions = session_states.lock().unwrap();

    if let Some(session_arc) = sessions.get(&session_id) {
        let session = session_arc.lock().unwrap();

        let modules: Vec<ModuleData> = session.modules.iter().map(|module| {
            ModuleData {
                name: module.name.clone(),
                base_address: format!("0x{:X}", module.base),
                size: module.size.unwrap_or(0),
                path: module.name.clone(),
            }
        }).collect();

        Ok(modules)
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}

#[tauri::command]
pub fn get_session_threads(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ThreadData>> {
    let sessions = session_states.lock().unwrap();

    if let Some(session_arc) = sessions.get(&session_id) {
        let session = session_arc.lock().unwrap();

        let threads: Vec<ThreadData> = session.threads.iter().map(|thread| {
            ThreadData {
                id: thread.tid,
                status: "Running".to_string(),
                start_address: format!("0x{:X}", thread.start_address),
            }
        }).collect();

        Ok(threads)
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}

#[tauri::command]
pub fn request_module_extra_info(
    session_id: String,
    module_base: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let module_base_val = u64::from_str_radix(module_base.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid module base '{}': {}", module_base, e)))?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::GetModuleExtraInfo { module_base: module_base_val }) {
        Ok(()) => {
            info!("Module extra info request sent for session {} at base 0x{:X}", session_id, module_base_val);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            let base_str = format!("0x{:X}", module_base_val);
            match oob.get_module_extra_info(pid, module_base_val) {
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
