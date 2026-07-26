mod bookmarks;
mod breakpoints;
mod coverage;
mod disassembly;
mod emulation;
mod logging;
mod memory;
mod patches;
mod pe_file;
mod session_lifecycle;
mod settings;
mod source;
mod stepping;
mod symbols;
pub(crate) mod types;
mod type_system;
mod updates;
mod watchpoints;
mod window_state;

pub use bookmarks::*;
pub use breakpoints::*;
pub use coverage::*;
pub use disassembly::*;
pub use emulation::*;
pub use logging::*;
pub use memory::*;
pub use patches::*;
pub use pe_file::*;
pub use session_lifecycle::*;
pub use settings::*;
pub use source::*;
pub use stepping::*;
pub use symbols::*;
pub use type_system::*;
pub use updates::*;
pub use watchpoints::*;
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

/// Create an OOB joybug-core client sharing the real session's state.
/// Returns (oob_client, pid).
pub(crate) fn create_oob_client(
    session_state: &Arc<Mutex<SessionStateUI>>,
) -> Result<(crate::session::types::DebugSession, u32)> {
    let pid = oob_pid(session_state)?;
    let server_url = session_state.lock().unwrap().server_url.clone();
    let client = joybug_core::protocol_io::DebugSession::new(session_state.clone(), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?;
    // OOB clients do request/response, so bound the wait — a stalled/half-open
    // server (possible over a network) must not hang the calling command thread.
    // The debug-loop client (built separately in session/runner.rs) is left
    // blocking on purpose, since it waits arbitrarily long between debug events.
    let _ = client.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    Ok((client, pid))
}

/// One reused OOB connection for a session, pinned to the pid it was opened for.
pub(crate) struct OobConn {
    client: crate::session::types::DebugSession,
    pid: u32,
}

/// Pool of long-lived OOB clients, one per session. Holds two independent
/// connections per session:
/// - `live`: high-frequency live polling (bookmark values) and freeze registration.
/// - `scan`: stateful memory/pointer scans, kept on their own connection so a long
///   scan doesn't head-of-line-block bookmark polling / freeze on `live`.
/// Per-session inner locks keep sessions from serialising.
#[derive(Default)]
pub struct OobPool {
    live: Mutex<std::collections::HashMap<String, Arc<Mutex<Option<OobConn>>>>>,
    scan: Mutex<std::collections::HashMap<String, Arc<Mutex<Option<OobConn>>>>>,
}

impl OobPool {
    /// Drop a session's pooled connections (call on stop/delete so the sockets and
    /// their server-side connections — including scanners and freezes — are released).
    pub(crate) fn remove(&self, session_id: &str) {
        self.live.lock().unwrap().remove(session_id);
        self.scan.lock().unwrap().remove(session_id);
    }
}

/// Resolve a session's OOB target pid: prefer the running/paused debug event's
/// pid; fall back to a non-invasive session's opened pid (which has no debug event).
fn oob_pid(session_arc: &Arc<Mutex<SessionStateUI>>) -> Result<u32> {
    let pid = {
        let state = session_arc.lock().unwrap();
        // A stopped session has no live target: fast-fail so background pollers
        // that are still in flight when the session stops return immediately,
        // instead of slow-failing (~seconds) against the dying server and
        // serialising ahead of stop/delete on the command executor.
        if matches!(state.status, SessionStatusUI::Stopped) {
            return Err(Error::InvalidSessionState("Session is stopped".to_string()));
        }
        state
            .current_event
            .as_ref()
            .map(|ev| ev.pid())
            .or(state.open_pid)
            .unwrap_or(0)
    };
    if pid == 0 {
        return Err(Error::InvalidSessionState("No active process".to_string()));
    }
    Ok(pid)
}

/// Flatten the nested result of an OOB call — pool/connection error outside,
/// protocol error inside — into one string-error result for event emission.
pub(crate) fn flatten_oob<T, E: std::fmt::Display>(
    result: Result<std::result::Result<T, E>>,
) -> std::result::Result<T, String> {
    match result {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// Route a command through the paused session channel when possible; otherwise
/// (running without a pause, or a non-invasive `Open` session) run `fallback`
/// on the session's pooled live OOB client. Shared scaffolding for commands
/// that work identically on both paths and emit their results as events.
pub(crate) fn paused_or_oob(
    session_id: &str,
    session_states: &SessionStatesMap,
    pool: &OobPool,
    command: UICommand,
    fallback: impl FnOnce(&mut crate::session::types::DebugSession, u32),
) -> Result<()> {
    let session_arc = get_session_arc(session_id, session_states)?;
    if try_send_paused_command(&session_arc, command).is_err() {
        with_oob_client(&session_arc, session_id, pool, fallback)?;
    }
    Ok(())
}

/// Shared body for the pooled-connection helpers. `map` selects which per-session
/// connection (live vs scan). When `probe` is true, a cheap liveness check
/// reconnects a dead socket before running `f`.
fn with_pooled_client<R>(
    session_arc: &Arc<Mutex<SessionStateUI>>,
    session_id: &str,
    map: &Mutex<std::collections::HashMap<String, Arc<Mutex<Option<OobConn>>>>>,
    probe: bool,
    f: impl FnOnce(&mut crate::session::types::DebugSession, u32) -> R,
) -> Result<R> {
    let pid = oob_pid(session_arc)?;

    // Get (or create) this session's slot without holding the map lock during I/O.
    let slot_arc = {
        let mut map = map.lock().unwrap();
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
    // Skipped for scan connections so it never disturbs in-flight scanner state.
    if probe {
        let conn = slot.as_mut().unwrap();
        if conn.client.list_modules(pid).is_err() {
            let (client, _) = create_oob_client(session_arc)?;
            conn.client = client;
        }
    }

    let conn = slot.as_mut().unwrap();
    Ok(f(&mut conn.client, pid))
}

/// Run `f` with the reused **live** OOB client for `session_id`, (re)connecting when
/// the slot is empty, the pid changed (target restart), or the socket is dead. Used
/// for live polling and freeze registration without per-tick connection churn.
pub(crate) fn with_oob_client<R>(
    session_arc: &Arc<Mutex<SessionStateUI>>,
    session_id: &str,
    pool: &OobPool,
    f: impl FnOnce(&mut crate::session::types::DebugSession, u32) -> R,
) -> Result<R> {
    with_pooled_client(session_arc, session_id, &pool.live, true, f)
}

/// Run `f` with the reused **scan** OOB client for `session_id`. Stateful memory /
/// pointer scans must stay on one connection (their server-side scanner state is
/// per-connection); this connection is dedicated so a long scan doesn't block the
/// live connection, and uses no liveness probe so an in-flight scan is never reset.
pub(crate) fn with_oob_scan_client<R>(
    session_arc: &Arc<Mutex<SessionStateUI>>,
    session_id: &str,
    pool: &OobPool,
    f: impl FnOnce(&mut crate::session::types::DebugSession, u32) -> R,
) -> Result<R> {
    with_pooled_client(session_arc, session_id, &pool.scan, false, f)
}

/// Get target architecture from session state (context or host default).
pub(crate) fn get_session_arch(
    session_state: &Arc<Mutex<SessionStateUI>>,
) -> joybug_core::interfaces::Architecture {
    let state = session_state.lock().unwrap();
    match &state.current_context {
        Some(crate::state::SerializableThreadContext::X64(_)) => joybug_core::interfaces::Architecture::X64,
        Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug_core::interfaces::Architecture::Arm64,
        None => {
            #[cfg(target_arch = "x86_64")]
            { joybug_core::interfaces::Architecture::X64 }
            #[cfg(target_arch = "aarch64")]
            { joybug_core::interfaces::Architecture::Arm64 }
            #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
            { joybug_core::interfaces::Architecture::X64 }
        }
    }
}
