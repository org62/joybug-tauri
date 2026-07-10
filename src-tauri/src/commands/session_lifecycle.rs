use crate::error::{Error, Result};
use crate::session::{run_debug_session, emit_session_event, LocalServer, UICommand};
use crate::state::{
    DebugSessionUI, EmbeddedServersMap, SessionStateUI, SessionStatesMap, SessionStatusUI,
};
use joybug2::protocol::DebuggerRequest;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{State, Emitter, Manager};
use tracing::{error, info};

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub fn create_debug_session(
    name: String,
    server_url: String,
    launch_command: String,
    working_directory: Option<String>,
    is_local_run: bool,
    attach_pid: Option<u32>,
    non_invasive: Option<bool>,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<String, String> {
    let non_invasive = non_invasive.unwrap_or(false);
    let mut states = session_states.lock().unwrap();

    if !is_local_run && attach_pid.is_none() {
        for session_state in states.values() {
            let state = session_state.lock().unwrap();
            if !state.is_local_run && state.server_url == server_url && state.launch_command == launch_command {
                return Err(Error::SessionAlreadyExists.to_string());
            }
        }
    }

    let session_id = format!("session_{}", chrono::Utc::now().timestamp_millis());

    let effective_server_url = if is_local_run {
        String::new()
    } else {
        server_url
    };

    let working_directory = working_directory.filter(|w| !w.trim().is_empty());

    let session_state_arc = Arc::new(Mutex::new(SessionStateUI::new(
        session_id.clone(),
        name,
        effective_server_url,
        launch_command,
        working_directory,
        is_local_run,
        attach_pid,
        non_invasive,
    )));

    {
        let mut state = session_state_arc.lock().unwrap();
        state.breakpoints = crate::breakpoint_store::load_breakpoints(&state.launch_command);
        state.patches = crate::patch_store::load_patches(&state.launch_command);
        state.bookmarks = crate::bookmark_store::load_bookmarks(&state.launch_command);
    }

    states.insert(session_id.clone(), session_state_arc.clone());

    drop(states);

    crate::ui_logger::log_info(
        &app_handle,
        &format!("Debug session created: {}", session_id),
        Some(session_id.clone()),
    );

    emit_session_event(&session_state_arc, &app_handle);

    info!("Created debug session: {}", session_id);
    Ok(session_id)
}

#[tauri::command]
pub fn update_debug_session(
    session_id: String,
    name: String,
    server_url: String,
    launch_command: String,
    working_directory: Option<String>,
    is_local_run: bool,
    attach_pid: Option<u32>,
    non_invasive: Option<bool>,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<(), String> {
    let non_invasive = non_invasive.unwrap_or(false);
    let states = session_states.lock().unwrap();

    if !is_local_run && attach_pid.is_none() {
        for (id, session_state) in states.iter() {
            if id != &session_id {
                let state = session_state.lock().unwrap();
                if !state.is_local_run && state.server_url == server_url && state.launch_command == launch_command {
                    return Err(Error::SessionAlreadyExists.to_string());
                }
            }
        }
    }

    if let Some(session_state) = states.get(&session_id) {
        let mut state = session_state.lock().unwrap();

        if !matches!(state.status, SessionStatusUI::Stopped | SessionStatusUI::Error(_)) {
            return Err("Session can only be edited when in 'Stopped' or 'Error' state.".to_string());
        }

        state.name = name;
        state.is_local_run = is_local_run;
        state.server_url = if is_local_run { String::new() } else { server_url };
        state.launch_command = launch_command;
        state.working_directory = working_directory.filter(|w| !w.trim().is_empty());
        state.attach_pid = attach_pid;
        state.non_invasive = non_invasive;

        let session_state_arc = session_state.clone();

        drop(state);
        drop(states);

        crate::ui_logger::log_info(
            &app_handle,
            &format!("Debug session updated: {}", session_id),
            Some(session_id.clone()),
        );

        emit_session_event(&session_state_arc, &app_handle);

        info!("Updated debug session: {}", session_id);
        Ok(())
    } else {
        Err(Error::SessionNotFound(session_id).to_string())
    }
}

#[tauri::command]
pub fn get_debug_sessions(
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<DebugSessionUI>> {
    let states = session_states.lock().unwrap();

    let sessions: Vec<DebugSessionUI> = states
        .values()
        .map(|session_state| {
            let state = session_state.lock().unwrap();
            state.to_debug_session()
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
pub fn get_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Option<DebugSessionUI>> {
    let states = session_states.lock().unwrap();

    if let Some(session_state) = states.get(&session_id) {
        let state = session_state.lock().unwrap();
        Ok(Some(state.to_debug_session()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn start_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    embedded_servers: State<'_, EmbeddedServersMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(&session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    {
        let mut state = session_state.lock().unwrap();
        if matches!(state.status, SessionStatusUI::Stopped | SessionStatusUI::Error(_)) {
            state.reset();
        }
        if state.ui_receiver.is_none() {
            return Err(Error::InvalidSessionState("Session is already running".to_string()));
        }
    }

    {
        let mut state = session_state.lock().unwrap();
        if state.is_local_run {
            info!("Starting embedded server for local run session: {}", session_id);
            let symbol_cfg = {
                let settings = app_handle.state::<crate::settings::SettingsState>();
                let settings = settings.lock().unwrap();
                settings.symbol_config()
            };
            let server_handle = LocalServer::start_with_config(symbol_cfg)
                .map_err(|e| Error::ConnectionFailed(format!("Failed to start embedded server: {}", e)))?;

            let port = server_handle.port();
            let server_url = format!("127.0.0.1:{}", port);

            embedded_servers.lock().unwrap().insert(session_id.clone(), server_handle);

            state.server_url = server_url;
            state.embedded_server_port = Some(port);

            info!("Embedded server started on port {} for session {}", port, session_id);
        }
    }

    // Non-invasive session: open the target for memory/enumeration only. Resolve
    // the live PID, mark the session Open, and return without a debug loop.
    {
        let (non_invasive, server_url, attach_pid, launch_command) = {
            let state = session_state.lock().unwrap();
            (state.non_invasive, state.server_url.clone(), state.attach_pid, state.launch_command.clone())
        };
        if non_invasive {
            let stored_pid = attach_pid.ok_or_else(|| {
                Error::InvalidSessionState("Non-invasive session requires a target PID".to_string())
            })?;
            // Resolve the live PID and register the process with the server
            // non-invasively — one temp connection for both — so modules, threads,
            // symbols, disassembly, PE info and call stacks are available without
            // attaching a debugger.
            let pid = {
                let mut client = connect_temp_client(&server_url)?;
                let pid = resolve_open_pid(&mut client, stored_pid, &launch_command)?;
                client
                    .open_process(pid)
                    .map_err(|e| Error::ConnectionFailed(format!("Failed to open process {}: {}", pid, e)))?;
                pid
            };
            {
                let mut state = session_state.lock().unwrap();
                state.attach_pid = Some(pid);
                state.open_pid = Some(pid);
                state.status = SessionStatusUI::Open;
            }
            emit_session_event(&session_state, &app_handle);
            crate::ui_logger::log_info(
                &app_handle,
                &format!("Opened process {} non-invasively for session {}", pid, session_id),
                Some(session_id.clone()),
            );
            info!("Non-invasive session {} opened pid {}", session_id, pid);
            return Ok(());
        }
    }

    emit_session_event(&session_state, &app_handle);

    crate::ui_logger::log_info(
        &app_handle,
        &format!("Starting debug session: {}", session_id),
        Some(session_id.clone()),
    );

    spawn_debug_loop(session_state, app_handle, session_id);

    Ok(())
}

/// Spawn the blocking debug-session loop on its own thread and record the final
/// status when it exits. Shared by `start_debug_session` and `attach_open_session`.
fn spawn_debug_loop(
    session_state: Arc<Mutex<SessionStateUI>>,
    app_handle: tauri::AppHandle,
    session_id: String,
) {
    thread::spawn(move || {
        let result = run_debug_session(session_state.clone(), Some(app_handle.clone()));

        {
            let mut state = session_state.lock().unwrap();
            match &result {
                Ok(_) => {
                    if !matches!(state.status, SessionStatusUI::Stopped) {
                        state.status = SessionStatusUI::Stopped;
                    }
                    info!("Debug session {} completed successfully", session_id);
                }
                Err(e) => {
                    state.status = SessionStatusUI::Error(e.to_string());
                    let error_message = format!("Debug session {} failed: {}", session_id, e);
                    error!("{}", &error_message);
                    crate::ui_logger::log_error(&app_handle, &error_message, Some(session_id.clone()));
                }
            }
            state.debug_result = Some(result.map_err(|e| e.to_string()));
        }

        emit_session_event(&session_state, &app_handle);
    });
}

/// Promote a non-invasive `Open` session to a full attached debug session on the
/// same PID: release the non-invasive registration, then run the debug loop
/// (which attaches via `attach_pid`). Enables breakpoints, stepping and Detach.
#[tauri::command]
pub fn attach_open_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states.get(&session_id).cloned().ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
    };

    let (server_url, pid) = {
        let state = session_state.lock().unwrap();
        if !state.non_invasive || !matches!(state.status, SessionStatusUI::Open) {
            return Err(Error::InvalidSessionState("Session is not a non-invasive Open session".to_string()));
        }
        let pid = state.open_pid.or(state.attach_pid)
            .ok_or_else(|| Error::InvalidSessionState("No target PID to attach to".to_string()))?;
        (state.server_url.clone(), pid)
    };

    // Drop the pooled OOB connections and release the non-invasive process entry so
    // the debug loop's DebugActiveProcess can take over cleanly.
    oob_pool.remove(&session_id);
    if let Ok(mut client) = connect_temp_client(&server_url) {
        let _ = client.close_process(pid);
    }

    {
        let mut state = session_state.lock().unwrap();
        state.non_invasive = false;
        state.open_pid = None;
        state.attach_pid = Some(pid);
        state.status = SessionStatusUI::Running;
    }
    emit_session_event(&session_state, &app_handle);
    crate::ui_logger::log_info(&app_handle, &format!("Attaching to process {}", pid), Some(session_id.clone()));

    spawn_debug_loop(session_state, app_handle, session_id);
    Ok(())
}

#[tauri::command]
pub fn stop_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    embedded_servers: State<'_, EmbeddedServersMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states.get(&session_id).cloned()
    };

    // Drop any pooled live-poll connection so its socket and server-side
    // connection are released along with the session.
    oob_pool.remove(&session_id);

    if let Some(session_state) = session_state {
        {
            let mut state = session_state.lock().unwrap();
            if let Some(sender) = state.ui_sender.take() {
                info!("Stopping session by dropping the step_sender.");
                let _ = sender.send(UICommand::Stop);
            }
            // Non-invasive sessions have no debug-loop thread to flip the status
            // on exit, so transition them to Stopped here.
            if state.non_invasive {
                state.status = SessionStatusUI::Stopped;
                state.open_pid = None;
            }
        }

        if let Some(mut server_handle) = embedded_servers.lock().unwrap().remove(&session_id) {
            info!("Stopping embedded server for session {}", session_id);
            server_handle.stop();
        }

        emit_session_event(&session_state, &app_handle);
    }
    Ok(())
}

#[tauri::command]
pub fn terminate_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states.get(&session_id).cloned()
    };

    if let Some(session_state) = session_state {
        let (pid, server_url) = {
            let state = session_state.lock().unwrap();
            let pid = state.current_event.as_ref().map(|ev| ev.pid()).unwrap_or(0);
            (pid, state.server_url.clone())
        };

        if pid != 0 {
            if let Err(e) = send_out_of_band_request(&server_url, DebuggerRequest::TerminateProcess { pid }) {
                crate::ui_logger::log_error(&app_handle, &format!("Failed to terminate: {}", e), Some(session_id.clone()));
            } else {
                crate::ui_logger::log_info(&app_handle, "Terminate signal sent", Some(session_id.clone()));
            }
        }

        emit_session_event(&session_state, &app_handle);
    }
    Ok(())
}

#[tauri::command]
pub fn pause_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states.get(&session_id).cloned()
    };

    if let Some(session_state) = session_state {
        let (pid, server_url) = {
            let state = session_state.lock().unwrap();
            let pid = state.current_event.as_ref().map(|ev| ev.pid()).unwrap_or(0);
            (pid, state.server_url.clone())
        };

        if pid == 0 {
            return Err(Error::InvalidSessionState("No active process to pause".to_string()));
        }

        send_out_of_band_request(&server_url, DebuggerRequest::BreakInto { pid })?;

        crate::ui_logger::log_info(&app_handle, "Pause signal sent", Some(session_id.clone()));
        Ok(())
    } else {
        Err(Error::SessionNotFound(session_id))
    }
}

/// Detach the debugger from the target, leaving it running. Requires the session
/// to be paused: the detach request is sent over the session's own connection from
/// inside the paused debug loop, then the loop exits cleanly.
#[tauri::command]
pub fn detach_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // Release any pooled live-poll connection before the session ends.
    oob_pool.remove(&session_id);

    super::send_paused_command(&session_id, &session_states, UICommand::Detach)?;

    crate::ui_logger::log_info(&app_handle, "Detach requested", Some(session_id));
    Ok(())
}

/// Enumerate running processes so the UI can offer an attach target. Connects to
/// `server_url` when given (remote server); otherwise spins up a short-lived
/// embedded server just to list processes locally.
#[tauri::command]
pub fn list_processes(
    server_url: Option<String>,
) -> std::result::Result<Vec<joybug2::protocol::ProcessInfo>, String> {
    let url = server_url.filter(|s| !s.trim().is_empty());

    let mut temp_server: Option<LocalServer> = None;
    let effective_url = match url {
        Some(u) => u,
        None => {
            let server = LocalServer::start()
                .map_err(|e| format!("Failed to start embedded server: {}", e))?;
            let u = format!("127.0.0.1:{}", server.port());
            temp_server = Some(server);
            u
        }
    };

    let result = (|| {
        let mut client = connect_temp_client(&effective_url).map_err(|e| e.to_string())?;
        let mut processes = client.list_processes().map_err(|e| e.to_string())?;
        processes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok::<_, String>(processes)
    })();

    if let Some(mut server) = temp_server {
        server.stop();
    }

    result
}

/// Connect a throwaway joybug2 client to `server_url` for a single one-shot
/// request. The temp session state is untracked and carries no launch command.
fn connect_temp_client(server_url: &str) -> Result<crate::session::types::DebugSession> {
    let tmp_state = Arc::new(Mutex::new(SessionStateUI::new(
        format!("tmp_{}", chrono::Utc::now().timestamp_millis()),
        "tmp".to_string(),
        server_url.to_string(),
        "".to_string(),
        None,
        false,
        None,
        false,
    )));
    joybug2::protocol_io::DebugSession::new(tmp_state, Some(server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))
}

/// Resolve which live PID a non-invasive session should open. Same policy as
/// `runner::resolve_attach_pid`: prefer the stored PID if still alive, else match
/// uniquely by image name (zero/several matches are surfaced as an error).
fn resolve_open_pid(
    client: &mut crate::session::types::DebugSession,
    stored_pid: u32,
    target_name: &str,
) -> Result<u32> {
    let processes = client
        .list_processes()
        .map_err(|e| Error::ConnectionFailed(format!("Failed to list processes: {}", e)))?;
    crate::session::helpers::match_target_pid(&processes, stored_pid, target_name)
        .map_err(Error::InvalidSessionState)
}

fn send_out_of_band_request(server_url: &str, req: DebuggerRequest) -> Result<()> {
    let mut client = connect_temp_client(server_url)?;
    match req {
        DebuggerRequest::BreakInto { pid } => {
            client
                .send_and_receive(&DebuggerRequest::BreakInto { pid })
                .map_err(|e| Error::InternalCommunication(e.to_string()))?;
        }
        DebuggerRequest::TerminateProcess { pid } => {
            client
                .send_and_receive(&DebuggerRequest::TerminateProcess { pid })
                .map_err(|e| Error::InternalCommunication(e.to_string()))?;
        }
        _ => return Err(Error::InvalidSessionState("Unsupported OOB request".to_string())),
    }
    Ok(())
}

#[tauri::command]
pub fn delete_debug_session(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    embedded_servers: State<'_, EmbeddedServersMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let _ = stop_debug_session(session_id.clone(), session_states.clone(), embedded_servers.clone(), oob_pool.clone(), app_handle.clone());

    if session_states.lock().unwrap().remove(&session_id).is_some() {
        info!("Successfully deleted session: {}", session_id);
        if let Err(e) = app_handle.emit("session-removed", &session_id) {
            error!("Failed to emit session-removed event: {}", e);
        }
        Ok(())
    } else {
        info!("Attempted to delete a session that was not found: {}", session_id);
        Ok(())
    }
}
