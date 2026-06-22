use crate::error::{Error, Result};
use crate::pinned_address_store::{self, PinnedAddress};
use crate::session::helpers::{extract_module_name, find_module_for_address, format_bytes};
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use serde::Serialize;
use tauri::{Emitter, State};
use tracing::{error, info};

#[tauri::command]
pub fn request_memory_read(
    session_id: String,
    address: u64,
    size: usize,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::ReadMemory { address, size }) {
        Ok(()) => {
            info!("Memory read request sent for session {} at 0x{:X}, size {}", session_id, address, size);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.read_memory(pid, address, size) {
                Ok(data) => {
                    let result = crate::session::types::MemoryReadResult {
                        session_id: session_id.clone(), address, requested_size: size, data,
                    };
                    let _ = app_handle.emit("memory-read-updated", &result);
                    info!("OOB memory read for session {} at 0x{:X}", session_id, address);
                }
                Err(e) => {
                    error!("OOB memory read failed: {}", e);
                    let _ = app_handle.emit("memory-read-error", &crate::session::types::MemoryReadError {
                        session_id: session_id.clone(), address, error: e.to_string(),
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
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::WriteMemory { address, data: data.clone() }) {
        Ok(()) => {
            info!("Memory write request sent for session {} at 0x{:X}", session_id, address);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.write_memory(pid, address, data.clone()) {
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
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::GetMemoryRegions) {
        Ok(()) => {
            info!("Memory regions request sent for session {}", session_id);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.enumerate_memory_regions(pid) {
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
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::SearchMemory { pattern: pattern.clone(), max_results }) {
        Ok(()) => {
            info!("Memory search request sent for session {}", session_id);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.search_memory(pid, pattern, max_results) {
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
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::Dereference { address, count }) {
        Ok(()) => {
            info!("Dereference request sent for session {} at 0x{:X}, count {}", session_id, address, count);
        }
        Err(_) => {
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            match oob.dereference(pid, address, count, None) {
                Ok(entries) => {
                    let serializable_entries: Vec<crate::session::types::SerializableDereferenceEntry> = entries.iter().map(|entry| {
                        let chain: Vec<crate::session::types::SerializableDereferenceValue> = entry.chain.iter().map(|v| {
                            match v {
                                joybug2::protocol::DereferenceValue::Pointer(addr, sym) => {
                                    crate::session::types::SerializableDereferenceValue::Pointer {
                                        address: format!("0x{:016X}", addr), symbol: sym.clone(),
                                    }
                                }
                                joybug2::protocol::DereferenceValue::Value(val) => {
                                    crate::session::types::SerializableDereferenceValue::Value {
                                        value: format!("0x{:X}", val),
                                    }
                                }
                                joybug2::protocol::DereferenceValue::String(s) => {
                                    crate::session::types::SerializableDereferenceValue::String {
                                        value: s.clone(),
                                    }
                                }
                                joybug2::protocol::DereferenceValue::Instruction(instr, sym) => {
                                    crate::session::types::SerializableDereferenceValue::Instruction {
                                        value: instr.clone(), symbol: sym.clone(),
                                    }
                                }
                                joybug2::protocol::DereferenceValue::LoopDetected(addr) => {
                                    crate::session::types::SerializableDereferenceValue::LoopDetected {
                                        address: format!("0x{:016X}", addr),
                                    }
                                }
                            }
                        }).collect();
                        crate::session::types::SerializableDereferenceEntry {
                            address: format!("0x{:016X}", entry.address), offset: entry.offset, chain,
                        }
                    }).collect();
                    let result = crate::session::types::DereferenceResult {
                        session_id: session_id.clone(),
                        base_address: format!("0x{:016X}", address),
                        entries: serializable_entries,
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
            let (mut oob, pid) = super::create_oob_client(&session_arc)?;
            for &addr in &addresses {
                match oob.dereference(pid, addr, 1, None) {
                    Ok(entries) => {
                        let serializable_entries: Vec<crate::session::types::SerializableDereferenceEntry> = entries.iter().map(|entry| {
                            let chain: Vec<crate::session::types::SerializableDereferenceValue> = entry.chain.iter().map(|v| {
                                match v {
                                    joybug2::protocol::DereferenceValue::Pointer(a, sym) => {
                                        crate::session::types::SerializableDereferenceValue::Pointer {
                                            address: format!("0x{:016X}", a), symbol: sym.clone(),
                                        }
                                    }
                                    joybug2::protocol::DereferenceValue::Value(val) => {
                                        crate::session::types::SerializableDereferenceValue::Value {
                                            value: format!("0x{:X}", val),
                                        }
                                    }
                                    joybug2::protocol::DereferenceValue::String(s) => {
                                        crate::session::types::SerializableDereferenceValue::String {
                                            value: s.clone(),
                                        }
                                    }
                                    joybug2::protocol::DereferenceValue::Instruction(instr, sym) => {
                                        crate::session::types::SerializableDereferenceValue::Instruction {
                                            value: instr.clone(), symbol: sym.clone(),
                                        }
                                    }
                                    joybug2::protocol::DereferenceValue::LoopDetected(a) => {
                                        crate::session::types::SerializableDereferenceValue::LoopDetected {
                                            address: format!("0x{:016X}", a),
                                        }
                                    }
                                }
                            }).collect();
                            crate::session::types::SerializableDereferenceEntry {
                                address: format!("0x{:016X}", entry.address), offset: entry.offset, chain,
                            }
                        }).collect();
                        let result = crate::session::types::DereferenceResult {
                            session_id: session_id.clone(),
                            base_address: format!("0x{:016X}", addr),
                            entries: serializable_entries,
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
            info!("OOB batch dereference for session {} with {} addresses", session_id, count);
        }
    }
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
    settings: State<'_, crate::settings::SettingsState>,
) -> Result<()> {
    // `0` (the default) means "all cores"; map it to `None` for the scanner.
    let thread_count = match settings.lock().map(|s| s.scan_thread_count).unwrap_or(0) {
        0 => None,
        n => Some(n),
    };
    super::send_paused_command(&session_id, &session_states, UICommand::ScanMemoryStart {
        value_type, compare_type, value, value2, alignment, float_tolerance, writable_only, thread_count,
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
    if let Ok(address) = u64::from_str_radix(address_hex.trim_start_matches("0x").trim_start_matches("0X"), 16) {
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

    let address = super::parse_hex_u64(&address_hex, "address")?;

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
