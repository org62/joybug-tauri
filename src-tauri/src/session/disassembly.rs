use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{effective_op_str, find_module_for_address, get_modules_snapshot, module_offset_label};
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
            let symbol = if let Some(ref sym) = inst.symbol_info {
                Some(format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset))
            } else {
                find_module_for_address(modules, inst.address)
                    .map(|(mod_name, offset)| module_offset_label(&mod_name, offset))
            };

            let op_str = effective_op_str(inst, modules);

            let is_patched = patched_ranges
                .iter()
                .any(|&(start, end)| inst.address >= start && inst.address < end);

            SerializableInstruction {
                address: format!("{:#X}", inst.address),
                symbol,
                bytes: inst
                    .bytes
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<String>>()
                    .join(" "),
                mnemonic: inst.mnemonic.clone(),
                op_str,
                is_jump: inst.is_jump,
                is_call: inst.is_call,
                is_ret: inst.is_ret,
                jump_target: inst.jump_target.map(|addr| format!("{:#X}", addr)),
                is_patched,
                source_file: inst.line_info.as_ref().map(|l| l.file_path.clone()),
                source_line: inst.line_info.as_ref().map(|l| l.line),
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

/// Payloads for the backward-disassembly events, shared with the OOB fallback
/// emitter in `commands::disassembly` so the wire shape is defined once.
#[derive(serde::Serialize)]
pub(crate) struct DisassemblyBackwardResult {
    pub session_id: String,
    pub target: u64,
    pub instructions: Vec<SerializableInstruction>,
}

#[derive(serde::Serialize)]
pub(crate) struct DisassemblyBackwardError {
    pub session_id: String,
    pub target: u64,
    pub error: String,
}

/// Processes a backward disassembly request (instructions ending before `target`)
/// and emits results to the frontend on the distinct `disassembly-backward-updated`
/// event (the forward events have full-replace semantics on the frontend).
pub(crate) fn process_disassembly_backward_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    arch: joybug2::interfaces::Architecture,
    target: u64,
    count: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing backward disassembly request: pid={}, target=0x{:X}, count={}", pid, target, count);
    let modules = get_modules_snapshot(session);
    let (patched_ranges, session_id) = {
        let state = session.state.lock().unwrap();
        (applied_patch_ranges(&state), state.id.clone())
    };

    match session.disassemble_backward(pid, target, count as usize, arch) {
        Ok(instructions) => {
            let serializable_instructions = serialize_instructions(&instructions, &modules, &patched_ranges);
            if let Some(ref handle) = app_handle_clone {
                let result = DisassemblyBackwardResult { session_id, target, instructions: serializable_instructions };
                if let Err(e) = handle.emit("disassembly-backward-updated", &result) {
                    error!("Failed to emit disassembly-backward-updated event: {}", e);
                }
            }
        }
        Err(e) => {
            error!("Failed to disassemble backward: {}", e);
            if let Some(ref handle) = app_handle_clone {
                let error_result = DisassemblyBackwardError { session_id, target, error: e.to_string() };
                if let Err(emit_err) = handle.emit("disassembly-backward-error", &error_result) {
                    error!("Failed to emit disassembly-backward-error event: {}", emit_err);
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
