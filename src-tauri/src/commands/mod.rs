mod breakpoints;
mod disassembly;
mod emulation;
mod logging;
mod memory;
mod session_lifecycle;
mod settings;
mod stepping;
mod symbols;
mod types;
mod window_state;

pub use breakpoints::*;
pub use disassembly::*;
pub use emulation::*;
pub use logging::*;
pub use memory::*;
pub use session_lifecycle::*;
pub use settings::*;
pub use stepping::*;
pub use symbols::*;
pub use window_state::*;

use std::sync::{Arc, Mutex};
use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::{SessionStateUI, SessionStatesMap, SessionStatusUI};

/// Sends a UICommand to a paused session. Shared helper for breakpoint, symbol, and disassembly commands.
fn send_paused_command(
    session_id: &str,
    session_states: &SessionStatesMap,
    command: UICommand,
) -> Result<()> {
    let session_state = {
        let states = session_states.lock().unwrap();
        states
            .get(session_id)
            .cloned()
            .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))?
    };

    let ui_sender = {
        let state = session_state.lock().unwrap();
        if !matches!(state.status, SessionStatusUI::Paused) {
            return Err(Error::InvalidSessionState(
                "Session must be paused".to_string(),
            ));
        }
        state
            .ui_sender
            .as_ref()
            .ok_or_else(|| Error::InternalCommunication("Session UI sender not available".to_string()))?
            .clone()
    };

    ui_sender
        .send(command)
        .map_err(|e| Error::InternalCommunication(format!("Failed to send command: {}", e)))?;

    Ok(())
}

/// Get session state Arc by ID.
pub(crate) fn get_session_arc(
    session_id: &str,
    session_states: &SessionStatesMap,
) -> Result<Arc<Mutex<SessionStateUI>>> {
    let states = session_states.lock().unwrap();
    states
        .get(session_id)
        .cloned()
        .ok_or_else(|| Error::SessionNotFound(session_id.to_string()))
}

/// Marker type: session is not paused, caller should fall back to OOB.
pub(crate) struct RunningFallback;

/// Try sending a UICommand via the paused session channel.
/// Returns Err(RunningFallback) if the session is not paused.
pub(crate) fn try_send_paused_command(
    session_state: &Arc<Mutex<SessionStateUI>>,
    command: UICommand,
) -> std::result::Result<(), RunningFallback> {
    let state = session_state.lock().unwrap();
    if !matches!(state.status, SessionStatusUI::Paused) {
        return Err(RunningFallback);
    }
    if let Some(sender) = state.ui_sender.as_ref() {
        let sender = sender.clone();
        drop(state);
        let _ = sender.send(command);
        Ok(())
    } else {
        Err(RunningFallback)
    }
}

/// Create an OOB joybug2 client sharing the real session's state.
/// Returns (oob_client, pid).
pub(crate) fn create_oob_client(
    session_state: &Arc<Mutex<SessionStateUI>>,
) -> Result<(crate::session::types::DebugSession, u32)> {
    let (server_url, pid) = {
        let state = session_state.lock().unwrap();
        let pid = state.current_event.as_ref().map(|ev| ev.pid()).unwrap_or(0);
        (state.server_url.clone(), pid)
    };
    if pid == 0 {
        return Err(Error::InvalidSessionState("No active process".to_string()));
    }
    let client = joybug2::protocol_io::DebugSession::new(session_state.clone(), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;
    Ok((client, pid))
}

/// Get target architecture from session state (context or host default).
pub(crate) fn get_session_arch(
    session_state: &Arc<Mutex<SessionStateUI>>,
) -> joybug2::interfaces::Architecture {
    let state = session_state.lock().unwrap();
    match &state.current_context {
        Some(crate::state::SerializableThreadContext::X64(_)) => joybug2::interfaces::Architecture::X64,
        Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug2::interfaces::Architecture::Arm64,
        None => {
            #[cfg(target_arch = "x86_64")]
            { joybug2::interfaces::Architecture::X64 }
            #[cfg(target_arch = "aarch64")]
            { joybug2::interfaces::Architecture::Arm64 }
            #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
            { joybug2::interfaces::Architecture::X64 }
        }
    }
}
