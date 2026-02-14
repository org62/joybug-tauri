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

                match command {
                    UICommand::Go => {
                        debug!("📤 Go command - continuing execution");
                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
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
                            continue;
                        }

                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
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
                            continue;
                        }

                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
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
                            continue;
                        }

                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
                    }
                    UICommand::Disassembly { arch, address, count } => {
                        process_disassembly_request(session, app_handle_clone, event, arch, address, count);
                    }
                    UICommand::DisassembleFunction { arch, address, max_instructions } => {
                        process_function_disassembly_request(session, app_handle_clone, event, arch, address, max_instructions);
                    }
                    UICommand::GetCallStack => {
                        process_callstack_request(session, app_handle_clone, event);
                    }
                    UICommand::SearchSymbols { ref pattern, limit } => {
                        process_symbol_search(session, app_handle_clone, event, pattern, limit);
                    }
                    UICommand::ReadMemory { address, size } => {
                        process_memory_read(session, app_handle_clone, event, address, size);
                    }
                    UICommand::WriteMemory { address, ref data } => {
                        process_memory_write(session, app_handle_clone, event, address, data);
                    }
                    UICommand::GetMemoryRegions => {
                        process_memory_regions_request(session, app_handle_clone, event);
                    }
                    UICommand::Dereference { address, count } => {
                        process_dereference_request(session, app_handle_clone, event, address, count);
                    }
                    UICommand::Emulate { max_instructions, mode, ref exit_condition, ref request_id } => {
                        process_emulation_request(session, app_handle_clone, event, max_instructions, mode, exit_condition.clone(), request_id.clone());
                    }
                    UICommand::SetRegister { ref register_name, value } => {
                        process_set_register(session, app_handle_clone, event, register_name, value);
                    }
                    UICommand::ToggleBreakpoint { address } => {
                        process_toggle_breakpoint(session, app_handle_clone, event, address);
                    }
                    UICommand::RemoveBreakpoint { ref breakpoint_id } => {
                        process_remove_breakpoint(session, app_handle_clone, event, breakpoint_id);
                    }
                    UICommand::EnableBreakpoint { ref breakpoint_id, enabled } => {
                        process_enable_breakpoint(session, app_handle_clone, event, breakpoint_id, enabled);
                    }
                    UICommand::EnableBreakpointGroup { ref group, enabled } => {
                        process_enable_breakpoint_group(session, app_handle_clone, event, group, enabled);
                    }
                    UICommand::UpdateBreakpoint { ref breakpoint_id, ref name, ref group } => {
                        process_update_breakpoint(session, app_handle_clone, breakpoint_id, name.clone(), group.clone());
                    }
                    UICommand::GetThreadCallStack { tid } => {
                        process_thread_callstack_request(session, app_handle_clone, event, tid);
                    }
                    UICommand::ResolveThreadSymbols => {
                        process_resolve_thread_symbols(session, app_handle_clone, event);
                    }
                    UICommand::GetModuleExtraInfo { module_base } => {
                        process_module_extra_info_request(session, app_handle_clone, event, module_base);
                    }
                    UICommand::Stop => {
                        info!("Stop command received, terminating session");
                        let mut state = session.state.lock().unwrap();
                        state.status = SessionStatusUI::Stopped;
                        return Ok(false);
                    }
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
