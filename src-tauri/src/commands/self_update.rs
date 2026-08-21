//! One-click self-update: download the release asset for this architecture,
//! verify it against the published SHA256 sidecar, and swap it in over the
//! running executable.
//!
//! The app ships as a bare portable `.exe`, so there is no installer to hand
//! this to — but Windows opens a running image with `FILE_SHARE_DELETE`, which
//! means the *running* exe can be renamed out of the way and a new one moved
//! into its place. No helper script, no console-window flash, no elevation:
//!
//! ```text
//! joybug-tauri.exe          -> joybug-tauri.exe.<uuid>.old
//! joybug-tauri.exe.download -> joybug-tauri.exe
//! spawn joybug-tauri.exe ; exit
//! ```
//!
//! The `.old` image stays mapped until this process dies, so deleting it is
//! left to [`cleanup_stale_artifacts`] on the next launch.
//!
//! Both scratch files are siblings of the exe on purpose: a rename across
//! volumes is a copy, and would defeat the atomicity the swap relies on.
//!
//! Whether any of this is possible for a given release is decided up front by
//! [`probe`], reported as `UpdateInfo::self_update`, so the dialog can offer the
//! browser download instead of failing after a 40 MB transfer. Progress is
//! streamed to the frontend over the `update-install-progress` event.

use crate::commands::updates::{self, SelfUpdateState};
use crate::error::{Error, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tracing::{debug, error, info, warn};

/// Suffix of the partially-downloaded replacement.
const STAGING_SUFFIX: &str = ".download";
/// Suffix of the renamed-aside previous image. The `<uuid>` in between keeps a
/// second update from colliding with a backup the OS hasn't released yet.
const BACKUP_SUFFIX: &str = ".old";

const CONNECT_TIMEOUT_SECS: u64 = 15;
/// Per-read, not total: a 40 MB download on a slow link is fine, a stalled
/// socket is not.
const READ_TIMEOUT_SECS: u64 = 60;

/// A SHA256 digest is 32 bytes — 64 hex characters.
const SHA256_HEX_LEN: usize = 64;

/// Progress is emitted at most this often; a fast download would otherwise
/// push thousands of IPC messages for a bar that has ~100 useful positions.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// How long, and how often, startup cleanup retries a backup the OS has not
/// released yet. The process that handed over is exiting as this one starts, so
/// in practice the first or second attempt succeeds.
const CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(15);
const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------
// The running image
// ---------------------------------------------------------------------------

/// Path of the running executable, resolved once and cached.
///
/// On Windows `current_exe()` reads a string the loader captured at launch, so
/// renaming the file does not change what it returns — but that is a subtlety
/// to be independent of, not to rely on. [`cleanup_stale_artifacts`] runs at
/// startup and forces this to initialize long before anything can rename it.
static EXE_PATH: LazyLock<Option<PathBuf>> = LazyLock::new(|| match std::env::current_exe() {
    Ok(path) => Some(path),
    Err(e) => {
        warn!("Could not resolve the running executable: {e}");
        None
    }
});

fn exe_path() -> Result<&'static Path> {
    EXE_PATH
        .as_deref()
        .ok_or_else(|| Error::UpdateInstall("Joybug can't locate its own executable".to_string()))
}

/// `<exe><suffix>`, i.e. a sibling that keeps the whole file name including
/// `.exe` — `Path::with_extension` would eat it.
fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn staging_path(exe: &Path) -> PathBuf {
    sibling(exe, STAGING_SUFFIX)
}

fn backup_path(exe: &Path) -> PathBuf {
    sibling(exe, &format!(".{}{BACKUP_SUFFIX}", uuid::Uuid::new_v4()))
}

/// Is `entry` one of *our* scratch files for the exe named `exe_name`?
///
/// Deliberately not a `*.old` glob: the exe may sit in a folder full of the
/// user's own files, and this deletes what it matches.
fn is_stale_artifact(exe_name: &str, entry: &str) -> bool {
    let Some(tail) = entry.strip_prefix(exe_name) else {
        return false;
    };
    tail == STAGING_SUFFIX || (tail.starts_with('.') && tail.ends_with(BACKUP_SUFFIX))
}

/// Delete leftovers from a previous update: the renamed-aside old image and any
/// partial download.
///
/// Retries in the background, because the launch that follows a self-update is
/// this one: [`restart_app`] spawns the new process *before* it exits, so for
/// the first moments of this process the old image is still mapped and cannot
/// be deleted. Without the retry the backup would survive until some later,
/// unrelated launch — leaving a full copy of the previous version behind.
///
/// Best-effort throughout: if the window expires, the next launch tries again.
pub fn cleanup_stale_artifacts() {
    // Resolve the exe path here, on the way in, while it is still unambiguous.
    let Ok(exe) = exe_path() else { return };
    let exe = exe.to_path_buf();

    std::thread::spawn(move || {
        let deadline = Instant::now() + CLEANUP_RETRY_WINDOW;
        loop {
            if sweep_stale_artifacts(&exe) {
                return;
            }
            if Instant::now() >= deadline {
                debug!("Gave up on leftover update artifacts; the next launch retries");
                return;
            }
            std::thread::sleep(CLEANUP_RETRY_INTERVAL);
        }
    });
}

/// One pass. Returns `true` when nothing is left to remove — either because
/// there never was anything, or because this pass got it all.
fn sweep_stale_artifacts(exe: &Path) -> bool {
    let (Some(dir), Some(exe_name)) = (exe.parent(), exe.file_name().and_then(|n| n.to_str()))
    else {
        return true;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };

    let mut all_gone = true;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_stale_artifact(exe_name, name) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => info!("Removed leftover update artifact {name}"),
            // The previous version is still mapped — try again shortly.
            Err(e) => {
                debug!("Could not yet remove leftover update artifact {name}: {e}");
                all_gone = false;
            }
        }
    }
    all_gone
}

/// Can this install replace itself in place? Reported at check time so the
/// dialog can offer the right button instead of failing after a 40 MB download.
pub fn probe(download_url: Option<&str>, checksum_url: Option<&str>) -> SelfUpdateState {
    let unsupported = |reason: &str| SelfUpdateState {
        supported: false,
        reason: Some(reason.to_string()),
    };

    if download_url.is_none() {
        return unsupported("that release has no download for this architecture");
    }
    if checksum_url.is_none() {
        return unsupported("that release publishes no checksum to verify the download against");
    }
    let Ok(exe) = exe_path() else {
        return unsupported("Joybug can't locate its own executable");
    };
    let Some(dir) = exe.parent() else {
        return unsupported("Joybug can't locate its own folder");
    };
    if let Err(e) = ensure_writable(dir) {
        debug!("Self-update unavailable: {e}");
        return unsupported("Joybug's folder is read-only — move it somewhere writable first");
    }

    SelfUpdateState {
        supported: true,
        reason: None,
    }
}

/// Probe by actually writing, not by reading permission bits: on Windows an
/// ACL check is not something you can usefully predict from metadata.
fn ensure_writable(dir: &Path) -> Result<()> {
    let probe = dir.join(format!(".joybug-write-probe-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"")
        .map_err(|e| Error::UpdateInstall(format!("{} is not writable: {e}", dir.display())))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct InstallProgress {
    /// `checksum` | `downloading` | `verifying` | `installing` | `done`
    phase: &'static str,
    downloaded: u64,
    /// `None` when the server sent no `Content-Length` and the release listing
    /// carried no asset size either.
    total: Option<u64>,
}

fn emit_progress(app: &tauri::AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let payload = InstallProgress {
        phase,
        downloaded,
        total,
    };
    if let Err(e) = app.emit("update-install-progress", &payload) {
        error!("Failed to emit update-install-progress event: {}", e);
    }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Separate from `updates::HTTP`, whose 10s total timeout is right for an API
/// query and fatal for a 40 MB download.
static DOWNLOAD_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
});

/// Pull the expected digest out of a `sha256sum`-format sidecar
/// (`<lowercase hex><two spaces><file name>\n`, written by `_build.yml`).
fn parse_sha256_sidecar(body: &str) -> Result<String> {
    let hash = body
        .split_whitespace()
        .next()
        .ok_or_else(|| Error::UpdateInstall("the checksum file is empty".to_string()))?;

    if hash.len() != SHA256_HEX_LEN || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::UpdateInstall(format!(
            "the checksum file does not contain a SHA256 digest (got {:?})",
            hash.chars().take(80).collect::<String>()
        )));
    }
    Ok(hash.to_ascii_lowercase())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// The swap
// ---------------------------------------------------------------------------

/// Move `staged` over `current`, keeping the displaced original at `backup`.
///
/// The rollback in the middle is the whole point: a failure after the first
/// rename would otherwise leave the user with no executable at all.
fn swap_in_place(current: &Path, staged: &Path, backup: &Path) -> Result<()> {
    std::fs::rename(current, backup).map_err(|e| {
        Error::UpdateInstall(format!("could not move the running executable aside: {e}"))
    })?;

    if let Err(install_err) = std::fs::rename(staged, current) {
        if let Err(restore_err) = std::fs::rename(backup, current) {
            return Err(Error::UpdateInstall(format!(
                "could not install the update ({install_err}) and could not put the original back \
                 ({restore_err}) — the previous version is at {}",
                backup.display()
            )));
        }
        return Err(Error::UpdateInstall(format!(
            "could not install the update: {install_err}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One install at a time. Two clicks would otherwise race for the same staging
/// file and, worse, for the swap.
static INSTALLING: AtomicBool = AtomicBool::new(false);

struct InstallGuard;

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::Release);
    }
}

impl InstallGuard {
    fn acquire() -> Result<Self> {
        INSTALLING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| InstallGuard)
            .map_err(|_| Error::UpdateInstall("an update is already being installed".to_string()))
    }
}

/// Download, verify, and swap in the release asset at `download_url`.
///
/// Returns once the new executable is in place — the running process is still
/// the old image, so the caller follows up with [`restart_app`].
#[tauri::command]
pub async fn install_update(
    app_handle: tauri::AppHandle,
    download_url: String,
    checksum_url: String,
) -> Result<()> {
    let _guard = InstallGuard::acquire()?;

    let exe = exe_path()?;
    let dir = exe
        .parent()
        .ok_or_else(|| Error::UpdateInstall("Joybug can't locate its own folder".to_string()))?;
    ensure_writable(dir)?;

    let user_agent = updates::user_agent(&updates::current_version(&app_handle));

    // 1. Expected digest. Small file, so the short-timeout client is right.
    emit_progress(&app_handle, "checksum", 0, None);
    let expected = parse_sha256_sidecar(&fetch_text(&checksum_url, &user_agent).await?)?;

    // 2. Stream the asset to a sibling of the exe, hashing as it lands.
    let staged = staging_path(exe);
    let downloaded =
        match download_to(&app_handle, &download_url, &staged, &expected, &user_agent).await {
            Ok(n) => n,
            Err(e) => {
                let _ = std::fs::remove_file(&staged);
                return Err(e);
            }
        };

    // 3. Swap. Past this point the old image is only reachable via the backup.
    emit_progress(&app_handle, "installing", downloaded, Some(downloaded));
    let backup = backup_path(exe);
    swap_in_place(exe, &staged, &backup).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })?;

    // Expected to fail while this process still has the old image mapped;
    // cleanup_stale_artifacts() gets it on the next launch.
    if let Err(e) = std::fs::remove_file(&backup) {
        debug!("Previous version left at {}: {e}", backup.display());
    }

    info!("Update installed over {}", exe.display());
    emit_progress(&app_handle, "done", downloaded, Some(downloaded));
    Ok(())
}

async fn fetch_text(url: &str, user_agent: &str) -> Result<String> {
    let response = updates::http()
        .get(url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .send()
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not fetch the checksum: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::UpdateInstall(format!(
            "the checksum download returned {status}"
        )));
    }
    response
        .text()
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not read the checksum: {e}")))
}

/// Stream `url` into `staged`, emitting progress, and verify the digest before
/// declaring success. Returns the number of bytes written.
async fn download_to(
    app: &tauri::AppHandle,
    url: &str,
    staged: &Path,
    expected: &str,
    user_agent: &str,
) -> Result<u64> {
    use sha2::Digest;

    let mut response = DOWNLOAD_HTTP
        .get(url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .send()
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not start the download: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::UpdateInstall(format!(
            "the download returned {status}"
        )));
    }
    let total = response.content_length();

    let mut file = tokio::fs::File::create(staged)
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not create {}: {e}", staged.display())))?;
    let mut hasher = sha2::Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();

    emit_progress(app, "downloading", 0, total);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| Error::UpdateInstall(format!("the download failed: {e}")))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| Error::UpdateInstall(format!("could not write the download: {e}")))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            emit_progress(app, "downloading", downloaded, total);
            last_emit = Instant::now();
        }
    }

    // Get every byte on disk before it is renamed into place as the executable.
    file.flush()
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not flush the download: {e}")))?;
    file.sync_all()
        .await
        .map_err(|e| Error::UpdateInstall(format!("could not flush the download: {e}")))?;
    drop(file);

    emit_progress(app, "verifying", downloaded, total.or(Some(downloaded)));
    let actual = hex(&hasher.finalize());
    if actual != expected {
        return Err(Error::UpdateInstall(format!(
            "the download does not match the published checksum (expected {expected}, got {actual})"
        )));
    }
    Ok(downloaded)
}

/// Relaunch and quit. After [`install_update`], the exe at this path is the new
/// version — which is why this spawns the captured path explicitly rather than
/// using `AppHandle::restart()`, whose `current_exe()` lookup is ambiguous at
/// exactly this moment.
#[tauri::command]
pub fn restart_app(app_handle: tauri::AppHandle) -> Result<()> {
    let exe = exe_path()?;
    let mut command = std::process::Command::new(exe);
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    command
        .spawn()
        .map_err(|e| Error::UpdateInstall(format!("could not relaunch {}: {e}", exe.display())))?;

    info!("Relaunching {}", exe.display());
    app_handle.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that cleans itself up, so the swap tests can work on
    /// real files without pulling in a dev-dependency.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("joybug-selfupdate-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn file(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sibling_keeps_the_whole_file_name() {
        let exe = Path::new(r"C:\tools\joybug-tauri.exe");
        // `with_extension` would produce `joybug-tauri.download` and orphan the
        // cleanup matcher.
        assert_eq!(
            staging_path(exe),
            PathBuf::from(r"C:\tools\joybug-tauri.exe.download")
        );
    }

    #[test]
    fn backup_path_is_unique_per_call() {
        let exe = Path::new(r"C:\tools\joybug-tauri.exe");
        let a = backup_path(exe);
        let b = backup_path(exe);
        assert_ne!(
            a, b,
            "a second update must not collide with a locked backup"
        );
        for path in [&a, &b] {
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("joybug-tauri.exe."));
            assert!(name.ends_with(".old"));
            assert!(is_stale_artifact("joybug-tauri.exe", name));
        }
    }

    #[test]
    fn is_stale_artifact_matches_only_our_scratch_files() {
        let exe = "joybug-tauri.exe";
        assert!(is_stale_artifact(exe, "joybug-tauri.exe.download"));
        assert!(is_stale_artifact(
            exe,
            "joybug-tauri.exe.6f1a5a1e-0000-4000-8000-000000000000.old"
        ));

        // The running exe itself, above all else.
        assert!(!is_stale_artifact(exe, "joybug-tauri.exe"));
        // Someone else's files in the same folder.
        assert!(!is_stale_artifact(exe, "notes.old"));
        assert!(!is_stale_artifact(exe, "other.exe.old"));
        assert!(!is_stale_artifact(exe, "joybug-tauri.exe.log"));
        // Prefix match without the separating dot.
        assert!(!is_stale_artifact(exe, "joybug-tauri.exe2.old"));
    }

    #[test]
    fn sweep_stale_artifacts_removes_only_our_scratch_files() {
        let dir = TempDir::new();
        let exe = dir.file("app.exe", "current");
        dir.file("app.exe.download", "partial");
        dir.file("app.exe.1111.old", "previous");
        dir.file("notes.old", "the user's");
        dir.file("app.exe.log", "the app's");

        assert!(sweep_stale_artifacts(&exe));

        let mut left: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_str().unwrap().to_string())
            .collect();
        left.sort();
        assert_eq!(left, ["app.exe", "app.exe.log", "notes.old"]);
    }

    #[test]
    fn parse_sha256_sidecar_reads_the_build_format() {
        let digest = "a".repeat(SHA256_HEX_LEN);
        assert_eq!(
            parse_sha256_sidecar(&format!("{digest}  Joybug-UI-x64.exe\n")).unwrap(),
            digest
        );
        // No trailing newline, and uppercase from a different hashing tool.
        assert_eq!(
            parse_sha256_sidecar(&format!("{}  x.exe", "A".repeat(SHA256_HEX_LEN))).unwrap(),
            "a".repeat(SHA256_HEX_LEN)
        );
    }

    #[test]
    fn parse_sha256_sidecar_rejects_anything_else() {
        assert!(parse_sha256_sidecar("").is_err());
        assert!(parse_sha256_sidecar("   \n").is_err());
        // A truncated digest, and the right length but not hex — both would
        // otherwise fail the comparison with a far less useful message.
        assert!(parse_sha256_sidecar("abc123  x.exe").is_err());
        assert!(parse_sha256_sidecar(&format!("{}  x.exe", "z".repeat(SHA256_HEX_LEN))).is_err());
        // An HTML error page served instead of the asset.
        assert!(parse_sha256_sidecar("<!DOCTYPE html>").is_err());
    }

    #[test]
    fn hex_pads_every_byte() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn swap_in_place_installs_and_keeps_the_backup() {
        let dir = TempDir::new();
        let current = dir.file("app.exe", "old");
        let staged = dir.file("app.exe.download", "new");
        let backup = dir.0.join("app.exe.backup");

        swap_in_place(&current, &staged, &backup).unwrap();

        assert_eq!(std::fs::read_to_string(&current).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old");
        assert!(!staged.exists());
    }

    #[test]
    fn swap_in_place_restores_the_original_when_the_install_fails() {
        let dir = TempDir::new();
        let current = dir.file("app.exe", "old");
        // Never staged — the second rename fails, which is the case that would
        // otherwise leave the user with no executable.
        let staged = dir.0.join("app.exe.download");
        let backup = dir.0.join("app.exe.backup");

        let err = swap_in_place(&current, &staged, &backup).unwrap_err();

        assert!(matches!(err, Error::UpdateInstall(_)));
        assert_eq!(
            std::fs::read_to_string(&current).unwrap(),
            "old",
            "the original executable must be back in place"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn probe_reports_why_it_cannot_self_update() {
        let none = probe(None, Some("https://example.test/x.sha256"));
        assert!(!none.supported);
        assert!(none.reason.unwrap().contains("architecture"));

        let no_sum = probe(Some("https://example.test/x.exe"), None);
        assert!(!no_sum.supported);
        assert!(no_sum.reason.unwrap().contains("checksum"));
    }

    #[test]
    fn ensure_writable_accepts_a_writable_dir_and_leaves_nothing_behind() {
        let dir = TempDir::new();
        ensure_writable(&dir.0).unwrap();
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);

        assert!(ensure_writable(&dir.0.join("does-not-exist")).is_err());
    }
}
