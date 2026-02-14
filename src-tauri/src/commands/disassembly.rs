use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::{SessionStatesMap, SessionStatusUI};
use super::types::{ModuleData, ThreadData};
use tauri::State;
use tracing::{debug, info};

/// Gets the architecture from a paused session's current context and sends a UICommand.
fn send_disassembly_command(
    session_id: &str,
    session_states: &SessionStatesMap,
    build_command: impl FnOnce(joybug2::interfaces::Architecture) -> UICommand,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))?
    };

    let (arch, ui_sender) = {
        let state = session_state.lock().unwrap();

        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                format!("Session must be paused to get disassembly, but is: {:?}", state.status),
            ));
        }

        let arch = match &state.current_context {
            Some(crate::state::SerializableThreadContext::X64(_)) => joybug2::interfaces::Architecture::X64,
            Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug2::interfaces::Architecture::Arm64,
            None => {
                #[cfg(target_arch = "x86_64")]
                { joybug2::interfaces::Architecture::X64 }
                #[cfg(target_arch = "aarch64")]
                { joybug2::interfaces::Architecture::Arm64 }
                #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
                {
                    return Err(Error::InvalidSessionState(
                        "Unsupported target architecture for disassembly".to_string(),
                    ));
                }
            }
        };

        let sender = state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session UI sender not available".to_string()))?
            .clone();

        (arch, sender)
    };

    ui_sender
        .send(build_command(arch))
        .map_err(|e| Error::InternalCommunication(format!("Failed to send disassembly command: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub fn request_disassembly(
    session_id: String,
    address: u64,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    debug!("Disassembly request received for session {} at address 0x{:X}", session_id, address);
    send_disassembly_command(&session_id, &session_states, |arch| {
        UICommand::Disassembly { arch, address, count: count as u32 }
    })?;
    info!("Disassembly request sent for session {} at address 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn request_function_disassembly(
    session_id: String,
    address: u64,
    max_instructions: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    debug!("Function disassembly request received for session {} at address 0x{:X}", session_id, address);
    send_disassembly_command(&session_id, &session_states, |arch| {
        UICommand::DisassembleFunction { arch, address, max_instructions: max_instructions as u32 }
    })?;
    info!("Function disassembly request sent for session {} at address 0x{:X}", session_id, address);
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
) -> Result<()> {
    let module_base = u64::from_str_radix(module_base.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid module base '{}': {}", module_base, e)))?;
    super::send_paused_command(&session_id, &session_states, UICommand::GetModuleExtraInfo { module_base })?;
    info!("Module extra info request sent for session {} at base 0x{:X}", session_id, module_base);
    Ok(())
}
