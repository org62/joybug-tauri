use crate::state::BookmarkInfo;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tracing::error;

fn bookmarks_file_path() -> PathBuf {
    crate::data_dir::joybug_data_dir().join("bookmarks.json")
}

pub fn load_bookmarks(launch_command: &str) -> Vec<BookmarkInfo> {
    let path = bookmarks_file_path();
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let map: HashMap<String, Vec<BookmarkInfo>> = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            error!("Failed to parse bookmarks file: {}", e);
            return Vec::new();
        }
    };
    match map.get(launch_command) {
        Some(bms) => bms
            .iter()
            .map(|bm| BookmarkInfo {
                // Regenerate the runtime id and drop any persisted freeze handle;
                // everything else carries over from disk.
                id: uuid::Uuid::new_v4().to_string(),
                freeze_id: None,
                ..bm.clone()
            })
            .collect(),
        None => Vec::new(),
    }
}

pub fn save_bookmarks(launch_command: &str, bookmarks: &[BookmarkInfo]) {
    let path = bookmarks_file_path();

    // Read existing file to preserve other targets' bookmarks
    let mut map: HashMap<String, Vec<BookmarkInfo>> = if let Ok(bytes) = fs::read(&path) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if bookmarks.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), bookmarks.to_vec());
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match serde_json::to_vec_pretty(&map) {
        Ok(data) => {
            if let Err(e) = fs::File::create(&path).and_then(|mut f| f.write_all(&data)) {
                error!("Failed to save bookmarks: {}", e);
            }
        }
        Err(e) => {
            error!("Failed to serialize bookmarks: {}", e);
        }
    }
}
