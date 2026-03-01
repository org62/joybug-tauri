use tauri::AppHandle;
use tracing::{debug, info, warn};

use super::breakpoints::*;
use super::callstack::*;
use super::disassembly::*;
use super::emulation::*;
use super::helpers::report_step_error;
use super::memory::*;
use super::registers::*;
use super::runner::emit_session_event;
use super::symbols::*;
use super::types::{DebugSession, UICommand};
use crate::error::Result;
use crate::state::SessionStatusUI;

/// Result of dispatching a single command
enum CommandResult {
    /// Command processed, continue the dispatch loop
    Continue,
    /// Command requires returning from handle_ui_commands
    Return(Result<bool>),
}

/// Extract the timestamp suffix from a quick-emulation request_id (e.g., "quick-syscall-1234" → "1234")
fn emulation_request_timestamp(cmd: &UICommand) -> Option<&str> {
    if let UICommand::Emulate { ref request_id, .. } = cmd {
        if let Some(ref rid) = request_id {
            if rid.starts_with("quick-") {
                return rid.rsplit('-').next();
            }
        }
    }
    None
}

/// Dispatch a single UICommand
fn dispatch_command(
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
            CommandResult::Return(Ok(true))
        }
        UICommand::StepIn => {
            let pid = event.pid();
            let tid = event.tid();

            debug!("📤 StepIn command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid,
                tid,
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
            CommandResult::Return(Ok(true))
        }
        UICommand::StepOver => {
            let pid = event.pid();
            let tid = event.tid();

            debug!("📤 StepOver command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid,
                tid,
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
            CommandResult::Return(Ok(true))
        }
        UICommand::StepOut => {
            let pid = event.pid();
            let tid = event.tid();

            debug!("📤 StepOut command - pid={}, tid={}", pid, tid);

            if let Err(e) = session.step(
                pid,
                tid,
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
            CommandResult::Return(Ok(true))
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
        UICommand::Emulate { max_instructions, mode, ref exit_condition, ref request_id } => {
            process_emulation_request(session, app_handle_clone, event, max_instructions, mode, exit_condition.clone(), request_id.clone());
            CommandResult::Continue
        }
        UICommand::SetRegister { ref register_name, value } => {
            process_set_register(session, app_handle_clone, event, register_name, value);
            CommandResult::Continue
        }
        UICommand::ToggleBreakpoint { address } => {
            process_toggle_breakpoint(session, app_handle_clone, event, address);
            CommandResult::Continue
        }
        UICommand::RemoveBreakpoint { ref breakpoint_id } => {
            process_remove_breakpoint(session, app_handle_clone, event, breakpoint_id);
            CommandResult::Continue
        }
        UICommand::EnableBreakpoint { ref breakpoint_id, enabled } => {
            process_enable_breakpoint(session, app_handle_clone, event, breakpoint_id, enabled);
            CommandResult::Continue
        }
        UICommand::EnableBreakpointGroup { ref group, enabled } => {
            process_enable_breakpoint_group(session, app_handle_clone, event, group, enabled);
            CommandResult::Continue
        }
        UICommand::UpdateBreakpoint { ref breakpoint_id, ref name, ref group } => {
            process_update_breakpoint(session, app_handle_clone, breakpoint_id, name.clone(), group.clone());
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
        UICommand::Stop => {
            info!("Stop command received, terminating session");
            let mut state = session.state.lock().unwrap();
            state.status = SessionStatusUI::Stopped;
            CommandResult::Return(Ok(false))
        }
    }
}

/// Handles UI commands in a loop, returns true to continue execution, false to stop session
pub(crate) fn handle_ui_commands(
    ui_receiver: &std::sync::mpsc::Receiver<UICommand>,
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) -> Result<bool> {
    loop {
        match ui_receiver.recv() {
            Ok(command) => {
                info!("Received UI command: {:?}", command);

                // When we receive an emulation request, drain any pending commands from the
                // channel and skip stale emulation batches. This prevents the UI from hanging
                // when rapid stepping produces multiple emulation batches that queue up.
                if emulation_request_timestamp(&command).is_some() {
                    let mut batch = vec![command];
                    while let Ok(next) = ui_receiver.try_recv() {
                        batch.push(next);
                    }

                    // Find the latest quick-emulation timestamp in the batch
                    let latest_ts = batch.iter()
                        .filter_map(|c| emulation_request_timestamp(c))
                        .max()
                        .map(|s| s.to_owned());

                    for cmd in batch {
                        // Check for new commands that arrived while we were processing
                        // (e.g., a step command sent while emulation was running).
                        // Prioritize stepping/go/stop commands over remaining emulations.
                        while let Ok(urgent) = ui_receiver.try_recv() {
                            let is_priority = matches!(&urgent, UICommand::Go | UICommand::StepIn | UICommand::StepOver | UICommand::StepOut | UICommand::Stop);
                            if is_priority {
                                info!("Priority command received during emulation batch: {:?}", urgent);
                                match dispatch_command(urgent, session, app_handle_clone, event) {
                                    CommandResult::Continue => {}
                                    CommandResult::Return(val) => return val,
                                }
                            }
                            // Non-priority commands that arrived: just process them normally
                            // after the current batch finishes (they'll be picked up in the next loop)
                            // We can't easily re-queue them, so process inline
                            else {
                                info!("Dispatching interleaved command: {:?}", urgent);
                                match dispatch_command(urgent, session, app_handle_clone, event) {
                                    CommandResult::Continue => {}
                                    CommandResult::Return(val) => return val,
                                }
                            }
                        }

                        let ts = emulation_request_timestamp(&cmd).map(|s| s.to_owned());
                        // Skip stale emulation requests (older timestamp than newest in batch)
                        if let (Some(ref cmd_ts), Some(ref newest)) = (&ts, &latest_ts) {
                            if cmd_ts != newest {
                                debug!("⏭️ Skipping stale emulation request (ts={}, latest={})", cmd_ts, newest);
                                continue;
                            }
                        }
                        info!("Dispatching command: {:?}", cmd);
                        match dispatch_command(cmd, session, app_handle_clone, event) {
                            CommandResult::Continue => {}
                            CommandResult::Return(val) => return val,
                        }
                    }
                    continue;
                }

                match dispatch_command(command, session, app_handle_clone, event) {
                    CommandResult::Continue => {}
                    CommandResult::Return(val) => return val,
                }
            }
            Err(_) => {
                debug!("❌ Debug session receiver disconnected");
                warn!("Debug session receiver disconnected");
                let mut state = session.state.lock().unwrap();
                state.status = SessionStatusUI::Error("Step receiver disconnected".to_string());
                return Ok(false);
            }
        }
    }
}
