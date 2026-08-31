//! Poll ETW events collected by the ETW collector (in-sandbox or on the host).
//!
//! The tracer writes newline-delimited JSON into the writable `C:\io` share; the
//! host tails that file. Events have no id of their own, so we assign a
//! monotonic `seq` = 1-based line number and the UI polls with the last seq it
//! has seen (`from_seq`), mirroring the watchpoint-trace poll pattern.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::state::{SandboxHandlesMap, SessionStatesMap};

/// One ETW event row for the UI. Field shape mirrors the frontend `EtwEvent`.
#[derive(Debug, Clone, Serialize)]
pub struct EtwEventRow {
    pub seq: u64,
    /// Wall-clock `HH:MM:SS.mmm` (UTC), best-effort from the ETW FILETIME.
    pub time: String,
    pub kind: String,
    pub op: String,
    pub pid: Option<u32>,
    pub image: Option<String>,
    pub ppid: Option<u32>,
    pub path: Option<String>,
    pub size: Option<u64>,
    pub dest: Option<String>,
    pub exit: Option<i64>,
    /// Captured callstack as hex return addresses (`--stacks`); None otherwise.
    pub stack: Option<Vec<String>>,
    /// Audit events: the process acted upon (`pid` is the actor).
    pub target_pid: Option<u32>,
    /// Audit events: decoded DesiredAccess, e.g. "VM_READ|VM_WRITE".
    pub access: Option<String>,
    /// Audit events: NTSTATUS of the audited call; 0 is success.
    pub status: Option<u32>,
}

/// Return ETW rows with `seq > from_seq` for `session_id`. Empty when the session
/// isn't a sandbox session, ETW is off, or the tracer hasn't written yet.
#[tauri::command]
pub async fn poll_etw_events(
    session_id: String,
    from_seq: u64,
    sandbox_handles: State<'_, SandboxHandlesMap>,
) -> std::result::Result<Vec<EtwEventRow>, String> {
    // Resolve the JSONL path. A live sandbox handle points straight at it; once a
    // session ends (or for HOST ETW, which has no sandbox handle) the file still
    // lives on disk, so fall back to the deterministic per-mode paths. First
    // existing wins. For a non-ETW session none exist → empty.
    let path = {
        let handles = sandbox_handles.lock().unwrap();
        match handles.get(&session_id) {
            Some(h) if h.etw_enabled => Some(h.io_dir.join(&h.etw_out_file)),
            // Handle present but ETW disabled (debug mode, collect-ETW off): none.
            Some(_) => None,
            None => etw_events_path_on_disk(&session_id),
        }
    };
    let Some(path) = path else {
        return Ok(Vec::new());
    };

    super::run_blocking(move || Ok(read_rows(&path, from_seq)))
        .await
        .map_err(|e| e.to_string())
}

/// Symbolize an ETW callstack (hex return addresses) to `module!func+0xoffset`.
/// When the session has a live debug server (a debugger is attached), resolves
/// via the non-blocking batch `try_resolve_addresses_to_symbols` over the OOB
/// pool (works while the target is Running); unresolved frames and detached
/// sessions fall back to the raw `0x…` address (base+address only).
#[tauri::command]
pub async fn resolve_etw_stack(
    session_id: String,
    pid: u32,
    addresses: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> std::result::Result<Vec<String>, String> {
    if addresses.is_empty() {
        return Ok(Vec::new());
    }
    let arc = match super::get_session_arc(&session_id, &session_states) {
        Ok(a) => a,
        Err(_) => return Ok(addresses), // no session → raw addresses
    };
    // Detached (no debug server): base+address only — return the raw frames.
    if arc.lock().unwrap().server_url.is_empty() {
        return Ok(addresses);
    }
    let addrs: Vec<u64> = addresses
        .iter()
        .map(|a| super::parse_hex_u64(a, "frame").unwrap_or(0))
        .collect();
    let raw = addresses.clone();
    let resolved = super::with_oob_client(&arc, &session_id, &oob_pool, move |client, _sess_pid| {
        match client.try_resolve_addresses_to_symbols(pid, addrs.clone()) {
            Ok(results) => results
                .into_iter()
                .zip(raw.iter())
                .map(|(r, hex)| match r {
                    Some((module, sym, offset)) => {
                        let short = crate::session::helpers::extract_module_name(&module);
                        crate::session::helpers::format_symbol(&short, &sym.name, offset)
                    }
                    None => hex.clone(),
                })
                .collect::<Vec<String>>(),
            Err(_) => raw.clone(),
        }
    });
    Ok(resolved.unwrap_or(addresses))
}

/// The deterministic on-disk JSONL path for a session's ETW events, checking the
/// HOST location first then the sandbox location. The layout owners are
/// `crate::etw::events_path` and `crate::sandbox::io_events_path`; this only
/// picks the first that exists, or `None`.
pub fn etw_events_path_on_disk(session_id: &str) -> Option<std::path::PathBuf> {
    [
        crate::etw::events_path(session_id),
        crate::sandbox::io_events_path(session_id),
    ]
    .into_iter()
    .find(|p| p.exists())
}

/// Per-file read cursor. Lets each poll seek instead of rescanning the whole
/// growing JSONL every second; the incremental logic lives in
/// `joybug_core::etw::read_events`.
fn cursors() -> &'static Mutex<HashMap<std::path::PathBuf, joybug_core::etw::EventCursor>> {
    static CURSORS: std::sync::OnceLock<
        Mutex<HashMap<std::path::PathBuf, joybug_core::etw::EventCursor>>,
    > = std::sync::OnceLock::new();
    CURSORS.get_or_init(Default::default)
}

/// Per-poll read cap. Bounds the parse + IPC cost of one poll against a large
/// backlog (e.g. the first poll after reopening a session with a long trace on
/// disk); the 1 Hz poll drains the rest incrementally via the cursor.
const MAX_POLL_BYTES: u64 = 8 * 1024 * 1024;

fn read_rows(path: &std::path::Path, from_seq: u64) -> Vec<EtwEventRow> {
    let cursor = cursors().lock().unwrap().get(path).copied().unwrap_or_default();
    let (events, new_cursor) =
        joybug_core::etw::read_events_capped(path, from_seq, cursor, MAX_POLL_BYTES);
    cursors().lock().unwrap().insert(path.to_path_buf(), new_cursor);
    events.into_iter().map(|(seq, ev)| row_from_event(seq, ev)).collect()
}

/// Drop the read cursors for a session's (possible) events files. Called on
/// session delete so the app-lifetime cursor map doesn't accumulate entries for
/// sessions that no longer exist.
pub fn evict_cursors(session_id: &str) {
    let mut cursors = cursors().lock().unwrap();
    cursors.remove(&crate::etw::events_path(session_id));
    cursors.remove(&crate::sandbox::io_events_path(session_id));
}

fn row_from_event(seq: u64, ev: joybug_core::etw::TraceEvent) -> EtwEventRow {
    EtwEventRow {
        seq,
        time: joybug_core::etw::filetime_to_hms(ev.ts),
        kind: ev.kind,
        op: ev.op,
        pid: ev.pid,
        image: ev.image,
        ppid: ev.ppid,
        path: ev.path.map(|p| joybug_core::etw::pretty_path(&p)),
        size: ev.size,
        dest: ev.dest,
        exit: ev.exit.map(i64::from),
        stack: ev.stack,
        target_pid: ev.target_pid,
        access: ev.access,
        status: ev.status,
    }
}
