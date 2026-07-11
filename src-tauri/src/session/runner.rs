use crate::error::{Error, Result};
use crate::settings::SettingsState;
use crate::state::{SessionStateUI, SessionStatusUI};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info};

use super::bookmarks::reapply_bookmarks_for_module;
use super::breakpoints::{deactivate_breakpoints_for_module, emit_breakpoints_event, reapply_breakpoints_for_module};
use super::patches::{deactivate_patches_for_module, emit_patches_event, reapply_patches_for_module};
use super::dispatch::handle_ui_commands;
use super::helpers::{module_short_name, update_session_from_event};
use super::types::DebugSession;

/// Reapply or deactivate breakpoints and patches in response to module load/unload events.
/// `state` must NOT be locked when calling this.
fn handle_event_breakpoints(
    session: &mut DebugSession,
    event: &joybug2::protocol_io::DebugEvent,
    unloaded_module_name: &Option<String>,
) {
    match event {
        joybug2::protocol_io::DebugEvent::DllLoaded { dll_name, base_of_dll, .. } => {
            let name = dll_name.as_deref().unwrap_or("<unknown>");
            let short = module_short_name(name);
            // Patches must be applied BEFORE breakpoints so that patches read real
            // binary bytes (not 0xCC) and breakpoints store patched bytes as originals.
            reapply_patches_for_module(session, event.pid(), &short, *base_of_dll);
            reapply_breakpoints_for_module(session, event.pid(), &short, *base_of_dll);
            reapply_bookmarks_for_module(session, event.pid(), &short);
        }
        joybug2::protocol_io::DebugEvent::ProcessCreated { image_file_name, base_of_image, .. } => {
            let name = image_file_name.as_deref().unwrap_or("main.exe");
            let short = module_short_name(name);
            reapply_patches_for_module(session, event.pid(), &short, *base_of_image);
            reapply_breakpoints_for_module(session, event.pid(), &short, *base_of_image);
            reapply_bookmarks_for_module(session, event.pid(), &short);
        }
        joybug2::protocol_io::DebugEvent::DllUnloaded { .. } => {
            if let Some(ref name) = unloaded_module_name {
                let mut state = session.state.lock().unwrap();
                deactivate_breakpoints_for_module(&mut state, &module_short_name(name));
                deactivate_patches_for_module(&mut state, &module_short_name(name));
            }
        }
        _ => {}
    }
}

/// Emit DLL loaded/unloaded frontend events with logging.
fn emit_dll_events(
    handle: &AppHandle,
    session_id: &str,
    event: &joybug2::protocol_io::DebugEvent,
    unloaded_module_name: Option<String>,
) {
    match event {
        joybug2::protocol_io::DebugEvent::DllUnloaded { pid, tid, base_of_dll } => {
            #[derive(serde::Serialize)]
            struct DllUnloadedEvent {
                session_id: String,
                pid: u32,
                tid: u32,
                base_of_dll: u64,
                dll_name: Option<String>,
            }
            let payload = DllUnloadedEvent {
                session_id: session_id.to_string(),
                pid: *pid,
                tid: *tid,
                base_of_dll: *base_of_dll,
                dll_name: unloaded_module_name,
            };
            if let Err(e) = handle.emit("dll-unloaded", &payload) {
                error!("Failed to emit dll-unloaded event: {}", e);
            } else {
                debug!("📡 Emitted dll-unloaded event for base 0x{:X}", base_of_dll);
            }
            let message = match &payload.dll_name {
                Some(name) => format!("DLL unloaded: {} @ 0x{:X}", name, base_of_dll),
                None => format!("DLL unloaded @ 0x{:X}", base_of_dll),
            };
            crate::ui_logger::log_info(handle, &message, Some(session_id.to_string()));
            // The frontend dispatcher coalesces bursts of these into a summary toast.
            crate::ui_logger::toast_info(handle, &message);
        }
        joybug2::protocol_io::DebugEvent::DllLoaded { pid, tid, dll_name, base_of_dll, size_of_dll } => {
            #[derive(serde::Serialize)]
            struct DllLoadedEvent<'a> {
                session_id: String,
                pid: u32,
                tid: u32,
                dll_name: &'a str,
                base_of_dll: u64,
                size_of_dll: Option<u64>,
            }
            let name = dll_name.as_deref().unwrap_or("<unknown>");
            let payload = DllLoadedEvent {
                session_id: session_id.to_string(),
                pid: *pid,
                tid: *tid,
                dll_name: name,
                base_of_dll: *base_of_dll,
                size_of_dll: *size_of_dll,
            };
            if let Err(e) = handle.emit("dll-loaded", &payload) {
                error!("Failed to emit dll-loaded event: {}", e);
            } else {
                debug!("📡 Emitted dll-loaded event for base 0x{:X}", base_of_dll);
            }
            let message = match size_of_dll {
                Some(sz) => format!("DLL loaded: {} @ 0x{:X} (size: 0x{:X})", name, base_of_dll, sz),
                None => format!("DLL loaded: {} @ 0x{:X}", name, base_of_dll),
            };
            crate::ui_logger::log_info(handle, &message, Some(session_id.to_string()));
            // The frontend dispatcher coalesces bursts of these into a summary toast.
            crate::ui_logger::toast_info(handle, &message);
        }
        _ => {}
    }
}

/// Extracts the module name for a DllUnloaded event from session state.
fn get_unloaded_module_name(
    state: &SessionStateUI,
    event: &joybug2::protocol_io::DebugEvent,
) -> Option<String> {
    if let joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } = event {
        state.modules.iter().find(|m| m.base == *base_of_dll).map(|m| m.name.clone())
    } else {
        None
    }
}

/// If the "Hide from PEB" setting is enabled, ask joybug2 to overwrite the
/// configured PEB fields in the target. Called on the initial breakpoint:
/// by then ntdll has finished loader/heap initialization, so the values we
/// write (NtGlobalFlag, heap flags, etc.) won't be overwritten afterwards.
/// Patching earlier (at ProcessCreated) is too soon — ntdll hasn't set those
/// fields yet and runs after us, clobbering the patch.
fn apply_debugger_hiding(
    session: &mut DebugSession,
    pid: u32,
    handle: &AppHandle,
) {
    let cfg = handle
        .state::<crate::settings::SettingsState>()
        .inner()
        .lock()
        .unwrap()
        .debugger_hiding
        .clone();
    if !cfg.hide_from_peb {
        return;
    }

    let opts = joybug2::anti_anti_debug::PebHideOptions {
        being_debugged:  cfg.being_debugged,
        heap_flags:      cfg.heap_flags,
        nt_global_flag:  cfg.nt_global_flag,
        startup_info:    cfg.startup_info,
        os_build_number: cfg.os_build_number,
    };
    if !opts.any() {
        return;
    }

    let session_id = Some(session.state.lock().unwrap().id.clone());
    match session.hide_peb(pid, opts) {
        Ok(report) => {
            if report.wow64_skipped {
                let msg = "Hide from PEB skipped: target is a 32-bit (WOW64) process";
                crate::ui_logger::log_warn(handle, msg, session_id);
                crate::ui_logger::toast_info(handle, msg);
                return;
            }
            if !report.applied.is_empty() {
                let msg = format!("Hidden debugger from PEB: {}", report.applied.join(", "));
                crate::ui_logger::log_info(handle, &msg, session_id.clone());
                crate::ui_logger::toast_info(handle, &msg);
            }
            for (technique, err) in &report.failures {
                let msg = format!("Hide from PEB: {} failed: {}", technique, err);
                crate::ui_logger::log_warn(handle, &msg, session_id.clone());
                crate::ui_logger::toast_error(handle, &msg);
            }
        }
        Err(e) => {
            let msg = format!("Hide from PEB failed: {}", e);
            error!("{}", msg);
            crate::ui_logger::log_warn(handle, &msg, session_id);
            crate::ui_logger::toast_error(handle, &msg);
        }
    }
}

/// Resolve which PID an attach session should target.
///
/// Prefers the stored PID when it's still alive. Otherwise (the target was
/// restarted and got a new PID) it falls back to matching by image name:
/// exactly one match re-attaches automatically; zero or several matches are an
/// error the caller surfaces (for several, the UI offers a picker).
fn resolve_attach_pid(session: &mut DebugSession, stored_pid: u32, target_name: &str) -> Result<u32> {
    let processes = session
        .list_processes()
        .map_err(|e| Error::DebugLoop(format!("Failed to list processes: {}", e)))?;
    super::helpers::match_target_pid(&processes, stored_pid, target_name).map_err(Error::DebugLoop)
}

pub fn run_debug_session(
    session_state: Arc<Mutex<SessionStateUI>>,
    app_handle: Option<AppHandle>,
) -> Result<()> {
    let (session_id, server_url, launch_command, working_directory, attach_pid) = {
        let state = session_state.lock().unwrap();
        (state.id.clone(), state.server_url.clone(), state.launch_command.clone(), state.working_directory.clone(), state.attach_pid)
    };

    info!("Starting debug session: {}", session_id);

    let ui_receiver = {
        let mut state = session_state.lock().unwrap();
        match state.ui_receiver.take() {
            Some(rx) => rx,
            None => {
                return Err(Error::InternalCommunication("UI receiver not available (session already running?)".to_string()));
            }
        }
    };

    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatusUI::Running;
    }
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    let app_handle_clone = app_handle.clone();
    let app_handle_for_exception = app_handle.clone();

    let mut session_builder = joybug2::protocol_io::DebugSession::new(session_state.clone(), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?
        .on_exception(move |session, _pid, _tid, code, _address, first_chance, _parameters| {
            // Read and clear pass_exception_on_continue flag from state
            let pass = {
                let mut state = session.state.lock().unwrap();
                let flag = state.pass_exception_on_continue;
                state.pass_exception_on_continue = false;
                flag
            };

            if pass {
                return Ok(joybug2::protocol_io::ExceptionAction::PassToApplication);
            }

            // Check per-code exception rules from settings
            if let Some(ref handle) = app_handle_for_exception {
                let settings = handle.state::<SettingsState>().inner().lock().unwrap().clone();
                for rule in &settings.exception_rules {
                    if rule.code == code {
                        let action_str = if first_chance { &rule.first_chance } else { &rule.second_chance };
                        return Ok(match action_str.as_str() {
                            "pass" => joybug2::protocol_io::ExceptionAction::PassToApplication,
                            "handled" => joybug2::protocol_io::ExceptionAction::HandledByDebugger,
                            _ => joybug2::protocol_io::ExceptionAction::HandledByDebugger, // "stop" → handled (on_event controls pausing)
                        });
                    }
                }
            }

            // Default: handled by debugger (on_event controls whether we pause)
            Ok(joybug2::protocol_io::ExceptionAction::HandledByDebugger)
        })
        .on_event(move |session, event| {
            debug!("📥 Received debug event from server: {}", event);
            info!("Debug event: {}", event);

            let handle = match app_handle_clone.as_ref() {
                Some(h) => h,
                None => {
                    // No app handle available — just continue the debug loop without UI updates
                    return Ok(true);
                }
            };
            crate::ui_logger::log_debug(
                handle,
                &format!("Received debug event: {}", event),
                Some(session.state.lock().unwrap().id.clone()),
            );
            let is_internal_single_step = matches!(
                event,
                joybug2::protocol_io::DebugEvent::Exception { code, first_chance: true, .. }
                    if *code == 0x80000004
            );
            // Toast for events here; Output/DllLoaded/DllUnloaded are toasted separately
            // below / above (with richer messages). The frontend dispatcher coalesces any
            // bursts (e.g. thousands of thread-creates) into a single summary toast.
            if !matches!(
                event,
                joybug2::protocol_io::DebugEvent::Output { .. }
                    | joybug2::protocol_io::DebugEvent::DllLoaded { .. }
                    | joybug2::protocol_io::DebugEvent::DllUnloaded { .. }
            ) && !is_internal_single_step {
                crate::ui_logger::toast_info(handle, &format!("{}", event));
            }

            // Drive an in-progress source-line step: keep single-stepping without
            // pausing the UI until the PC leaves the starting source line. When it
            // returns Some(true) the next step is already armed, so we resume; the
            // final step falls through to the normal pause path below.
            if let joybug2::protocol_io::DebugEvent::StepComplete { pid, tid, address, .. } = event {
                if let Some(keep_going) = super::dispatch::advance_source_line_step(session, *pid, *tid, *address) {
                    if keep_going {
                        return Ok(true);
                    }
                }
            }

            // Apply "Hide from PEB" at the initial breakpoint, before the target's
            // main() runs. This happens regardless of whether the initial breakpoint
            // is configured to pause, so anti-debug checks always see clean values.
            if matches!(event, joybug2::protocol_io::DebugEvent::InitialBreakpoint { .. }) {
                apply_debugger_hiding(session, event.pid(), handle);
            }

            // Special handling for OutputDebugString
            if let joybug2::protocol_io::DebugEvent::Output { output, .. } = event {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                let output = format!("OutputDebugString: {}", output);
                crate::ui_logger::log_info(handle, &output, Some(session_id));
                // The frontend dispatcher coalesces bursts of these into a summary toast.
                crate::ui_logger::toast_info(handle, &output);

                {
                    let mut state = session.state.lock().unwrap();
                    state.events.push(event.clone());
                }
                emit_session_event(&session.state, handle);

                let stop = handle.state::<SettingsState>().inner().lock().unwrap().stop_on_debug_output;
                if !stop {
                    return Ok(true);
                }
                // Fall through to pause path
            }

            // ProcessExited: always finalize/continue
            if matches!(event, joybug2::protocol_io::DebugEvent::ProcessExited { .. }) {
                {
                    let mut state = session.state.lock().unwrap();
                    state.current_event = Some(event.clone());
                    state.events.push(event.clone());
                    update_session_from_event(&mut state, event);
                }
                emit_session_event(&session.state, handle);
                return Ok(true);
            }

            // ThreadExited: respect settings whether to pause or not
            if let joybug2::protocol_io::DebugEvent::ThreadExited { .. } = event {
                let should_pause_on_thread_exit = {
                    let s = handle.state::<SettingsState>();
                    let s = s.lock().unwrap();
                    s.stop_on_thread_exit
                };
                if !should_pause_on_thread_exit {
                    {
                        let mut state = session.state.lock().unwrap();
                        state.current_event = Some(event.clone());
                        state.events.push(event.clone());
                        update_session_from_event(&mut state, event);
                    }
                    emit_session_event(&session.state, handle);
                    return Ok(true);
                }
            }

            // Decide whether this event should pause or auto-continue based on user settings
            {
                let settings = handle.state::<SettingsState>().inner().lock().unwrap().clone();
                let should_pause = match event {
                    joybug2::protocol_io::DebugEvent::ProcessCreated { .. } => settings.stop_on_process_create,
                    joybug2::protocol_io::DebugEvent::ThreadCreated { .. } => settings.stop_on_thread_create,
                    joybug2::protocol_io::DebugEvent::ThreadExited { .. } => settings.stop_on_thread_exit,
                    joybug2::protocol_io::DebugEvent::DllLoaded { .. } => settings.stop_on_dll_load,
                    joybug2::protocol_io::DebugEvent::DllUnloaded { .. } => settings.stop_on_dll_unload,
                    joybug2::protocol_io::DebugEvent::InitialBreakpoint { .. } => settings.stop_on_initial_breakpoint,
                    joybug2::protocol_io::DebugEvent::Exception { code, first_chance: true, .. }
                        if *code == 0x80000004 => false,
                    joybug2::protocol_io::DebugEvent::Exception { code, first_chance, .. } => {
                        // Check per-code exception rules
                        let mut found = false;
                        let mut should_stop = true;
                        for rule in &settings.exception_rules {
                            if rule.code == *code {
                                found = true;
                                let action_str = if *first_chance { &rule.first_chance } else { &rule.second_chance };
                                should_stop = action_str == "stop";
                                break;
                            }
                        }
                        if found { should_stop } else { true }
                    }
                    joybug2::protocol_io::DebugEvent::Unknown { .. } => false,
                    _ => true,
                };

                if !should_pause {
                    let unloaded_module_name;
                    {
                        let mut state = session.state.lock().unwrap();
                        unloaded_module_name = get_unloaded_module_name(&state, event);
                        state.current_event = Some(event.clone());
                        state.events.push(event.clone());
                        update_session_from_event(&mut state, event);
                        state.status = SessionStatusUI::Running;
                    }

                    handle_event_breakpoints(session, event, &unloaded_module_name);

                    let session_id = session.state.lock().unwrap().id.clone();
                    emit_dll_events(handle, &session_id, event, unloaded_module_name);

                    // Skip full session-updated event for DLL events during auto-continue.
                    // The frontend already receives dll-loaded/dll-unloaded events directly
                    // and doesn't need a full session state update while running.
                    let is_dll_event = matches!(
                        event,
                        joybug2::protocol_io::DebugEvent::DllLoaded { .. }
                            | joybug2::protocol_io::DebugEvent::DllUnloaded { .. }
                    );
                    if !is_dll_event {
                        emit_session_event(&session.state, handle);
                    }
                    return Ok(true);
                }

                // Update session state from event (pausing path)
                let context = match session.get_thread_context(event.pid(), event.tid()) {
                    Ok(ctx) => ctx,
                    Err(e) => {
                        error!("Failed to get thread context: {}", e);
                        let mut state = session.state.lock().unwrap();
                        state.status = SessionStatusUI::Error(format!("GetThreadContext failed: {}", e));
                        emit_session_event(&session.state, handle);
                        return Ok(false);
                    }
                };

                let unloaded_module_name;
                {
                    let mut state = session.state.lock().unwrap();
                    state.current_event = Some(event.clone());
                    state.events.push(event.clone());
                    state.status = SessionStatusUI::Paused;
                    state.current_context = Some(crate::events::convert_raw_context_to_serializable(context));

                    unloaded_module_name = get_unloaded_module_name(&state, event);
                    if let Some(ref name) = unloaded_module_name {
                        deactivate_breakpoints_for_module(&mut state, &module_short_name(name));
                        deactivate_patches_for_module(&mut state, &module_short_name(name));
                    }

                    update_session_from_event(&mut state, event);
                }

                // Reapply patches then breakpoints for newly loaded modules.
                // Patches first so they read real binary bytes; breakpoints then store
                // patched bytes as originals. (DllUnloaded already handled above with state locked)
                match event {
                    joybug2::protocol_io::DebugEvent::DllLoaded { dll_name, base_of_dll, .. } => {
                        let name = dll_name.as_deref().unwrap_or("<unknown>");
                        let short = module_short_name(name);
                        reapply_patches_for_module(session, event.pid(), &short, *base_of_dll);
                        reapply_breakpoints_for_module(session, event.pid(), &short, *base_of_dll);
                        reapply_bookmarks_for_module(session, event.pid(), &short);
                    }
                    joybug2::protocol_io::DebugEvent::ProcessCreated { image_file_name, base_of_image, .. } => {
                        let name = image_file_name.as_deref().unwrap_or("main.exe");
                        let short = module_short_name(name);
                        reapply_patches_for_module(session, event.pid(), &short, *base_of_image);
                        reapply_breakpoints_for_module(session, event.pid(), &short, *base_of_image);
                        reapply_bookmarks_for_module(session, event.pid(), &short);
                    }
                    _ => {}
                }

                let session_id = session.state.lock().unwrap().id.clone();
                emit_dll_events(handle, &session_id, event, unloaded_module_name);

            }

            // Emit session events
            emit_session_event(&session.state, handle);
            emit_breakpoints_event(session, &app_handle_clone);
            emit_patches_event(session, &app_handle_clone);
            super::bookmarks::emit_bookmarks_event(session, event.pid(), &app_handle_clone);

            info!("Debug event received, waiting for user command");

            // Wait for user commands
            match handle_ui_commands(&ui_receiver, session, &app_handle_clone, event) {
                Ok(should_continue) => {
                    return Ok(should_continue);
                }
                Err(e) => {
                    error!("Error handling UI commands: {}", e);
                    let mut state = session.state.lock().unwrap();
                    state.status = SessionStatusUI::Error(e.to_string());
                    return Ok(false);
                }
            }
        });

    // Attach to an existing process, or launch the configured command.
    let _final_state = match attach_pid {
        Some(stored_pid) => {
            // The stored PID may be stale (target restarted → new PID). Resolve
            // it: keep it if still alive, else fall back to a unique match by the
            // target's image name so a restarted single instance re-attaches
            // automatically.
            let pid = resolve_attach_pid(&mut session_builder, stored_pid, &launch_command)?;
            if pid != stored_pid {
                info!("Stored attach pid {} not found; re-attaching to pid {} ({})", stored_pid, pid, launch_command);
                session_state.lock().unwrap().attach_pid = Some(pid);
            }
            info!("Attaching debug session {} to pid {}", session_id, pid);
            session_builder
                .attach(pid)
                .map_err(|e| Error::DebugLoop(e.to_string()))?
        }
        None => session_builder
            .launch_in_dir(launch_command, working_directory)
            .map_err(|e| Error::DebugLoop(e.to_string()))?,
    };

    // Mark session as finished
    {
        let mut state = session_state.lock().unwrap();
        if !matches!(state.status, SessionStatusUI::Error(_)) {
            state.status = SessionStatusUI::Stopped;
            state.reset();
        }
        state.current_event = None;
    }

    // Emit final session update
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    info!("Debug session {} finished", session_id);
    Ok(())
}

// Helper function to emit session-updated events
pub(crate) fn emit_session_event(
    session_state: &Arc<Mutex<SessionStateUI>>,
    app_handle: &AppHandle,
) {
    let debug_session = {
        let state = session_state.lock().unwrap();
        state.to_debug_session()
    };

    if let Err(e) = app_handle.emit("session-updated", &debug_session) {
        error!("Failed to emit session-updated event for {}: {}", debug_session.id, e);
    }
}
