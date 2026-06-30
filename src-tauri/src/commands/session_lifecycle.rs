use crate::error::{Error, Result};
use crate::session::{run_debug_session, emit_session_event, LocalServer, UICommand};
use crate::state::{
    DebugSessionUI, EmbeddedServersMap, SessionStateUI, SessionStatesMap, SessionStatusUI,
};
use joybug2::protocol::DebuggerRequest;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{State, Emitter};
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
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<String, String> {
    let mut states = session_states.lock().unwrap();

    if !is_local_run {
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
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> std::result::Result<(), String> {
    let states = session_states.lock().unwrap();

    if !is_local_run {
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
            let server_handle = LocalServer::start()
                .map_err(|e| Error::ConnectionFailed(format!("Failed to start embedded server: {}", e)))?;

            let port = server_handle.port();
            let server_url = format!("127.0.0.1:{}", port);

            embedded_servers.lock().unwrap().insert(session_id.clone(), server_handle);

            state.server_url = server_url;
            state.embedded_server_port = Some(port);

            info!("Embedded server started on port {} for session {}", port, session_id);
        }
    }

    emit_session_event(&session_state, &app_handle);

    crate::ui_logger::log_info(
        &app_handle,
        &format!("Starting debug session: {}", session_id),
        Some(session_id.clone()),
    );

    let session_state_for_thread = session_state.clone();
    let app_handle_for_thread = app_handle.clone();
    let session_id_for_thread = session_id.clone();

    thread::spawn(move || {
        let result = run_debug_session(session_state_for_thread.clone(), Some(app_handle_for_thread.clone()));

        {
            let mut state = session_state_for_thread.lock().unwrap();
            match &result {
                Ok(_) => {
                    if !matches!(state.status, SessionStatusUI::Stopped) {
                        state.status = SessionStatusUI::Stopped;
                    }
                    info!("Debug session {} completed successfully", session_id_for_thread);
                }
                Err(e) => {
                    state.status = SessionStatusUI::Error(e.to_string());
                    let error_message = format!("Debug session {} failed: {}", session_id_for_thread, e);
                    error!("{}", &error_message);
                    crate::ui_logger::log_error(
                        &app_handle_for_thread,
                        &error_message,
                        Some(session_id_for_thread.clone()),
                    );
                }
            }
            state.debug_result = Some(result.map_err(|e| e.to_string()));
        }

        emit_session_event(&session_state_for_thread, &app_handle_for_thread);
    });

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

fn send_out_of_band_request(server_url: &str, req: DebuggerRequest) -> Result<()> {
    let tmp_state = std::sync::Arc::new(std::sync::Mutex::new(crate::state::SessionStateUI::new(
        format!("tmp_oob_{}", chrono::Utc::now().timestamp_millis()),
        "tmp".to_string(),
        server_url.to_string(),
        "".to_string(),
        None,
        false,
    )));
    let mut client = joybug2::protocol_io::DebugSession::new(tmp_state, Some(server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;
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
