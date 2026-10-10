use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tracing::error;

/// Resolve the application data directory.
///
/// Checks `JOYBUG_DATA_DIR` first (used by e2e tests for isolation),
/// then falls back to platform-specific defaults:
/// - Windows: `%LOCALAPPDATA%\JoybugTauri` or `%APPDATA%\JoybugTauri`
/// - Unix: `$XDG_CONFIG_HOME/joybug-tauri` or `~/.config/joybug-tauri`
/// - Fallback: current working directory
pub fn joybug_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("JOYBUG_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "windows") {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(base).join("JoybugTauri");
        }
        if let Ok(base) = std::env::var("APPDATA") {
            return PathBuf::from(base).join("JoybugTauri");
        }
    }
    if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(base).join("joybug-tauri");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("joybug-tauri");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Keep the `keep` newest `*.ext` files in `dir` (by modification time) and
/// remove the rest. Missing directory: nothing to do.
pub fn prune_oldest(dir: &Path, ext: &str, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == ext))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// `bytes` as lowercase hex, two digits per byte.
pub fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read and parse a JSON file under the data dir. Returns `T::default()` when the
/// file is missing; logs and returns `T::default()` when it fails to parse.
pub fn load_json<T: DeserializeOwned + Default>(file_name: &str) -> T {
    let path = joybug_data_dir().join(file_name);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return T::default(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            error!("Failed to parse {}: {}", file_name, e);
            T::default()
        }
    }
}

/// Serialize `value` as pretty JSON under the data dir, creating the directory
/// when needed. Failures are logged (persistence is best-effort).
pub fn save_json<T: Serialize + ?Sized>(file_name: &str, value: &T) {
    let path = joybug_data_dir().join(file_name);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match serde_json::to_vec_pretty(value) {
        Ok(data) => {
            if let Err(e) = fs::File::create(&path).and_then(|mut f| f.write_all(&data)) {
                error!("Failed to save {}: {}", file_name, e);
            }
        }
        Err(e) => error!("Failed to serialize {}: {}", file_name, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_pads_every_byte() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn prune_keeps_the_newest_files_of_the_extension() {
        let dir = crate::test_util::TempDir::new("joybug-prune-test");
        for (i, name) in ["a.idx", "b.idx", "c.idx", "keep.txt"].iter().enumerate() {
            let path = dir.file(name, b"x");
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + i as u64);
            fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(t).unwrap();
        }
        prune_oldest(&dir.0, "idx", 2);
        let mut left: Vec<String> = fs::read_dir(&dir.0).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["b.idx", "c.idx", "keep.txt"]);
    }
}
