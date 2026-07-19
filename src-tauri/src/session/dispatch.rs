use tauri::AppHandle;
use tracing::{debug, info, warn};

use super::bookmarks::*;
use super::breakpoints::*;
use super::callstack::*;
use super::disassembly::*;
use super::emulation::*;
use super::helpers::report_step_error;
use super::memory::*;
use super::patches::*;
use super::registers::*;
use super::runner::emit_session_event;
use super::source::*;
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
    let mut seen_disasm_backward: Option<(u64, u32)> = None;
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
            // Key on (target, count): rapid scroll enqueues many backward requests
            // with *different* targets — only drop exact-duplicate (target,count) pairs.
            UICommand::DisassembleBackward { target, count, .. } => {
                if seen_disasm_backward == Some((*target, *count)) {
                    keep[i] = false;
                    debug!("Dedup: dropping duplicate DisassembleBackward for 0x{:X}", target);
                } else {
                    seen_disasm_backward = Some((*target, *count));
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

/// Iteration backstop for a source-line step that never leaves its line
/// (deep recursion / tight loop). Far above any real line's instruction count.
const MAX_SOURCE_STEP_INSTRUCTIONS: u32 = 50_000;

/// Advance an in-progress source-line step on each `StepComplete`.
///
/// Called from the debug loop (`runner::on_event`) before the normal pause
/// decision. Returns:
/// - `None` — no source-line step is active; handle the event normally.
/// - `Some(true)` — still on the starting line: the next single step was issued,
///   so the caller should keep running (don't pause).
/// - `Some(false)` — the step finished (line changed, no line info, cap hit, or a
///   step error); `source_step` is cleared and the caller should pause normally.
pub(crate) fn advance_source_line_step(
    session: &mut DebugSession,
    pid: u32,
    tid: u32,
    address: u64,
) -> Option<bool> {
    let (kind, start, count) = {
        let mut s = session.state.lock().unwrap();
        let ss = s.source_step.as_mut()?;
        ss.count += 1;
        (ss.kind, ss.start.clone(), ss.count)
    };

    let keep_going = match &start {
        // No line info where we started → behave like a single instruction step.
        None => false,
        Some(start) => {
            if count >= MAX_SOURCE_STEP_INSTRUCTIONS {
                warn!("Source-line step hit iteration cap ({}); stopping", MAX_SOURCE_STEP_INSTRUCTIONS);
                false
            } else {
                let current = super::source::resolve_file_line(session, pid, address);
                // Keep stepping only while still on the exact same source line.
                matches!(&current, Some(c) if c == start)
            }
        }
    };

    if keep_going {
        // Arm the next single step; the debug loop's auto-continue resumes execution.
        if session
            .step(pid, tid, kind, |_s, _pid, _tid, _addr, _kind| {
                Ok(joybug2::protocol_io::StepAction::Stop)
            })
            .is_ok()
        {
            return Some(true);
        }
        // Step setup failed — stop cleanly below.
    }

    session.state.lock().unwrap().source_step = None;
    Some(false)
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
        UICommand::StepOverLine | UICommand::StepIntoLine => {
            let pid = event.pid();
            let tid = event.tid();
            let (kind, label) = match command {
                UICommand::StepIntoLine => (joybug2::protocol_io::StepKind::Into, "StepIntoLine"),
                _ => (joybug2::protocol_io::StepKind::Over, "StepOverLine"),
            };
            debug!("📤 {} command - pid={}, tid={}", label, pid, tid);

            // Record the starting source line. The debug loop (runner::on_event)
            // keeps single-stepping without pausing until the line changes.
            let start = session
                .get_thread_context(pid, tid)
                .ok()
                .map(|ctx| ctx.get_pc())
                .and_then(|pc| super::source::resolve_file_line(session, pid, pc));
            {
                let mut s = session.state.lock().unwrap();
                s.source_step = Some(crate::state::SourceStepState { kind, start, count: 0 });
            }

            // Kick off the first underlying step. The loop continuation lives in
            // runner::on_event so it plays nicely with the pause/continue machinery.
            if let Err(e) = session.step(pid, tid, kind, |_s, _pid, _tid, _addr, _kind| {
                Ok(joybug2::protocol_io::StepAction::Stop)
            }) {
                session.state.lock().unwrap().source_step = None;
                let msg = format!("{} failed: {}", label, e);
                report_step_error(session, app_handle_clone, &msg);
                debug!("{} failed; staying paused and awaiting next command", label);
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
        UICommand::DisassembleBackward { arch, target, count } => {
            process_disassembly_backward_request(session, app_handle_clone, event, arch, target, count);
            CommandResult::Continue
        }
        UICommand::GetCallStack => {
            process_callstack_request(session, app_handle_clone, event);
            CommandResult::Continue
        }
        UICommand::ResolveAddressToLine { address } => {
            process_resolve_address_to_line(session, app_handle_clone, event, address);
            CommandResult::Continue
        }
        UICommand::GetSourceFileLineMap { module_base, ref file_path, start_line, end_line } => {
            process_get_source_file_line_map(session, app_handle_clone, event, module_base, file_path, start_line, end_line);
            CommandResult::Continue
        }
        UICommand::ListSourceFiles { module_base } => {
            process_list_source_files(session, app_handle_clone, event, module_base);
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
        UICommand::ToggleBreakpoint { address, single_shot } => {
            process_toggle_breakpoint(session, app_handle_clone, event.pid(), address, single_shot);
            CommandResult::Continue
        }
        UICommand::SetBreakpoints { ref addresses, ref group, single_shot } => {
            process_set_breakpoints(session, app_handle_clone, event.pid(), addresses, group.clone(), single_shot);
            CommandResult::Continue
        }
        UICommand::SyncAutoBreakpoints => {
            process_sync_auto_breakpoints(session, app_handle_clone, event.pid());
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
        UICommand::StartWatchpointTrace { address, ref hw_type, hw_size } => {
            process_start_watchpoint_trace(session, app_handle_clone, event.pid(), address, hw_type, hw_size);
            CommandResult::Continue
        }
        UICommand::StopWatchpointTrace { ref breakpoint_id } => {
            process_stop_watchpoint_trace(session, app_handle_clone, event.pid(), breakpoint_id);
            CommandResult::Continue
        }
        UICommand::GetThreadCallStack { tid } => {
            process_thread_callstack_request(session, app_handle_clone, event.pid(), tid);
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
        UICommand::AddBookmark { ref kind, address, ref value_type, ref name, ref comment, ref pointer_offsets, ref base_symbol, ref asm_text } => {
            process_add_bookmark(session, app_handle_clone, event.pid(), kind.clone(), address, value_type.clone(), name.clone(), comment.clone(), pointer_offsets.clone(), base_symbol.clone(), asm_text.clone());
            CommandResult::Continue
        }
        UICommand::RemoveBookmark { ref id } => {
            process_remove_bookmark(session, app_handle_clone, event.pid(), id);
            CommandResult::Continue
        }
        UICommand::RemoveBookmarks { ref ids } => {
            process_remove_bookmarks(session, app_handle_clone, event.pid(), ids);
            CommandResult::Continue
        }
        UICommand::UpdateBookmark { ref id, ref name, ref comment, ref group, ref value_type } => {
            process_update_bookmark(session, app_handle_clone, event.pid(), id, name.clone(), comment.clone(), group.clone(), value_type.clone());
            CommandResult::Continue
        }
        UICommand::SetBookmarkValue { ref id, ref value } => {
            process_set_bookmark_value(session, app_handle_clone, event.pid(), id, value);
            CommandResult::Continue
        }
        UICommand::ToggleBookmarkLock { ref id, locked } => {
            process_toggle_bookmark_lock(session, app_handle_clone, event.pid(), id, locked);
            CommandResult::Continue
        }
        UICommand::RefreshBookmarks => {
            process_refresh_bookmarks(session, app_handle_clone, event.pid());
            CommandResult::Continue
        }
        UICommand::Detach => {
            let pid = event.pid();
            info!("Detach command received for pid {}", pid);
            let session_id = session.state.lock().unwrap().id.clone();
            match session.send_and_receive(&joybug2::protocol::DebuggerRequest::Detach { pid }) {
                Ok(_) => {
                    if let Some(handle) = app_handle_clone.as_ref() {
                        crate::ui_logger::log_info(handle, &format!("Detached from process {}", pid), Some(session_id.clone()));
                        crate::ui_logger::toast_info(handle, &format!("Detached from process {} (still running)", pid));
                    }
                }
                Err(e) => {
                    let msg = format!("Detach failed: {}", e);
                    warn!("{}", msg);
                    if let Some(handle) = app_handle_clone.as_ref() {
                        crate::ui_logger::log_error(handle, &msg, Some(session_id.clone()));
                        crate::ui_logger::toast_error(handle, &msg);
                    }
                }
            }
            session.state.lock().unwrap().status = SessionStatusUI::Stopped;
            CommandResult::StopSession
        }
        UICommand::Stop => {
            info!("Stop command received, terminating session");
            let mut state = session.state.lock().unwrap();
            state.status = SessionStatusUI::Stopped;
            CommandResult::StopSession
        }
    }
}
