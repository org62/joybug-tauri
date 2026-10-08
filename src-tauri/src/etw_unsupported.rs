//! `crate::etw` on every OS but Windows. ETW is a Windows tracing facility, so
//! there is nothing to drive here; this keeps the session code's call sites
//! (`runner.rs`, `session_lifecycle.rs`, the app-exit hook) compiling against
//! the same names and signatures as `etw/mod.rs`, with every operation
//! reporting that it is unsupported. The UI never offers the option off
//! Windows, so a user only reaches these through a session record created
//! elsewhere.

use std::sync::{Arc, Mutex};

use crate::state::{EtwConfig, SessionStateUI};

const MESSAGE: &str = "ETW tracing is only available on Windows";

/// Never constructed - nothing can launch a tracer here - so the registry in
/// `state::HostTracersMap` is always empty.
pub struct HostTracer {
    _private: (),
}

/// See `etw::ensure_host_tracer`.
pub fn ensure_host_tracer(
    _tracers: &crate::state::HostTracersMap,
    _session_id: &str,
    _pid: u32,
    _etw: &EtwConfig,
) -> Result<(), String> {
    Err(MESSAGE.to_string())
}

/// See `etw::stop_host_tracer`. The map is always empty; kept for symmetry.
pub fn stop_host_tracer(tracers: &crate::state::HostTracersMap, session_id: &str) {
    tracers.lock().unwrap().remove(session_id);
}

/// See `etw::start_standalone_etw`.
pub fn start_standalone_etw(
    _session_id: String,
    _launch_command: String,
    _etw: EtwConfig,
    _session_state: Arc<Mutex<SessionStateUI>>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    Err(MESSAGE.to_string())
}
