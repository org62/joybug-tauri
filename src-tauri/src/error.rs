use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
pub enum Error {
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to connect to debug server: {0}")]
    ConnectionFailed(String),
    #[error("Debug loop failed: {0}")]
    DebugLoop(String),
    #[error("Internal communication failed: {0}")]
    InternalCommunication(String),
    /// The debug server reached the target but the operation itself failed
    /// (e.g. `AdjustTokenPrivileges` denied). Distinct from
    /// `InternalCommunication`, which means the request never got an answer.
    #[error("Operation failed on the target: {0}")]
    TargetOperation(String),
    #[error("Invalid session state: {0}")]
    InvalidSessionState(String),
    #[error("A session with the same server and command already exists")]
    SessionAlreadyExists,
    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),
    #[error("Update check failed: {0}")]
    UpdateCheck(String),
    #[error("Update install failed: {0}")]
    UpdateInstall(String),
    #[error("JIT debugger registration failed: {0}")]
    JitDebugger(String),
    /// The user declined the UAC prompt. Not a failure — the UI toasts it
    /// calmly and leaves the toggle where it was.
    #[error("Elevation was cancelled")]
    JitDebuggerCancelled,
}

pub type Result<T> = std::result::Result<T, Error>; 