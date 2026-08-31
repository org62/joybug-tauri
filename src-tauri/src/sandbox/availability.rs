//! Windows Sandbox availability detection, surfaced to the UI so the sandbox run
//! mode can be disabled with a reason when it can't work. Mirrors the JIT-debugger
//! status pattern.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SandboxAvailability {
    /// OS build is new enough to have the `wsb.exe` CLI (>= 26100).
    pub supported: bool,
    /// Detected OS build number.
    pub build: u32,
    /// `wsb.exe` is present and launchable (the Windows Sandbox feature is installed).
    pub wsb_present: bool,
    /// Human-readable reason the mode is unavailable, or `None` when usable.
    pub reason: Option<String>,
}

/// Compute current sandbox availability. Cheap enough to call on demand from the UI.
///
/// This is now just core's OS-build + `wsb.exe` probe
/// ([`joybug_core::sandbox::status`]). There is no longer an app-side "were the
/// guest binaries embedded?" concern: the guest runs a copy of this very exe
/// (see [`super::payload`]), so if the app is running at all, the binary it
/// needs exists.
pub fn status() -> SandboxAvailability {
    let core = joybug_core::sandbox::status();
    SandboxAvailability {
        supported: core.supported,
        build: core.build,
        wsb_present: core.wsb_present,
        reason: core.reason,
    }
}
