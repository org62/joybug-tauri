//! Update check against the GitHub Releases API, plus the first-run welcome
//! dialog's state.
//!
//! This is deliberately *not* `tauri-plugin-updater`: the app ships as a bare
//! portable `.exe` (`bundle.active: false`), and that plugin can only install
//! signed NSIS/MSI bundles. So we notify and link to the release page instead.

use crate::app_state_store::{self, AppState};
use crate::error::{Error, Result};
use crate::settings::SettingsState;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tauri::State;
use tracing::{debug, warn};

const RELEASES_LATEST_API: &str =
    "https://api.github.com/repos/org62/joybug-tauri/releases/latest";

/// A local build reports the `tauri.conf.json` placeholder — release CI stamps
/// the real version from the git tag. Every release looks newer than this, so
/// the automatic check has to sit out.
const DEV_VERSION: &str = "0.0.0";

/// Hard kill switch, independent of the user setting. Set by the e2e harness so
/// the suite never touches the network; also useful for offline/locked-down
/// installs.
const ENV_NO_UPDATE_CHECK: &str = "JOYBUG_NO_UPDATE_CHECK";
/// Same idea for the first-run dialog — a modal at mount would block every e2e
/// test, since the suite attaches to an already-running app.
const ENV_NO_WELCOME: &str = "JOYBUG_NO_WELCOME";

const CHECK_TIMEOUT_SECS: u64 = 10;
const THROTTLE_HOURS: i64 = 24;
/// Release bodies can be long (generated notes list every commit); the dialog
/// only has room for a summary.
const MAX_NOTES_CHARS: usize = 4000;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// The subset of GitHub's release payload we care about.
#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    /// `tag_name` with any leading `v` stripped.
    pub latest_version: String,
    pub update_available: bool,
    /// Always set — the release page works even when no asset matches this arch.
    pub release_url: String,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    /// True for an unstamped local build, so the UI can say "development build"
    /// instead of pretending a release is an upgrade.
    pub is_dev_build: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WelcomeState {
    pub should_show: bool,
    pub version: String,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// `v0.2.0` and `0.2.0` both mean the same release.
fn normalize_tag(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// Is `latest` a newer release than `current`?
///
/// An unparsable tag returns `false` on purpose: nagging about an upgrade that
/// isn't one is worse than staying quiet.
fn is_newer(current: &str, latest: &str) -> bool {
    let (Ok(current), Ok(latest)) = (
        semver::Version::parse(normalize_tag(current)),
        semver::Version::parse(normalize_tag(latest)),
    ) else {
        return false;
    };
    latest > current
}

/// Release-artifact suffix for the running architecture, matching the names
/// `.github/workflows/_build.yml` stages.
fn arch_suffix() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("aarch64"),
        _ => None,
    }
}

/// Pick the asset built for this machine, e.g. `Joybug-UI-x64.exe`.
fn match_asset<'a>(assets: &'a [GhAsset], arch: &str) -> Option<&'a str> {
    let suffix = format!("-{arch}.exe");
    assets
        .iter()
        .find(|a| a.name.ends_with(&suffix))
        .map(|a| a.browser_download_url.as_str())
}

fn truncate_notes(body: Option<String>) -> Option<String> {
    let body = body?;
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    // One pass: the byte offset of char `MAX_NOTES_CHARS` is both the "is it too
    // long?" answer and the cut point.
    Some(match body.char_indices().nth(MAX_NOTES_CHARS) {
        Some((cut, _)) => format!("{}\n…", &body[..cut]),
        None => body.to_string(),
    })
}

fn env_flag_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

/// An unstamped local build: every release looks newer than it, so the
/// automatic check and the welcome dialog both sit out.
fn is_dev_build(version: &str) -> bool {
    version == DEV_VERSION
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/// Built once and reused: a per-check `Client` rebuilds the rustls config and
/// throws away the connection pool. `unwrap_or_default` only fires if TLS init
/// fails, in which case the request is going to fail anyway.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CHECK_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
});

async fn fetch_latest_release(current_version: &str) -> Result<GhRelease> {
    let response = HTTP
        .get(RELEASES_LATEST_API)
        // GitHub rejects API requests without a User-Agent.
        .header(
            reqwest::header::USER_AGENT,
            format!("joybug-tauri/{current_version}"),
        )
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::UpdateCheck(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::UpdateCheck(format!(
            "GitHub returned {status} for the latest release"
        )));
    }

    response
        .json::<GhRelease>()
        .await
        .map_err(|e| Error::UpdateCheck(format!("unexpected release payload: {e}")))
}

fn to_update_info(release: GhRelease, current_version: &str) -> UpdateInfo {
    let latest_version = normalize_tag(&release.tag_name).to_string();
    UpdateInfo {
        update_available: is_newer(current_version, &latest_version),
        is_dev_build: is_dev_build(current_version),
        current_version: current_version.to_string(),
        latest_version,
        release_url: release.html_url,
        download_url: arch_suffix()
            .and_then(|arch| match_asset(&release.assets, arch))
            .map(str::to_string),
        published_at: release.published_at,
        notes: truncate_notes(release.body),
    }
}

fn current_version(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Mutator, not a command: callers that already hold an `AppState` stamp it in
/// place instead of paying a second load/save round trip.
fn stamp_check_time(state: &mut AppState) {
    state.last_update_check = Some(chrono::Utc::now().to_rfc3339());
}

/// True when the last check is recent enough that we should not check again.
fn throttled(last_check: Option<&str>) -> bool {
    let Some(last) = last_check else { return false };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(last) else {
        // A corrupt timestamp shouldn't wedge the check off forever.
        return false;
    };
    chrono::Utc::now().signed_duration_since(parsed.with_timezone(&chrono::Utc))
        < chrono::Duration::hours(THROTTLE_HOURS)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Manual check, from the About page. Always hits the network and always
/// reports what it found — including "you're up to date" and dev builds.
#[tauri::command]
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateInfo> {
    let version = current_version(&app_handle);
    let release = fetch_latest_release(&version).await?;
    app_state_store::update(stamp_check_time);
    Ok(to_update_info(release, &version))
}

/// Automatic check, run once at startup. Returns `None` whenever there is
/// nothing worth interrupting the user for — including every case where we
/// decline to make the request at all.
#[tauri::command]
pub async fn startup_update_check(
    app_handle: tauri::AppHandle,
    settings: State<'_, SettingsState>,
) -> Result<Option<UpdateInfo>> {
    if env_flag_set(ENV_NO_UPDATE_CHECK) {
        debug!("{ENV_NO_UPDATE_CHECK} set; skipping startup update check");
        return Ok(None);
    }
    if !settings.lock().unwrap().auto_update_check {
        return Ok(None);
    }

    let version = current_version(&app_handle);
    if is_dev_build(&version) {
        debug!("development build; skipping startup update check");
        return Ok(None);
    }

    let mut state = app_state_store::load();
    if throttled(state.last_update_check.as_deref()) {
        return Ok(None);
    }

    // A failed check is not worth surfacing on startup — the user didn't ask.
    let release = match fetch_latest_release(&version).await {
        Ok(r) => r,
        Err(e) => {
            warn!("Startup update check failed: {e}");
            return Ok(None);
        }
    };
    stamp_check_time(&mut state);
    app_state_store::save(&state);

    let info = to_update_info(release, &version);
    if !info.update_available {
        return Ok(None);
    }
    if state.skipped_update_version.as_deref() == Some(info.latest_version.as_str()) {
        debug!("update {} was skipped by the user", info.latest_version);
        return Ok(None);
    }
    Ok(Some(info))
}

/// "Skip this version" — silences the startup prompt for this release only.
#[tauri::command]
pub fn skip_update_version(version: String) -> Result<()> {
    app_state_store::update(|s| s.skipped_update_version = Some(version));
    Ok(())
}

#[tauri::command]
pub fn get_welcome_state(app_handle: tauri::AppHandle) -> Result<WelcomeState> {
    let version = current_version(&app_handle);
    let seen = app_state_store::load().welcome_seen_version;

    let should_show = !env_flag_set(ENV_NO_WELCOME)
        && !is_dev_build(&version)
        && seen.as_deref() != Some(version.as_str());

    Ok(WelcomeState {
        should_show,
        version,
    })
}

/// Record the welcome dialog as seen for this version. The auto-update checkbox
/// it carries goes through the normal settings command, so `settings.json` keeps
/// exactly one writer.
#[tauri::command]
pub fn dismiss_welcome(app_handle: tauri::AppHandle) -> Result<()> {
    let version = current_version(&app_handle);
    app_state_store::update(|s| s.welcome_seen_version = Some(version));
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
        }
    }

    #[test]
    fn normalize_tag_strips_leading_v() {
        assert_eq!(normalize_tag("v0.2.0"), "0.2.0");
        assert_eq!(normalize_tag("0.2.0"), "0.2.0");
        // Only the leading `v`, and only one of them.
        assert_eq!(normalize_tag("vv1.0.0"), "v1.0.0");
    }

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.0.1", "0.0.2"));
        assert!(is_newer("0.0.1", "v0.0.2"));
        assert!(is_newer("0.9.0", "0.10.0"), "numeric, not lexicographic");
        assert!(!is_newer("0.0.2", "0.0.2"));
        assert!(!is_newer("0.2.0", "0.1.9"));
    }

    #[test]
    fn is_newer_orders_prereleases_below_the_release() {
        assert!(is_newer("0.2.0-rc.1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0-rc.1"));
    }

    #[test]
    fn is_newer_is_false_when_either_side_is_unparsable() {
        // Better to miss a notification than to invent one.
        assert!(!is_newer("0.0.1", "nightly"));
        assert!(!is_newer("not-a-version", "0.0.2"));
    }

    #[test]
    fn dev_build_is_older_than_any_release() {
        // The automatic check gates on DEV_VERSION precisely because of this;
        // the manual check reports it honestly.
        assert!(is_newer(DEV_VERSION, "0.0.1"));
    }

    #[test]
    fn match_asset_picks_the_running_arch() {
        let assets = vec![
            asset("Joybug-UI-x64.exe"),
            asset("Joybug-UI-x64.exe.sha256"),
            asset("Joybug-UI-aarch64.exe"),
            asset("Joybug-UI-aarch64.exe.sha256"),
        ];
        assert_eq!(
            match_asset(&assets, "x64"),
            Some("https://example.test/Joybug-UI-x64.exe")
        );
        assert_eq!(
            match_asset(&assets, "aarch64"),
            Some("https://example.test/Joybug-UI-aarch64.exe")
        );
    }

    #[test]
    fn match_asset_returns_none_when_nothing_fits() {
        let assets = vec![asset("Joybug-UI-x64.exe")];
        assert_eq!(match_asset(&assets, "riscv64"), None);
        assert_eq!(match_asset(&[], "x64"), None);
    }

    #[test]
    fn match_asset_still_works_with_versioned_names() {
        // Older releases (v0.0.1) carry the version in the filename.
        let assets = vec![asset("Joybug-UI-0.0.1-x64.exe")];
        assert_eq!(
            match_asset(&assets, "x64"),
            Some("https://example.test/Joybug-UI-0.0.1-x64.exe")
        );
    }

    #[test]
    fn truncate_notes_drops_empty_and_caps_long_bodies() {
        assert_eq!(truncate_notes(None), None);
        assert_eq!(truncate_notes(Some("   \n ".to_string())), None);
        assert_eq!(truncate_notes(Some(" hi ".to_string())).as_deref(), Some("hi"));

        let long = "x".repeat(MAX_NOTES_CHARS + 100);
        let out = truncate_notes(Some(long)).unwrap();
        assert_eq!(out.chars().count(), MAX_NOTES_CHARS + 2); // + "\n…"
        assert!(out.ends_with("\n…"));
    }

    #[test]
    fn throttled_window() {
        assert!(!throttled(None), "never checked");
        assert!(!throttled(Some("garbage")), "corrupt stamp must not wedge it off");

        let recent = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        assert!(throttled(Some(&recent)));

        let old = (chrono::Utc::now() - chrono::Duration::hours(THROTTLE_HOURS + 1)).to_rfc3339();
        assert!(!throttled(Some(&old)));
    }

    #[test]
    fn update_info_maps_a_release() {
        let release = GhRelease {
            tag_name: "v0.0.2".to_string(),
            html_url: "https://github.com/org62/joybug-tauri/releases/tag/v0.0.2".to_string(),
            body: Some("notes".to_string()),
            published_at: Some("2026-07-25T19:38:50Z".to_string()),
            assets: vec![asset("Joybug-UI-x64.exe")],
        };
        let info = to_update_info(release, "0.0.1");
        assert_eq!(info.latest_version, "0.0.2");
        assert_eq!(info.current_version, "0.0.1");
        assert!(info.update_available);
        assert!(!info.is_dev_build);
        assert_eq!(info.notes.as_deref(), Some("notes"));
    }
}
