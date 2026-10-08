//! `crate::sandbox` on every OS but Windows. Windows Sandbox is a Windows
//! feature; this keeps the session code's call sites compiling against the
//! same names as `sandbox/mod.rs`. `availability::status` reports the mode as
//! unavailable (with the reason the UI shows), `provision` is never reached
//! (`start_debug_session` refuses sandbox sessions off Windows before calling
//! it), and the handle type exists only so `state::SandboxHandlesMap` can be
//! declared - it is never constructed.

#[path = "sandbox/availability.rs"]
pub mod availability;

/// Never constructed off Windows.
pub struct SandboxHandle {
    _private: (),
}

/// See `sandbox::start_tracer` (re-exported from core there).
pub fn start_tracer(_handle: &SandboxHandle, _pid: u32) {}

/// See `sandbox::teardown`. The map is always empty; kept for symmetry.
pub fn teardown(handles: &crate::state::SandboxHandlesMap, session_id: &str) -> bool {
    handles.lock().unwrap().remove(session_id).is_some()
}
