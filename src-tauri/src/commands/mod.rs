mod bookmarks;
mod breakpoints;
mod disassembly;
mod emulation;
mod logging;
mod memory;
mod patches;
mod session_lifecycle;
mod settings;
mod stepping;
mod symbols;
mod types;
mod window_state;

pub use bookmarks::*;
pub use breakpoints::*;
pub use disassembly::*;
pub use emulation::*;
pub use logging::*;
pub use memory::*;
pub use patches::*;
pub use session_lifecycle::*;
pub use settings::*;
pub use stepping::*;
pub use symbols::*;
pub use window_state::*;

use std::sync::{Arc, Mutex};
use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::{SessionStateUI, SessionStatesMap, SessionStatusUI};

/// Parse a hex string (with or without "0x" prefix) into u64.
pub(crate) fn parse_hex_u64(s: &str, label: &str) -> Result<u64> {
    u64::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| Error::InvalidParameter(format!("Invalid {} '{}': {}", label, s, e)))
}

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

/// One reused OOB connection for a session, pinned to the pid it was opened for.
pub(crate) struct OobConn {
    client: crate::session::types::DebugSession,
    pid: u32,
}

/// Pool of long-lived OOB clients, one per session, used for high-frequency live
/// polling (e.g. bookmark values while running) so we don't open a fresh TCP
/// connection every tick. Per-session inner locks keep sessions from serialising.
#[derive(Default)]
pub struct OobPool(pub Mutex<std::collections::HashMap<String, Arc<Mutex<Option<OobConn>>>>>);

impl OobPool {
    /// Drop a session's pooled connection (call on stop/delete so the socket and
    /// its server-side connection are released).
    pub(crate) fn remove(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}

/// Run `f` with a reused OOB client for `session_id`, (re)connecting when the slot
/// is empty, the pid changed (target restart), or the socket is dead. The result
/// of `f` is returned. Used for live polling without per-tick connection churn.
pub(crate) fn with_oob_client<R>(
    session_arc: &Arc<Mutex<SessionStateUI>>,
    session_id: &str,
    pool: &OobPool,
    f: impl FnOnce(&mut crate::session::types::DebugSession, u32) -> R,
) -> Result<R> {
    let pid = {
        let state = session_arc.lock().unwrap();
        state.current_event.as_ref().map(|ev| ev.pid()).unwrap_or(0)
    };
    if pid == 0 {
        return Err(Error::InvalidSessionState("No active process".to_string()));
    }

    // Get (or create) this session's slot without holding the map lock during I/O.
    let slot_arc = {
        let mut map = pool.0.lock().unwrap();
        map.entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut slot = slot_arc.lock().unwrap();

    // (Re)connect if absent or the pid changed since the connection was opened.
    if !matches!(slot.as_ref(), Some(c) if c.pid == pid) {
        let (client, _) = create_oob_client(session_arc)?;
        *slot = Some(OobConn { client, pid });
    }

    // Liveness probe: if the socket died (server/process gone), reconnect once.
    {
        let conn = slot.as_mut().unwrap();
        if conn.client.list_modules(pid).is_err() {
            let (client, _) = create_oob_client(session_arc)?;
            conn.client = client;
        }
    }

    let conn = slot.as_mut().unwrap();
    Ok(f(&mut conn.client, pid))
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
