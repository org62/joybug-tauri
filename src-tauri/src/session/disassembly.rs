use std::sync::Arc;

use joybug2::interfaces::{Architecture, DisassemblerProvider};
use joybug2::windows_platform::disassembler::CapstoneDisassembler;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::helpers::{effective_op_str, hex_join};
use super::image_cache::{ensure_and_snapshot_images, OriginalModuleImage};
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

/// Everything needed to compare live instruction bytes against the original
/// on-disk image. `None` disables the comparison (PE viewer, ARM64, or when no
/// module images are available). Built per disassembly response.
pub(crate) struct ImageDiff {
    images: Vec<Arc<OriginalModuleImage>>,
    disasm: CapstoneDisassembler,
    arch: Architecture,
}

/// Build the disassembler + original-image snapshot for a live session's
/// disassembly response. `None` (no disk-backed modules, or capstone init
/// failure) disables the diff.
pub(crate) fn build_image_diff_context(
    state_arc: &Arc<std::sync::Mutex<SessionStateUI>>,
    arch: Architecture,
    address: u64,
) -> Option<ImageDiff> {
    let images = ensure_and_snapshot_images(state_arc, address);
    if images.is_empty() {
        return None;
    }
    match CapstoneDisassembler::new() {
        Ok(disasm) => Some(ImageDiff { images, disasm, arch }),
        Err(e) => {
            error!("Failed to init disassembler for image diff: {:?}", e);
            None
        }
    }
}

/// Disassemble `buf` at `address`, joining instruction texts with "; " until at
/// least `min_len` bytes are covered — the buffer may extend past `min_len` so
/// a trailing instruction decodes fully. Covers changed instruction boundaries
/// (e.g. a 1-byte NOP written over a 5-byte call decodes several originals).
/// `None` when nothing decodes.
pub(crate) fn disasm_covering(
    disasm: &CapstoneDisassembler,
    arch: Architecture,
    buf: &[u8],
    address: u64,
    min_len: usize,
) -> Option<String> {
    let insts = disasm.disassemble(arch, buf, address, 16).ok()?;
    let mut parts: Vec<String> = Vec::new();
    let mut covered = 0usize;
    for inst in &insts {
        let text = format!("{} {}", inst.mnemonic, inst.op_str);
        parts.push(text.trim().to_string());
        covered += inst.bytes.len();
        if covered >= min_len {
            break;
        }
    }
    if parts.is_empty() { None } else { Some(parts.join("; ")) }
}

/// Disassemble the original image bytes covering `[address, address+row_len)`.
fn disasm_original_at(
    diff: &ImageDiff,
    image: &OriginalModuleImage,
    address: u64,
    row_len: usize,
) -> Option<String> {
    // Read a little extra so a longer original instruction fully decodes, but
    // fall back to exactly row_len at a section/image tail.
    let buf = image
        .bytes_at(address, row_len.max(16))
        .or_else(|| image.bytes_at(address, row_len))?;
    disasm_covering(&diff.disasm, diff.arch, buf, address, row_len)
}

/// Converts raw disassembled instructions into serializable form. `symbols` is
/// populated only for instructions sitting exactly at a symbol (offset 0) —
/// the frontend renders those as label rows above the instruction; the first
/// column always shows the raw address.
pub(crate) fn serialize_instructions(
    instructions: &[joybug2::interfaces::Instruction],
    patched_ranges: &[(u64, u64)],
    image_diff: Option<&ImageDiff>,
) -> Vec<SerializableInstruction> {
    instructions
        .iter()
        .map(|inst| {
            // All names starting exactly at this address (e.g. NtClose/ZwClose
            // aliases) — every decode path populates this (the trait default
            // seeds it from `symbol_info` at exact symbol starts).
            let symbols: Vec<String> = inst
                .symbols_at_address
                .iter()
                .map(|s| s.format_symbol())
                .collect();

            let op_str = effective_op_str(inst);

            let is_patched_by_range = patched_ranges
                .iter()
                .any(|&(start, end)| inst.address >= start && inst.address < end);

            // Compare against the original on-disk image (code sections only).
            let mut differs_from_image = false;
            let mut original_bytes = None;
            let mut original_disasm = None;
            if let Some(diff) = image_diff {
                if let Some(image) = diff
                    .images
                    .iter()
                    .find(|im| !im.unavailable && im.contains(inst.address))
                {
                    if image.is_code(inst.address) {
                        if let Some(orig) = image.bytes_at(inst.address, inst.bytes.len()) {
                            if orig != inst.bytes.as_slice() {
                                differs_from_image = true;
                                original_bytes = Some(hex_join(orig));
                                original_disasm =
                                    disasm_original_at(diff, image, inst.address, inst.bytes.len());
                            }
                        }
                    }
                }
            }

            SerializableInstruction {
                address: format!("{:#X}", inst.address),
                symbols,
                bytes: hex_join(&inst.bytes),
                mnemonic: inst.mnemonic.clone(),
                op_str,
                is_jump: inst.is_jump,
                is_call: inst.is_call,
                is_ret: inst.is_ret,
                jump_target: inst.jump_target.map(|addr| format!("{:#X}", addr)),
                is_patched: is_patched_by_range || differs_from_image,
                original_bytes,
                original_disasm,
                source_file: inst.line_info.as_ref().map(|l| l.file_path.clone()),
                source_line: inst.line_info.as_ref().map(|l| l.line),
                is_invalid: inst.is_invalid,
            }
        })
        .collect()
}

/// Processes a disassembly request and emits results to the frontend
pub(crate) fn process_disassembly_request(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    count: u32,
    compare_image: bool,
) {
    debug!("📤 Processing disassembly request: pid={}, address=0x{:X}, count={}", pid, address, count);
    let patched_ranges = applied_patch_ranges(&session.state.lock().unwrap());
    let image_diff = compare_image.then(|| build_image_diff_context(&session.state, arch, address)).flatten();
    match session.disassemble_memory(pid, address, count as usize, arch) {
        Ok(instructions) => {
            debug!("📥 Received {} instructions from disassemble_memory", instructions.len());

            let serializable_instructions = serialize_instructions(&instructions, &patched_ranges, image_diff.as_ref());

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
    pid: u32,
    arch: joybug2::interfaces::Architecture,
    target: u64,
    count: u32,
    compare_image: bool,
) {
    debug!("📤 Processing backward disassembly request: pid={}, target=0x{:X}, count={}", pid, target, count);
    let (patched_ranges, session_id) = {
        let state = session.state.lock().unwrap();
        (applied_patch_ranges(&state), state.id.clone())
    };
    let image_diff = compare_image.then(|| build_image_diff_context(&session.state, arch, target)).flatten();

    match session.disassemble_backward(pid, target, count as usize, arch) {
        Ok(instructions) => {
            let serializable_instructions = serialize_instructions(&instructions, &patched_ranges, image_diff.as_ref());
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
    pid: u32,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    max_instructions: u32,
    compare_image: bool,
) {
    debug!("📤 Processing function disassembly request: pid={}, address=0x{:X}, max_instructions={}", pid, address, max_instructions);

    let patched_ranges = applied_patch_ranges(&session.state.lock().unwrap());
    let image_diff = compare_image.then(|| build_image_diff_context(&session.state, arch, address)).flatten();
    match session.disassemble_function(pid, address, max_instructions as usize, arch) {
        Ok((instructions, function_start, function_end, function_name)) => {
            debug!("📥 Received {} instructions from disassemble_function", instructions.len());

            let serializable_instructions = serialize_instructions(&instructions, &patched_ranges, image_diff.as_ref());

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
