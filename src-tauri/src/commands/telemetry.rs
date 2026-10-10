use crate::error::{Error, Result};
use crate::telemetry::anonymize::UiRecord;
use crate::telemetry::TelemetryStatus;

/// Measurements from the frontend (see `src/lib/perf.ts`). Dropped unless
/// telemetry is on.
#[tauri::command]
pub fn telemetry_record(records: Vec<UiRecord>) {
    crate::telemetry::record_ui(records);
}

#[tauri::command]
pub fn telemetry_status() -> TelemetryStatus {
    crate::telemetry::status()
}

/// Show the folder the local recordings are written to.
#[tauri::command]
pub fn telemetry_open_folder() -> Result<()> {
    let folder = crate::telemetry::folder();
    std::fs::create_dir_all(&folder)
        .map_err(|e| Error::InvalidParameter(format!("Cannot create {}: {}", folder.display(), e)))?;
    tauri_plugin_opener::open_path(&folder, None::<&str>)
        .map_err(|e| Error::InvalidParameter(format!("Cannot open {}: {}", folder.display(), e)))
}
