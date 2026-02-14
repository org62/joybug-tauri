use crate::error::{Error, Result};
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
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ReadMemory { address, size })?;
    info!("Memory read request sent for session {} at address 0x{:X}, size {}", session_id, address, size);
    Ok(())
}

#[tauri::command]
pub fn request_memory_write(
    session_id: String,
    address: u64,
    data: Vec<u8>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::WriteMemory { address, data })?;
    info!("Memory write request sent for session {} at address 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn request_set_register(
    session_id: String,
    register_name: String,
    value: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let value = u64::from_str_radix(value.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid hex value '{}': {}", value, e)))?;

    super::send_paused_command(&session_id, &session_states, UICommand::SetRegister { register_name: register_name.clone(), value })?;
    info!("Set register request sent for session {}: {} = 0x{:X}", session_id, register_name, value);
    Ok(())
}

#[tauri::command]
pub fn request_memory_regions(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::GetMemoryRegions)?;
    info!("Memory regions request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_dereference(
    session_id: String,
    address: String,
    count: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let address = u64::from_str_radix(address.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid address '{}': {}", address, e)))?;

    super::send_paused_command(&session_id, &session_states, UICommand::Dereference { address, count })?;
    info!("Dereference request sent for session {} at address 0x{:X}, count {}", session_id, address, count);
    Ok(())
}
