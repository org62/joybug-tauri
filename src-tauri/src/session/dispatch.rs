use tauri::AppHandle;
use tracing::{debug, info, warn};

use super::breakpoints::*;
use super::callstack::*;
use super::disassembly::*;
use super::emulation::*;
use super::helpers::report_step_error;
use super::memory::*;
use super::patches::*;
use super::pointer_scan::*;
use super::registers::*;
use super::runner::emit_session_event;
use super::symbols::*;
use super::types::{DebugSession, UICommand};
use crate::error::Result;
use crate::state::SessionStatusUI;

/// Dedup a batch of commands, keeping only the last occurrence of idempotent commands.
/// Multiple `DereferenceBatch` commands are merged (addresses combined) rather than dropped.
fn dedup_commands(commands: Vec<UICommand>) -> Vec<UICommand> {
    // Track which idempotent command types we've seen (scanning from the end)
    let mut seen_fn_disasm: Option<u64> = None;
    let mut seen_disasm: Option<u64> = None;
    let mut seen_callstack = false;
    let mut seen_deref_batch = false;
    let mut seen_resolve_thread_symbols = false;

    // Collect all DereferenceBatch addresses for merging
    let mut merged_deref_addresses: Vec<u64> = Vec::new();
    let deref_batch_count = commands.iter()
        .filter(|c| matches!(c, UICommand::DereferenceBatch { .. }))
        .count();
    if deref_batch_count > 1 {
        for cmd in &commands {
            if let UICommand::DereferenceBatch { addresses } = cmd {
                merged_deref_addresses.extend_from_slice(addresses);
            }
        }
        merged_deref_addresses.sort_unstable();
        merged_deref_addresses.dedup();
    }

    // Scan from the end so we keep the LAST occurrence of each idempotent command
    let mut keep = vec![true; commands.len()];
    for i in (0..commands.len()).rev() {
        match &commands[i] {
            UICommand::DisassembleFunction { address, .. } => {
                if seen_fn_disasm == Some(*address) {
                    keep[i] = false;
                    debug!("Dedup: dropping duplicate DisassembleFunction for 0x{:X}", address);
                } else {
                    seen_fn_disasm = Some(*address);
                }
            }
            UICommand::Disassembly { address, .. } => {
                if seen_disasm == Some(*address) {
                    keep[i] = false;
                    debug!("Dedup: dropping duplicate Disassembly for 0x{:X}", address);
                } else {
                    seen_disasm = Some(*address);
                }
            }
            UICommand::GetCallStack => {
                if seen_callstack {
                    keep[i] = false;
                    debug!("Dedup: dropping duplicate GetCallStack");
                } else {
                    seen_callstack = true;
                }
            }
            UICommand::DereferenceBatch { .. } => {
                if seen_deref_batch {
                    keep[i] = false;
                    debug!("Dedup: merging earlier DereferenceBatch");
                } else {
                    seen_deref_batch = true;
                }
            }
            UICommand::ResolveThreadSymbols => {
                if seen_resolve_thread_symbols {
                    keep[i] = false;
                    debug!("Dedup: dropping duplicate ResolveThreadSymbols");
                } else {
                    seen_resolve_thread_symbols = true;
                }
            }
            _ => {}
        }
    }

    let mut result = Vec::with_capacity(commands.len());
    for (i, cmd) in commands.into_iter().enumerate() {
        if !keep[i] {
            continue;
        }
        // Replace the surviving DereferenceBatch with merged addresses if we merged
        if deref_batch_count > 1 {
            if let UICommand::DereferenceBatch { .. } = &cmd {
                result.push(UICommand::DereferenceBatch { addresses: merged_deref_addresses.clone() });
                continue;
            }
        }
        result.push(cmd);
    }
    result
}

/// Handles UI commands in a loop, returns true to continue execution, false to stop session
pub(crate) fn handle_ui_commands(
    ui_receiver: &std::sync::mpsc::Receiver<UICommand>,
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) -> Result<bool> {
    loop {
        // Block until at least one command arrives
        let first = match ui_receiver.recv() {
            Ok(cmd) => cmd,
            Err(_) => {
                debug!("❌ Debug session receiver disconnected");
                warn!("Debug session receiver disconnected");
                let mut state = session.state.lock().unwrap();
                state.status = SessionStatusUI::Error("Step receiver disconnected".to_string());
                return Ok(false);
            }
        };

        // Drain any additional pending commands and dedup the batch
        let mut batch = vec![first];
        while let Ok(cmd) = ui_receiver.try_recv() {
            batch.push(cmd);
        }
        if batch.len() > 1 {
            debug!("Batched {} commands, deduplicating", batch.len());
            batch = dedup_commands(batch);
            debug!("After dedup: {} commands", batch.len());
        }

        // Process the deduped batch
        for command in batch {
            info!("Processing UI command: {:?}", command);

            match process_command(command, session, app_handle_clone, event) {
                CommandResult::Continue => {}
                CommandResult::ResumeExecution => return Ok(true),
                CommandResult::StopSession => return Ok(false),
            }
        }
    }
}

enum CommandResult {
    /// Keep processing commands (stay paused)
    Continue,
    /// Resume debuggee execution (Go/Step)
    ResumeExecution,
    /// Terminate the session
    StopSession,
}

fn process_command(
    command: UICommand,
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) -> CommandResult {
    match command {
        UICommand::Go => {
            debug!("📤 Go command - continuing execution");
            if let Some(handle) = app_handle_clone.as_ref() {
                let mut s = session.state.lock().unwrap();
                s.status = SessionStatusUI::Running;
                drop(s);
                emit_session_event(&session.state, handle);
            }
            CommandResult::ResumeExecution
        }
        UICommand::GoPassException => {
            debug!("📤 GoPassException command - continuing with exception passed to application");
            if let Some(handle) = app_handle_clone.as_ref() {
                let mut s = session.state.lock().unwrap();
                s.pass_exception_on_continue = true;
                s.status = SessionStatusUI::Running;
                drop(s);
                emit_session_event(&session.state, handle);
            }
            CommandResult::ResumeExecution
        }
        UICommand::StepIn => {
            let pid = event.pid();
            let tid = event.tid();
            debug!("📤 StepIn command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid, tid,
                joybug2::protocol_io::StepKind::Into,
                |_s, _pid, _tid, _addr, _kind| {
                    debug!("📥 StepIn handler called");
                    Ok(joybug2::protocol_io::StepAction::Stop)
                },
            ) {
                let msg = format!("Step in failed: {}", e);
                report_step_error(session, app_handle_clone, &msg);
                debug!("StepIn failed; staying paused and awaiting next command");
                return CommandResult::Continue;
            }

            if let Some(handle) = app_handle_clone.as_ref() {
                let mut s = session.state.lock().unwrap();
                s.status = SessionStatusUI::Running;
                drop(s);
                emit_session_event(&session.state, handle);
            }
            CommandResult::ResumeExecution
        }
        UICommand::StepOver => {
            let pid = event.pid();
            let tid = event.tid();
            debug!("📤 StepOver command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid, tid,
                joybug2::protocol_io::StepKind::Over,
                |_s, _pid, _tid, _addr, _kind| {
                    debug!("📥 StepOver handler called");
                    Ok(joybug2::protocol_io::StepAction::Stop)
                },
            ) {
                let msg = format!("Step over failed: {}", e);
                report_step_error(session, app_handle_clone, &msg);
                debug!("StepOver failed; staying paused and awaiting next command");
                return CommandResult::Continue;
            }

            if let Some(handle) = app_handle_clone.as_ref() {
                let mut s = session.state.lock().unwrap();
                s.status = SessionStatusUI::Running;
                drop(s);
                emit_session_event(&session.state, handle);
            }
            CommandResult::ResumeExecution
        }
        UICommand::StepOut => {
            let pid = event.pid();
            let tid = event.tid();
            debug!("📤 StepOut command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid, tid,
                joybug2::protocol_io::StepKind::Out,
                |_s, _pid, _tid, _addr, _kind| {
                    debug!("📥 StepOut handler called");
                    Ok(joybug2::protocol_io::StepAction::Stop)
                },
            ) {
                let msg = format!("Step out failed: {}", e);
                report_step_error(session, app_handle_clone, &msg);
                debug!("StepOut failed; staying paused and awaiting next command");
                return CommandResult::Continue;
            }

            if let Some(handle) = app_handle_clone.as_ref() {
                let mut s = session.state.lock().unwrap();
                s.status = SessionStatusUI::Running;
                drop(s);
                emit_session_event(&session.state, handle);
            }
            CommandResult::ResumeExecution
        }
        UICommand::Disassembly { arch, address, count } => {
            process_disassembly_request(session, app_handle_clone, event, arch, address, count);
            CommandResult::Continue
        }
        UICommand::DisassembleFunction { arch, address, max_instructions } => {
            process_function_disassembly_request(session, app_handle_clone, event, arch, address, max_instructions);
            CommandResult::Continue
        }
        UICommand::GetCallStack => {
            process_callstack_request(session, app_handle_clone, event);
            CommandResult::Continue
        }
        UICommand::SearchSymbols { ref pattern, limit } => {
            process_symbol_search(session, app_handle_clone, event, pattern, limit);
            CommandResult::Continue
        }
        UICommand::ReadMemory { address, size } => {
            process_memory_read(session, app_handle_clone, event, address, size);
            CommandResult::Continue
        }
        UICommand::WriteMemory { address, ref data } => {
            process_memory_write(session, app_handle_clone, event, address, data);
            CommandResult::Continue
        }
        UICommand::GetMemoryRegions => {
            process_memory_regions_request(session, app_handle_clone, event);
            CommandResult::Continue
        }
        UICommand::Dereference { address, count } => {
            process_dereference_request(session, app_handle_clone, event, address, count);
            CommandResult::Continue
        }
        UICommand::DereferenceBatch { ref addresses } => {
            process_dereference_batch(session, app_handle_clone, event, addresses);
            CommandResult::Continue
        }
        UICommand::Emulate { max_instructions, mode, ref exit_condition, ref request_id, ref memory_reads } => {
            process_emulation_request(session, app_handle_clone, event, max_instructions, mode, exit_condition.clone(), request_id.clone(), memory_reads.clone());
            CommandResult::Continue
        }
        UICommand::SetRegister { ref register_name, value } => {
            process_set_register(session, app_handle_clone, event, register_name, value);
            CommandResult::Continue
        }
        UICommand::ToggleBreakpoint { address } => {
            process_toggle_breakpoint(session, app_handle_clone, event.pid(), address);
            CommandResult::Continue
        }
        UICommand::RemoveBreakpoint { ref breakpoint_id } => {
            process_remove_breakpoint(session, app_handle_clone, event.pid(), breakpoint_id);
            CommandResult::Continue
        }
        UICommand::RemoveBreakpoints { ref breakpoint_ids } => {
            process_remove_breakpoints(session, app_handle_clone, event.pid(), breakpoint_ids);
            CommandResult::Continue
        }
        UICommand::EnableBreakpoint { ref breakpoint_id, enabled } => {
            process_enable_breakpoint(session, app_handle_clone, event.pid(), breakpoint_id, enabled);
            CommandResult::Continue
        }
        UICommand::EnableBreakpointGroup { ref group, enabled } => {
            process_enable_breakpoint_group(session, app_handle_clone, event.pid(), group, enabled);
            CommandResult::Continue
        }
        UICommand::UpdateBreakpoint { ref breakpoint_id, ref name, ref group } => {
            process_update_breakpoint(session, app_handle_clone, breakpoint_id, name.clone(), group.clone());
            CommandResult::Continue
        }
        UICommand::SetHardwareBreakpoint { address, ref hw_type, hw_size } => {
            process_set_hardware_breakpoint(session, app_handle_clone, event.pid(), address, hw_type, hw_size);
            CommandResult::Continue
        }
        UICommand::GetThreadCallStack { tid } => {
            process_thread_callstack_request(session, app_handle_clone, event, tid);
            CommandResult::Continue
        }
        UICommand::ResolveThreadSymbols => {
            process_resolve_thread_symbols(session, app_handle_clone, event);
            CommandResult::Continue
        }
        UICommand::GetModuleExtraInfo { module_base } => {
            process_module_extra_info_request(session, app_handle_clone, event, module_base);
            CommandResult::Continue
        }
        UICommand::SearchMemory { pattern, max_results } => {
            process_memory_search(session, app_handle_clone, event, pattern, max_results);
            CommandResult::Continue
        }
        UICommand::ScanMemoryStart { ref value_type, ref compare_type, ref value, ref value2, alignment, float_tolerance, writable_only, thread_count } => {
            process_scan_memory_start(session, app_handle_clone, event, value_type, compare_type, value.clone(), value2.clone(), alignment, float_tolerance, writable_only, thread_count);
            CommandResult::Continue
        }
        UICommand::ScanMemoryNext { scan_id, ref value_type, ref compare_type, ref value, ref value2 } => {
            process_scan_memory_next(session, app_handle_clone, scan_id, value_type, compare_type, value.clone(), value2.clone());
            CommandResult::Continue
        }
        UICommand::ScanMemoryGetResults { scan_id, offset, count } => {
            process_scan_memory_get_results(session, app_handle_clone, scan_id, offset, count);
            CommandResult::Continue
        }
        UICommand::ScanMemoryReset { scan_id } => {
            process_scan_memory_reset(session, app_handle_clone, scan_id);
            CommandResult::Continue
        }
        UICommand::PointerScanStart { target_address, max_offset, max_depth, max_results, ref modules } => {
            process_pointer_scan_start(session, app_handle_clone, event, target_address, max_offset, max_depth, max_results, modules.clone());
            CommandResult::Continue
        }
        UICommand::PointerScanGetResults { scan_id, offset, count } => {
            process_pointer_scan_get_results(session, app_handle_clone, event, scan_id, offset, count);
            CommandResult::Continue
        }
        UICommand::PointerScanReset { scan_id } => {
            process_pointer_scan_reset(session, app_handle_clone, scan_id);
            CommandResult::Continue
        }
        UICommand::AssemblePatch { address, ref assembly_text, arch, nop_pad } => {
            process_assemble_patch(session, app_handle_clone, event, address, assembly_text.clone(), arch, nop_pad);
            CommandResult::Continue
        }
        UICommand::UndoPatch { ref patch_id } => {
            process_undo_patch(session, app_handle_clone, event, patch_id);
            CommandResult::Continue
        }
        UICommand::UndoPatches { ref patch_ids } => {
            process_undo_patches(session, app_handle_clone, event, patch_ids);
            CommandResult::Continue
        }
        UICommand::EnablePatch { ref patch_id, enabled } => {
            process_enable_patch(session, app_handle_clone, event, patch_id, enabled);
            CommandResult::Continue
        }
        UICommand::UpdatePatch { ref patch_id, ref group } => {
            process_update_patch(session, app_handle_clone, patch_id, group.clone());
            CommandResult::Continue
        }
        UICommand::EnablePatchGroup { ref group, enabled } => {
            process_enable_patch_group(session, app_handle_clone, event, group, enabled);
            CommandResult::Continue
        }
        UICommand::Stop => {
            info!("Stop command received, terminating session");
            let mut state = session.state.lock().unwrap();
            state.status = SessionStatusUI::Stopped;
            CommandResult::StopSession
        }
    }
}
