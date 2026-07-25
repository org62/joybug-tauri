use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{effective_op_str, find_module_for_address, format_symbol, get_modules_snapshot, module_offset_label};
use super::types::{DebugSession, EmulationInstructionInfo, EmulationResultPayload, MemorySnapshotEntry};

/// Extracts PC addresses from Tenet trace text (first key=value on each line is always the PC)
fn extract_pcs_from_tenet(trace_text: &str) -> Vec<u64> {
    trace_text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let first_comma = line.find(',').unwrap_or(line.len());
            let first_field = &line[..first_comma];
            let eq_pos = first_field.find('=')?;
            let hex_val = first_field[eq_pos + 1..].trim_start_matches("0x").trim_start_matches("0X");
            u64::from_str_radix(hex_val, 16).ok()
        })
        .collect()
}

/// Disassembles a set of unique addresses (1 instruction each) and returns instruction info
fn disassemble_addresses(
    session: &mut DebugSession,
    pid: u32,
    addresses: &[u64],
    arch: joybug_core::interfaces::Architecture,
) -> Vec<EmulationInstructionInfo> {
    let modules = get_modules_snapshot(session);
    let mut info = Vec::with_capacity(addresses.len());
    for &addr in addresses {
        if let Ok(instructions) = session.disassemble_memory(pid, addr, 1, arch) {
            if let Some(inst) = instructions.first() {
                let symbol = if let Some(ref sym) = inst.symbol_info {
                    Some(format_symbol(&sym.module_name, &sym.symbol_name, sym.offset))
                } else if let Some((mod_name, offset)) = find_module_for_address(&modules, inst.address) {
                    Some(module_offset_label(&mod_name, offset))
                } else {
                    None
                };
                let op_str = effective_op_str(inst);
                info.push(EmulationInstructionInfo {
                    address: format!("0x{:X}", inst.address),
                    symbol,
                    mnemonic: inst.mnemonic.clone(),
                    op_str,
                });
            }
        }
    }
    info
}

/// Symbolize a raw hex address in a stop_reason string, trying symbol resolution then module+offset fallback.
fn symbolize_address_in_stop_reason(
    session: &mut DebugSession,
    pid: u32,
    stop_reason: &str,
    prefix_pos: usize,
) -> Option<String> {
    let after_prefix = prefix_pos + 1;
    let end = prefix_pos + stop_reason[prefix_pos..].find(')')?;
    let hex_str = &stop_reason[after_prefix..end];
    let addr = u64::from_str_radix(&hex_str[2..], 16).ok()?;

    if let Ok((_module, sym, offset)) = session.resolve_address_to_symbol(pid, addr) {
        if let (Some(m), Some(s), Some(o)) = (_module, sym, offset) {
            let symbol = format_symbol(&m, &s.name, o);
            return Some(format!("{}{}{}", &stop_reason[..after_prefix], symbol, &stop_reason[end..]));
        }
    }
    let modules = get_modules_snapshot(session);
    if let Some((mod_name, mod_offset)) = find_module_for_address(&modules, addr) {
        let label = module_offset_label(&mod_name, mod_offset);
        return Some(format!("{}{}{}", &stop_reason[..after_prefix], label, &stop_reason[end..]));
    }
    None
}

/// Symbolize addresses in stop_reason strings like "Syscall(0x7FFC...)" or "ModuleTransition(mod1->mod2@0x7FFC...)"
fn symbolize_stop_reason(
    session: &mut DebugSession,
    pid: u32,
    stop_reason: &str,
) -> String {
    if let Some(start) = stop_reason.find("(0x") {
        if let Some(result) = symbolize_address_in_stop_reason(session, pid, stop_reason, start) {
            return result;
        }
    }
    if let Some(at_pos) = stop_reason.find("@0x") {
        if let Some(result) = symbolize_address_in_stop_reason(session, pid, stop_reason, at_pos) {
            return result;
        }
    }
    stop_reason.to_string()
}

/// Processes an emulation request and emits results to the frontend
pub(crate) fn process_emulation_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    max_instructions: usize,
    mode: joybug_core::protocol_io::EmulationMode,
    exit_condition: Option<joybug_core::protocol_io::TraceExitCondition>,
    request_id: Option<String>,
    memory_reads: Vec<(u64, usize)>,
) {
    let pid = event.pid();
    let tid = event.tid();
    debug!("📤 Processing emulation request: pid={}, tid={}, max_instructions={}, mode={:?}", pid, tid, max_instructions, mode);

    let session_id = {
        let state = session.state.lock().unwrap();
        state.id.clone()
    };

    match session.emulate_instructions(pid, tid, max_instructions, mode, exit_condition, memory_reads) {
        Ok(result) => {
            debug!("📥 Received emulation result");

            let arch = {
                let state = session.state.lock().unwrap();
                match &state.current_context {
                    Some(crate::state::SerializableThreadContext::X64(_)) => joybug_core::interfaces::Architecture::X64,
                    Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug_core::interfaces::Architecture::Arm64,
                    None => {
                        #[cfg(target_arch = "x86_64")]
                        { joybug_core::interfaces::Architecture::X64 }
                        #[cfg(target_arch = "aarch64")]
                        { joybug_core::interfaces::Architecture::Arm64 }
                        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
                        { joybug_core::interfaces::Architecture::X64 }
                    }
                }
            };

            let needs_disassembly = matches!(mode,
                joybug_core::protocol_io::EmulationMode::BasicBlock |
                joybug_core::protocol_io::EmulationMode::InstructionTrace
            );

            let unique_addrs: Vec<u64> = if needs_disassembly {
                let raw_addrs: Vec<u64> = match &result {
                    joybug_core::protocol_io::EmulateResult::Emulation(data) => {
                        data.basic_blocks.clone()
                    }
                    joybug_core::protocol_io::EmulateResult::Trace(trace) => {
                        extract_pcs_from_tenet(&trace.trace_text)
                    }
                };
                let mut seen = std::collections::HashSet::new();
                raw_addrs.into_iter().filter(|a| seen.insert(*a)).collect()
            } else {
                Vec::new()
            };

            let instruction_info = if !unique_addrs.is_empty() {
                debug!("📤 Disassembling {} unique addresses for emulation enrichment", unique_addrs.len());
                disassemble_addresses(session, pid, &unique_addrs, arch)
            } else {
                Vec::new()
            };

            if let Some(ref handle) = app_handle_clone {
                let payload = match result {
                    joybug_core::protocol_io::EmulateResult::Emulation(data) => {
                        let stop_reason = symbolize_stop_reason(session, pid, &data.stop_reason);
                        let memory_snapshots = data.memory_snapshots.into_iter()
                            .map(|(addr, bytes)| MemorySnapshotEntry {
                                address: format!("0x{:X}", addr),
                                data: bytes,
                            })
                            .collect();
                        EmulationResultPayload {
                            session_id,
                            request_id,
                            mode: format!("{:?}", mode),
                            final_pc: Some(format!("0x{:X}", data.final_pc)),
                            instructions_executed: data.instructions_executed,
                            stop_reason,
                            emulation_time_us: data.emulation_time_us,
                            pages_loaded: Some(data.pages_loaded),
                            basic_blocks: data.basic_blocks.iter().map(|addr| format!("0x{:X}", addr)).collect(),
                            trace_text: None,
                            trace_time_us: None,
                            instruction_info,
                            stats_text: data.stats_text,
                            memory_snapshots,
                        }
                    }
                    joybug_core::protocol_io::EmulateResult::Trace(trace) => {
                        let stop_reason = symbolize_stop_reason(session, pid, &trace.stop_reason);
                        EmulationResultPayload {
                            session_id,
                            request_id,
                            mode: format!("{:?}", mode),
                            final_pc: None,
                            instructions_executed: 0,
                            stop_reason,
                            emulation_time_us: trace.trace_time_us,
                            pages_loaded: None,
                            basic_blocks: Vec::new(),
                            trace_text: Some(trace.trace_text),
                            trace_time_us: Some(trace.trace_time_us),
                            instruction_info,
                            stats_text: trace.stats_text,
                            memory_snapshots: Vec::new(),
                        }
                    }
                };

                if let Err(e) = handle.emit("emulation-result", &payload) {
                    error!("Failed to emit emulation-result event: {}", e);
                } else {
                    debug!("📡 Emitted emulation-result event with {} instruction info entries", payload.instruction_info.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to emulate instructions: {}", e);

            if let Some(ref handle) = app_handle_clone {
                #[derive(serde::Serialize)]
                struct EmulationError {
                    session_id: String,
                    error: String,
                }

                let error_result = EmulationError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("emulation-error", &error_result) {
                    error!("Failed to emit emulation-error event: {}", emit_err);
                }
            }
        }
    }
}
