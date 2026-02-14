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

use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::{SessionStatesMap, SessionStatusUI};

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
