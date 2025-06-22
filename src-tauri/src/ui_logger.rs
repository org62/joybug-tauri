use crate::state::{LogEntry, LogsState};
use tauri::{Manager, Emitter};

#[allow(dead_code)]
pub enum LogLevel {
    Debug,
    Info,
    Warning,
    Error,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "INFO",
            LogLevel::Warning => "WARNING",
            LogLevel::Error => "ERROR",
        }
    }
}

#[allow(dead_code)]
pub fn log<R: tauri::Runtime>(
    app: &impl Manager<R>,
    level: LogLevel,
    message: &str,
    session_id: Option<String>,
) {
    let state = app.state::<LogsState>();
    let mut logs = state.lock().unwrap();
    logs.push(LogEntry::new(level.as_str(), message, session_id));
}

#[allow(dead_code)]
pub fn log_info<R: tauri::Runtime>(
    app: &impl Manager<R>,
    message: &str,
    session_id: Option<String>,
) {
    log(app, LogLevel::Info, message, session_id);
}

#[allow(dead_code)]
pub fn log_debug<R: tauri::Runtime>(
    app: &impl Manager<R>,
    message: &str,
    session_id: Option<String>,
) {
    log(app, LogLevel::Debug, message, session_id);
}

#[allow(dead_code)]
pub fn log_warn<R: tauri::Runtime>(
    app: &impl Manager<R>,
    message: &str,
    session_id: Option<String>,
) {
    log(app, LogLevel::Warning, message, session_id);
}

#[allow(dead_code)]
pub fn log_error<R: tauri::Runtime>(
    app: &impl Manager<R>,
    message: &str,
    session_id: Option<String>,
) {
    log(app, LogLevel::Error, message, session_id);
}

#[allow(dead_code)]
pub fn toast_info(app: &tauri::AppHandle, message: &str) {
    if let Err(e) = app.emit("show-toast", message) {
        log(
            app,
            LogLevel::Error,
            &format!("Failed to emit show-toast event: {}", e),
            None,
        );
    }
} 