use crate::error::{Error, Result};
use crate::pinned_address_store::{self, PinnedAddress};
use crate::session::helpers::{extract_module_name, find_module_for_address};
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use serde::Serialize;
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
pub fn request_memory_search(
    session_id: String,
    pattern: Vec<u8>,
    max_results: usize,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::SearchMemory { pattern, max_results })?;
    info!("Memory search request sent for session {}", session_id);
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

#[tauri::command]
pub fn request_dereference_batch(
    session_id: String,
    addresses: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let parsed: std::result::Result<Vec<u64>, _> = addresses
        .iter()
        .map(|a| {
            u64::from_str_radix(a.trim_start_matches("0x").trim_start_matches("0X"), 16)
                .map_err(|e| Error::InvalidParameter(format!("Invalid address '{}': {}", a, e)))
        })
        .collect();
    let addresses = parsed?;

    let count = addresses.len();
    super::send_paused_command(&session_id, &session_states, UICommand::DereferenceBatch { addresses })?;
    info!("Batch dereference request sent for session {} with {} addresses", session_id, count);
    Ok(())
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
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ScanMemoryStart {
        value_type, compare_type, value, value2, alignment, float_tolerance, writable_only,
    })?;
    info!("Scan memory start request sent for session {}", session_id);
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
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ScanMemoryNext {
        scan_id, value_type, compare_type, value, value2,
    })?;
    info!("Scan memory next request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_scan_memory_get_results(
    session_id: String,
    scan_id: u64,
    offset: u64,
    count: u64,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ScanMemoryGetResults {
        scan_id, offset, count,
    })?;
    info!("Scan memory get results request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn request_scan_memory_reset(
    session_id: String,
    scan_id: u64,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ScanMemoryReset { scan_id })?;
    info!("Scan memory reset request sent for session {}", session_id);
    Ok(())
}

// --- Pinned Addresses ---

#[derive(Debug, Clone, Serialize)]
pub struct AddPinResult {
    pub pinned: bool,
    pub in_module: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedPinnedAddress {
    pub address_hex: String,
    pub module_name: Option<String>,
    pub value_type: String,
    pub label: Option<String>,
    pub is_resolved: bool,
}

/// Extracts launch_command and modules from a session.
fn get_session_info(
    session_id: &str,
    session_states: &SessionStatesMap,
) -> Result<(String, Vec<joybug2::protocol_io::ModuleInfo>)> {
    let states = session_states.lock().unwrap();
    let session = states
        .get(session_id)
        .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))?;
    let state = session.lock().unwrap();
    Ok((state.launch_command.clone(), state.modules.clone()))
}

fn resolve_pinned_addresses(
    pins: &[PinnedAddress],
    modules: &[joybug2::protocol_io::ModuleInfo],
) -> Vec<ResolvedPinnedAddress> {
    pins.iter()
        .map(|pin| {
            if let (Some(mod_name), Some(offset)) = (&pin.module_name, pin.module_offset) {
                // Module-relative pin: find module by name and resolve
                let mod_name_lower = mod_name.to_lowercase();
                let resolved = modules.iter().find(|m| {
                    extract_module_name(&m.name).to_lowercase() == mod_name_lower
                });
                match resolved {
                    Some(m) => ResolvedPinnedAddress {
                        address_hex: format!("0x{:X}", m.base + offset),
                        module_name: Some(mod_name.clone()),
                        value_type: pin.value_type.clone(),
                        label: pin.label.clone(),
                        is_resolved: true,
                    },
                    None => ResolvedPinnedAddress {
                        address_hex: format!("{}+0x{:X}", mod_name, offset),
                        module_name: Some(mod_name.clone()),
                        value_type: pin.value_type.clone(),
                        label: pin.label.clone(),
                        is_resolved: false,
                    },
                }
            } else {
                // Raw address pin
                ResolvedPinnedAddress {
                    address_hex: pin.raw_address.clone().unwrap_or_default(),
                    module_name: None,
                    value_type: pin.value_type.clone(),
                    label: pin.label.clone(),
                    is_resolved: true,
                }
            }
        })
        .collect()
}

/// Parses a module offset from either a resolved hex address (by subtracting module base)
/// or an unresolved "module+0xOFFSET" string.
fn parse_module_offset(
    address_hex: &str,
    mod_name: &str,
    modules: &[joybug2::protocol_io::ModuleInfo],
) -> Option<u64> {
    let mod_name_lower = mod_name.to_lowercase();

    // Try resolved case: parse as hex address and subtract module base
    if let Ok(address) = u64::from_str_radix(
        address_hex.trim_start_matches("0x").trim_start_matches("0X"),
        16,
    ) {
        if let Some(base) = modules.iter()
            .find(|m| extract_module_name(&m.name).to_lowercase() == mod_name_lower)
            .map(|m| m.base)
        {
            if address >= base {
                return Some(address - base);
            }
        }
    }

    // Try unresolved case: parse "module+0xOFFSET" format
    if let Some(offset_str) = address_hex.split("+0x").nth(1).or_else(|| address_hex.split("+0X").nth(1)) {
        return u64::from_str_radix(offset_str, 16).ok();
    }

    None
}

#[tauri::command]
pub fn add_pinned_address(
    session_id: String,
    address_hex: String,
    value_type: String,
    label: Option<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<AddPinResult> {
    let (launch_command, modules) = get_session_info(&session_id, &session_states)?;

    let address = u64::from_str_radix(
        address_hex.trim_start_matches("0x").trim_start_matches("0X"),
        16,
    )
    .map_err(|e| Error::InvalidParameter(format!("Invalid address '{}': {}", address_hex, e)))?;

    if let Some((mod_name, offset)) = find_module_for_address(&modules, address) {
        let mut pins = pinned_address_store::load_pinned_addresses(&launch_command);
        // Prevent duplicates
        let already_pinned = pins.iter().any(|p| {
            p.module_name.as_deref() == Some(&mod_name) && p.module_offset == Some(offset)
        });
        if !already_pinned {
            pins.push(PinnedAddress {
                module_name: Some(mod_name),
                module_offset: Some(offset),
                raw_address: None,
                value_type,
                label,
            });
            pinned_address_store::save_pinned_addresses(&launch_command, &pins);
        }
        info!("Pinned address 0x{:X} (module-relative) for session {}", address, session_id);
        Ok(AddPinResult { pinned: true, in_module: true })
    } else {
        Ok(AddPinResult { pinned: false, in_module: false })
    }
}

#[tauri::command]
pub fn confirm_pin_raw_address(
    session_id: String,
    address_hex: String,
    value_type: String,
    label: Option<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let (launch_command, _) = get_session_info(&session_id, &session_states)?;

    let mut pins = pinned_address_store::load_pinned_addresses(&launch_command);
    // Prevent duplicates
    let already_pinned = pins.iter().any(|p| {
        p.module_name.is_none() && p.raw_address.as_deref() == Some(&address_hex)
    });
    if !already_pinned {
        pins.push(PinnedAddress {
            module_name: None,
            module_offset: None,
            raw_address: Some(address_hex.clone()),
            value_type,
            label,
        });
        pinned_address_store::save_pinned_addresses(&launch_command, &pins);
    }
    info!("Pinned raw address {} for session {}", address_hex, session_id);
    Ok(())
}

#[tauri::command]
pub fn get_pinned_addresses(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ResolvedPinnedAddress>> {
    let (launch_command, modules) = get_session_info(&session_id, &session_states)?;
    let pins = pinned_address_store::load_pinned_addresses(&launch_command);
    Ok(resolve_pinned_addresses(&pins, &modules))
}

#[tauri::command]
pub fn remove_pinned_address(
    session_id: String,
    address_hex: String,
    module_name: Option<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<ResolvedPinnedAddress>> {
    let (launch_command, modules) = get_session_info(&session_id, &session_states)?;
    let mut pins = pinned_address_store::load_pinned_addresses(&launch_command);

    if let Some(ref mod_name) = module_name {
        let mod_name_lower = mod_name.to_lowercase();
        let offset = parse_module_offset(&address_hex, mod_name, &modules);

        pins.retain(|p| {
            !(p.module_name.as_ref().map(|n| n.to_lowercase()) == Some(mod_name_lower.clone())
                && offset.is_some()
                && p.module_offset == offset)
        });
    } else {
        // Remove raw address pin
        pins.retain(|p| {
            !(p.module_name.is_none()
                && p.raw_address.as_deref() == Some(address_hex.as_str()))
        });
    }

    pinned_address_store::save_pinned_addresses(&launch_command, &pins);
    info!("Removed pinned address {} for session {}", address_hex, session_id);
    Ok(resolve_pinned_addresses(&pins, &modules))
}
