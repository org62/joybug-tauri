//! Small on-disk record of things the app has already done for this user —
//! which version's welcome dialog they dismissed, which update they skipped,
//! when the last update check ran.
//!
//! Deliberately *not* part of `DebugSettings`: none of it is a preference the
//! user configures, and the e2e fixture resets settings between tests, which
//! would wipe it. Lives in the data dir, so `JOYBUG_DATA_DIR` isolates it for
//! free.

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "app_state.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppState {
    /// Version whose welcome dialog was dismissed. Re-shows on every upgrade.
    #[serde(default)]
    pub welcome_seen_version: Option<String>,
    /// "Skip this version" — suppresses the startup nag for exactly this
    /// version, so a later release re-arms it.
    #[serde(default)]
    pub skipped_update_version: Option<String>,
    /// RFC3339 timestamp of the last update check, used to throttle the
    /// automatic one. `None` means "never checked".
    #[serde(default)]
    pub last_update_check: Option<String>,
}

pub fn load() -> AppState {
    crate::data_dir::load_json(FILE_NAME)
}

pub fn save(state: &AppState) {
    crate::data_dir::save_json(FILE_NAME, state);
}

/// Read-modify-write helper: every caller mutates one field and persists.
pub fn update(f: impl FnOnce(&mut AppState)) {
    let mut state = load();
    f(&mut state);
    save(&state);
}
