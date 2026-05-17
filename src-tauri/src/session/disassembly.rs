use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{find_module_for_address, get_modules_snapshot};
use super::types::{DebugSession, SerializableInstruction};
use crate::state::SessionStateUI;

/// Collect (start, end) ranges of currently-applied patches.
pub(crate) fn applied_patch_ranges(state: &SessionStateUI) -> Vec<(u64, u64)> {
    state
        .patches
        .iter()
        .filter(|p| p.is_applied && p.address != 0)
        .map(|p| (p.address, p.address + p.patched_bytes.len() as u64))
        .collect()
}

/// Converts raw disassembled instructions into serializable form with symbol resolution.
pub(crate) fn serialize_instructions(
    instructions: &[joybug2::interfaces::Instruction],
    modules: &[joybug2::protocol_io::ModuleInfo],
    patched_ranges: &[(u64, u64)],
) -> Vec<SerializableInstruction> {
    instructions
        .iter()
        .map(|inst| {
            let address_str = if let Some(ref sym) = inst.symbol_info {
                format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
            } else if let Some((mod_name, offset)) = find_module_for_address(modules, inst.address) {
                format!("{}+0x{:x}", mod_name, offset)
            } else {
                format!("{:#X}", inst.address)
            };

            let op_str = inst.symbolized_op_str.as_ref().unwrap_or(&inst.op_str);

            let is_patched = patched_ranges
                .iter()
                .any(|&(start, end)| inst.address >= start && inst.address < end);

            SerializableInstruction {
                address: format!("{:#X}", inst.address),
                symbol: address_str,
                bytes: inst
                    .bytes
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<String>>()
                    .join(" "),
                mnemonic: inst.mnemonic.clone(),
                op_str: op_str.clone(),
                is_jump: inst.is_jump,
                is_call: inst.is_call,
                is_ret: inst.is_ret,
                jump_target: inst.jump_target.map(|addr| format!("{:#X}", addr)),
                is_patched,
            }
        })
        .collect()
}

/// Processes a disassembly request and emits results to the frontend
pub(crate) fn process_disassembly_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    count: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing disassembly request: pid={}, address=0x{:X}, count={}", pid, address, count);
    let modules = get_modules_snapshot(session);
    let patched_ranges = applied_patch_ranges(&session.state.lock().unwrap());
    match session.disassemble_memory(pid, address, count as usize, arch) {
        Ok(instructions) => {
            debug!("📥 Received {} instructions from disassemble_memory", instructions.len());

            let serializable_instructions = serialize_instructions(&instructions, &modules, &patched_ranges);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct DisassemblyResult {
                    session_id: String,
                    address: u64,
                    instructions: Vec<SerializableInstruction>,
                }

                let result = DisassemblyResult {
                    session_id,
                    address,
                    instructions: serializable_instructions,
                };

                if let Err(e) = handle.emit("disassembly-updated", &result) {
                    error!("Failed to emit disassembly-updated event: {}", e);
                } else {
                    debug!("📡 Emitted disassembly-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to disassemble memory: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct DisassemblyError {
                    session_id: String,
                    address: u64,
                    error: String,
                }

                let error_result = DisassemblyError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("disassembly-error", &error_result) {
                    error!("Failed to emit disassembly-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a function disassembly request with bounds detection and emits results to the frontend
pub(crate) fn process_function_disassembly_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    max_instructions: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing function disassembly request: pid={}, address=0x{:X}, max_instructions={}", pid, address, max_instructions);

    let modules = get_modules_snapshot(session);
    let patched_ranges = applied_patch_ranges(&session.state.lock().unwrap());
    match session.disassemble_function(pid, address, max_instructions as usize, arch) {
        Ok((instructions, function_start, function_end, function_name)) => {
            debug!("📥 Received {} instructions from disassemble_function", instructions.len());

            let serializable_instructions = serialize_instructions(&instructions, &modules, &patched_ranges);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

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
                    session_id,
                    address,
                    instructions: serializable_instructions,
                    function_start: function_start.map(|a| format!("{:#X}", a)),
                    function_end: function_end.map(|a| format!("{:#X}", a)),
                    function_name,
                };

                if let Err(e) = handle.emit("function-disassembly-updated", &result) {
                    error!("Failed to emit function-disassembly-updated event: {}", e);
                } else {
                    debug!("📡 Emitted function-disassembly-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to disassemble function: {}", e);

            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct FunctionDisassemblyError {
                    session_id: String,
                    address: u64,
                    error: String,
                }

                let error_result = FunctionDisassemblyError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("function-disassembly-error", &error_result) {
                    error!("Failed to emit function-disassembly-error event: {}", emit_err);
                }
            }
        }
    }
}
