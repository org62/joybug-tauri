//! Staging the guest binary for a Windows Sandbox session.
//!
//! There is only one: **this exe**. It already links joybug-core and the ETW
//! collector, and [`crate::guest_mode`] turns it into whichever the guest needs
//! based on the flags it is launched with — so staging is a file copy, not an
//! extraction, and nothing has to be embedded, built separately, or kept in
//! version step with the app.
//!
//! The copy goes into a content-addressed folder under the data dir, which is
//! then shared read-only into the guest along with the VC runtime it needs.

use std::path::PathBuf;

/// Guest-side filename of the staged exe. `joybug_core::sandbox` builds the
/// in-guest command lines against this name (see `ProvisionConfig::guest_exe`).
pub const GUEST_EXE: &str = "joybug.exe";

/// Stage the guest binary and the VC runtime into a content-addressed folder
/// under the data dir, returning its path. Idempotent: staging is skipped when
/// the folder already holds them.
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

    stage_vc_runtime(&dir);
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

/// Copy the VC runtime DLLs the exe needs into `dir` (the bare sandbox image has
/// no VC++ redistributable). Host arch == guest arch, so the host's own System32
/// copies are correct. Best-effort: a missing DLL is logged, not fatal (the
/// failure would otherwise surface as a guest 0xC0000135).
fn stage_vc_runtime(dir: &std::path::Path) {
    let sys32 = std::env::var("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Windows\System32"));
    for dll in ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"] {
        let dst = dir.join(dll);
        if dst.exists() {
            continue;
        }
        let src = sys32.join(dll);
        if let Err(e) = std::fs::copy(&src, &dst) {
            tracing::warn!("could not stage {} into guest-bin: {e}", dll);
        }
    }
}
