//! Host ETW: run the ETW tracer on the HOST (outside a sandbox).
//!
//! The reusable mechanism — elevated launch, the resident control-file protocol,
//! spawn-mode launch, done detection — lives in `joybug_core::etw`. This module
//! is the app's thin shell over it: it owns the per-session on-disk layout (the
//! data dir), points at this exe as the collector host, and drives the two shapes:
//!
//!  * **attached** — [`ensure_host_tracer`] attaches (`--attach-pid`) to a
//!    locally-debugged target. It launches a *resident* tracer (via
//!    [`joybug_core::etw::HostTracer`]) so the same elevated process is reused
//!    across debuggee restarts — one UAC per session, re-targeted through the
//!    control file, torn down by [`stop_host_tracer`] on delete/app-exit.
//!  * **standalone** — [`start_standalone_etw`] launches a target under the
//!    tracer (spawn mode, no debugger; "procmon-lite"). The tracer's `tracer/done`
//!    marker ends the session when the target exits.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use joybug_core::etw::{EtwCaptureSpec, HostTracer, HostTracerConfig};
use tracing::info;

use crate::state::{EtwConfig, SessionStateUI, SessionStatusUI};

/// The per-session host ETW directory (`<data>/etw/<sid>`). Single owner of the
/// on-disk layout; not created here.
fn etw_dir(session_id: &str) -> PathBuf {
    crate::data_dir::joybug_data_dir().join("etw").join(session_id)
}

/// The host JSONL path for a session's ETW events. Does not create the parent —
/// use [`host_events_path`] when about to write, this when probing after the fact.
pub fn events_path(session_id: &str) -> PathBuf {
    etw_dir(session_id).join(format!("events-{session_id}.jsonl"))
}

/// [`events_path`], creating the parent dir (for launching a tracer that will
/// write there).
pub fn host_events_path(session_id: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(etw_dir(session_id)).map_err(|e| format!("create etw dir: {e}"))?;
    Ok(events_path(session_id))
}

/// The control-file path for a session's resident host tracer (same dir as the
/// events file).
fn control_path(session_id: &str) -> Result<PathBuf, String> {
    let dir = etw_dir(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create etw dir: {e}"))?;
    Ok(dir.join(format!("control-{session_id}.txt")))
}

/// The staged host tracer exe path, or an error if this build has no guest bins.
/// The executable that hosts the ETW collector: this one. `guest_mode` dispatches
/// into the collector when it sees the tracer's flags, so host tracing re-launches
/// the app rather than a separate binary — nothing to stage or keep in step.
fn tracer_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("locate the running exe: {e}"))
}

/// Build the core [`HostTracerConfig`] for a session: the staged tracer exe, the
/// per-session output path, an `etw-<sid>` session name, and the capture spec
/// from the app's `EtwConfig`.
fn host_tracer_config(session_id: &str, etw: &EtwConfig) -> Result<HostTracerConfig, String> {
    Ok(HostTracerConfig {
        tracer_exe: tracer_exe()?,
        out_path: host_events_path(session_id)?,
        session_name: format!("etw-{session_id}"),
        capture: EtwCaptureSpec { ops: etw.capture.ops.clone(), callstacks: etw.callstacks },
    })
}

/// Ensure a resident elevated tracer is running for `session_id`, attached to
/// `pid`. First call for the session launches it (one UAC prompt) with a control
/// file; every later call (e.g. after a debuggee restart) just re-targets the
/// running tracer through that control file — no new UAC. `tracers` is the
/// app-global registry that survives session restart.
pub fn ensure_host_tracer(
    tracers: &crate::state::HostTracersMap,
    session_id: &str,
    pid: u32,
    etw: &EtwConfig,
) -> Result<(), String> {
    // Fast path: already launched → re-target via the control file (no elevation).
    {
        let map = tracers.lock().unwrap();
        if let Some(tracer) = map.get(session_id) {
            return tracer.attach(pid);
        }
    }
    // First time for this session: launch the elevated resident tracer.
    let cfg = host_tracer_config(session_id, etw)?;
    let tracer = HostTracer::launch_attached(&cfg, control_path(session_id)?, pid)?;
    tracers.lock().unwrap().insert(session_id.to_string(), tracer);
    Ok(())
}

/// Tell a session's resident tracer to stop (drain + exit) and forget it. Called
/// on session delete and app exit — NOT on a plain stop, since a restart is a
/// stop+start and must keep the tracer alive to avoid re-prompting UAC. The
/// elevated tracer can't be killed by this non-elevated app, so `stop` via the
/// control file is the clean-exit path.
pub fn stop_host_tracer(tracers: &crate::state::HostTracersMap, session_id: &str) {
    let tracer = tracers.lock().unwrap().remove(session_id);
    if let Some(tracer) = tracer {
        let _ = tracer.stop();
    }
}

/// Standalone "ETW only" (no debugger): launch `launch_command` under the
/// elevated tracer (spawn mode) and watch for the target's exit (the tracer's
/// `tracer/done` marker), ending the session and emitting an update.
pub fn start_standalone_etw(
    session_id: String,
    launch_command: String,
    etw: EtwConfig,
    session_state: Arc<Mutex<SessionStateUI>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cfg = host_tracer_config(&session_id, &etw)?;
    let out = cfg.out_path.clone();
    // Split the command line on whitespace (simple v1 — quoted paths with spaces
    // aren't handled).
    let argv: Vec<String> = launch_command.split_whitespace().map(|s| s.to_string()).collect();
    joybug_core::etw::launch_spawn(&cfg, &argv)?;
    info!("started standalone host ETW tracer for session {session_id}");

    // Watcher: end the session when the tracer writes its done marker (target
    // exited), or when the user has already stopped it.
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            if matches!(
                session_state.lock().unwrap().status,
                SessionStatusUI::Stopped | SessionStatusUI::Error(_)
            ) {
                return; // user stopped it
            }
            if joybug_core::etw::tracer_done(&out) {
                {
                    let mut s = session_state.lock().unwrap();
                    if !matches!(s.status, SessionStatusUI::Stopped | SessionStatusUI::Error(_)) {
                        s.status = SessionStatusUI::Stopped;
                        s.clear_runtime_caches();
                    }
                }
                crate::session::emit_session_event(&session_state, &app_handle);
                info!("standalone ETW session {session_id} ended (target exited)");
                return;
            }
        }
    });
    Ok(())
}
