//! Commands for the Windows Sandbox run mode.

use tauri::State;

use crate::sandbox::availability::SandboxAvailability;
use crate::state::SandboxHandlesMap;

/// Report whether the Windows Sandbox run mode is available on this system
/// (OS build, `wsb.exe` present, guest binaries embedded). Drives the UI's
/// mode picker + settings status row.
///
/// The probe spawns `wsb.exe`, and this command runs on every mount of the
/// pages that show the status — so an *available* verdict is cached for the
/// app's lifetime (the OS build and embedded assets can't change, and the
/// feature can't realistically be uninstalled mid-run). An unavailable verdict
/// is re-probed each time, so enabling the Windows Sandbox feature is picked up
/// without an app restart.
#[tauri::command]
pub async fn get_sandbox_status() -> std::result::Result<SandboxAvailability, String> {
    static AVAILABLE: std::sync::OnceLock<SandboxAvailability> = std::sync::OnceLock::new();
    if let Some(cached) = AVAILABLE.get() {
        return Ok(cached.clone());
    }
    // `Sandbox::list()` spawns wsb.exe, so keep it off the async workers.
    let status = super::run_blocking(|| Ok(crate::sandbox::availability::status()))
        .await
        .map_err(|e| e.to_string())?;
    if status.reason.is_none() {
        let _ = AVAILABLE.set(status.clone());
    }
    Ok(status)
}

/// Open the interactive Windows Sandbox viewer for a running sandbox session so
/// the user can see and interact with the guest desktop (`wsb connect`).
#[tauri::command]
pub fn open_sandbox_view(
    session_id: String,
    sandbox_handles: State<'_, SandboxHandlesMap>,
) -> std::result::Result<(), String> {
    let handles = sandbox_handles.lock().unwrap();
    match handles.get(&session_id) {
        Some(h) => h.sandbox.connect().map_err(|e| e.to_string()),
        None => Err("This session has no running sandbox to view.".to_string()),
    }
}
