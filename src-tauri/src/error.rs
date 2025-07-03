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
    #[error("Invalid session state: {0}")]
    InvalidSessionState(String),
    #[error("A session with the same server and command already exists")]
    SessionAlreadyExists,
}

pub type Result<T> = std::result::Result<T, Error>; 