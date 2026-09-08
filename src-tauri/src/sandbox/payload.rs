//! Staging the guest binary for a Windows Sandbox session.
//!
//! There is only one: **this exe**. It already links joybug-core and the ETW
//! collector, and `joybug_core::guest_roles` turns it into whichever the guest
//! needs based on the flags it is launched with — so staging is a file copy,
//! not an extraction, and nothing has to be embedded, built separately, or kept
//! in version step with the app.
//!
//! The copy goes into a content-addressed folder under the data dir. Core's
//! `provision` snapshots that folder per session (adding the VC runtime the exe
//! needs) and shares the snapshot read-only into the guest.

use std::path::PathBuf;

/// Guest-side filename of the staged exe. `joybug_core::sandbox` builds the
/// in-guest command lines against this name (see `ProvisionConfig::guest_exe`).
pub const GUEST_EXE: &str = "joybug.exe";

/// Stage the guest binary into a content-addressed folder under the data dir,
/// returning its path. Idempotent: staging is skipped when the folder already
/// holds it.
pub fn stage() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate the running exe: {e}"))?;

    // Content-addressed so a new build stages into a fresh folder and never
    // serves a stale binary. Keyed on (length, mtime) rather than a hash of the
    // contents: the exe is tens of MB and hashing it on the way into every
    // session would be pure waste, while both fields change whenever the exe
    // does — including after a self-update.
    let key = exe_key(&exe)?;
    let dir = crate::data_dir::joybug_data_dir().join("guest-bin").join(key);
    let staged = dir.join(GUEST_EXE);

    if !staged.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        // Copy to a temp name and rename into place, so an interrupted copy can
        // never leave a truncated exe that later looks staged.
        let partial = dir.join("joybug.exe.partial");
        std::fs::copy(&exe, &partial)
            .map_err(|e| format!("copy {} into the guest folder: {e}", exe.display()))?;
        std::fs::rename(&partial, &staged)
            .map_err(|e| format!("finalize {GUEST_EXE}: {e}"))?;
    }

    Ok(dir)
}

/// A short identity for the running exe: its length and modification time, hex
/// encoded. Enough to notice a rebuild or a self-update, which is all this key
/// has to detect.
fn exe_key(exe: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(exe).map_err(|e| format!("stat {}: {e}", exe.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{:x}-{:x}", meta.len(), mtime))
}
