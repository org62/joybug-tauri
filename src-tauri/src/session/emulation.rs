use std::collections::HashSet;

use joybug_core::interfaces::Instruction;
use joybug_core::protocol_io::{EmulateResult, EmulationMode};
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

/// What one emulation run produced, before it is shaped for the frontend —
/// the common ground between the session path (a wire response) and the PE
/// viewer's process-less path (a core `EmulationResult`).
pub(crate) struct EmulationOutcome {
    pub final_pc: Option<u64>,
    pub instructions_executed: usize,
    pub stop_reason: String,
    pub time_us: u64,
    pub pages_loaded: Option<usize>,
    pub basic_blocks: Vec<u64>,
    /// Tenet trace text (InstructionTrace mode only).
    pub trace_text: Option<String>,
    pub stats_text: String,
    pub memory_snapshots: Vec<(u64, Vec<u8>)>,
}

impl EmulationOutcome {
    /// The addresses the run touched that the footer's trace/block rows show,
    /// deduplicated in first-seen order: every traced PC, or every basic-block
    /// start. Empty in the other modes.
    pub(crate) fn enrichment_addresses(&self, mode: EmulationMode) -> Vec<u64> {
        let raw: Vec<u64> = match mode {
            EmulationMode::InstructionTrace => self.trace_text.as_deref().map(extract_pcs_from_tenet).unwrap_or_default(),
            EmulationMode::BasicBlock => self.basic_blocks.clone(),
            _ => return Vec::new(),
        };
        let mut seen = HashSet::new();
        raw.into_iter().filter(|a| seen.insert(*a)).collect()
    }

    /// The `emulation-result` payload: addresses as hex strings, snapshots as
    /// entries, the trace timing mirrored when there is a trace.
    pub(crate) fn into_payload(
        self,
        session_id: String,
        request_id: Option<String>,
        mode: EmulationMode,
        instruction_info: Vec<EmulationInstructionInfo>,
    ) -> EmulationResultPayload {
        EmulationResultPayload {
            session_id,
            request_id,
            mode: format!("{:?}", mode),
            final_pc: self.final_pc.map(|pc| format!("0x{:X}", pc)),
            instructions_executed: self.instructions_executed,
            stop_reason: self.stop_reason,
            emulation_time_us: self.time_us,
            pages_loaded: self.pages_loaded,
            basic_blocks: self.basic_blocks.iter().map(|a| format!("0x{:X}", a)).collect(),
            trace_time_us: self.trace_text.as_ref().map(|_| self.time_us),
            trace_text: self.trace_text,
            instruction_info,
            stats_text: self.stats_text,
            memory_snapshots: self
                .memory_snapshots
                .into_iter()
                .map(|(addr, data)| MemorySnapshotEntry { address: format!("0x{:X}", addr), data })
                .collect(),
        }
    }
}

/// Per-address instruction info for the footer rows: `disassemble_one` yields
/// the instruction at an address and its symbol label, or `None` to skip it.
pub(crate) fn instruction_info(
    addresses: &[u64],
    mut disassemble_one: impl FnMut(u64) -> Option<(Instruction, Option<String>)>,
) -> Vec<EmulationInstructionInfo> {
    addresses
        .iter()
        .filter_map(|&addr| {
            let (inst, symbol) = disassemble_one(addr)?;
            Some(EmulationInstructionInfo {
                address: format!("0x{:X}", inst.address),
                symbol,
                mnemonic: inst.mnemonic.clone(),
                op_str: effective_op_str(&inst),
            })
        })
        .collect()
}

/// Disassembles a set of unique addresses (1 instruction each) through the session.
fn disassemble_addresses(
    session: &mut DebugSession,
    pid: u32,
    addresses: &[u64],
    arch: joybug_core::interfaces::Architecture,
) -> Vec<EmulationInstructionInfo> {
    let modules = get_modules_snapshot(session);
    instruction_info(addresses, |addr| {
        let inst = session.disassemble_memory(pid, addr, 1, arch).ok()?.into_iter().next()?;
        let symbol = if let Some(ref sym) = inst.symbol_info {
            Some(format_symbol(&sym.module_name, &sym.symbol_name, sym.offset))
        } else if let Some((mod_name, offset)) = find_module_for_address(&modules, inst.address) {
            Some(module_offset_label(&mod_name, offset))
        } else {
            None
        };
        Some((inst, symbol))
    })
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
    mode: EmulationMode,
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

            let arch = crate::commands::get_session_arch(&session.state);
            let mut outcome = match result {
                EmulateResult::Emulation(data) => EmulationOutcome {
                    final_pc: Some(data.final_pc),
                    instructions_executed: data.instructions_executed,
                    stop_reason: data.stop_reason,
                    time_us: data.emulation_time_us,
                    pages_loaded: Some(data.pages_loaded),
                    basic_blocks: data.basic_blocks,
                    trace_text: None,
                    stats_text: data.stats_text,
                    memory_snapshots: data.memory_snapshots,
                },
                EmulateResult::Trace(trace) => EmulationOutcome {
                    final_pc: trace.final_pc,
                    instructions_executed: trace.instructions_executed,
                    stop_reason: trace.stop_reason,
                    time_us: trace.trace_time_us,
                    pages_loaded: None,
                    basic_blocks: Vec::new(),
                    trace_text: Some(trace.trace_text),
                    stats_text: trace.stats_text,
                    memory_snapshots: Vec::new(),
                },
            };
            outcome.stop_reason = symbolize_stop_reason(session, pid, &outcome.stop_reason);

            let unique_addrs = outcome.enrichment_addresses(mode);
            let instruction_info = if !unique_addrs.is_empty() {
                debug!("📤 Disassembling {} unique addresses for emulation enrichment", unique_addrs.len());
                disassemble_addresses(session, pid, &unique_addrs, arch)
            } else {
                Vec::new()
            };

            if let Some(ref handle) = app_handle_clone {
                let payload = outcome.into_payload(session_id, request_id, mode, instruction_info);
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
