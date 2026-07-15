use crate::state::BookmarkInfo;
use std::collections::HashMap;

const BOOKMARKS_FILE: &str = "bookmarks.json";

pub fn load_bookmarks(launch_command: &str) -> Vec<BookmarkInfo> {
    let map: HashMap<String, Vec<BookmarkInfo>> = crate::data_dir::load_json(BOOKMARKS_FILE);
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
    // Read existing file to preserve other targets' bookmarks
    let mut map: HashMap<String, Vec<BookmarkInfo>> = crate::data_dir::load_json(BOOKMARKS_FILE);

    if bookmarks.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), bookmarks.to_vec());
    }

    crate::data_dir::save_json(BOOKMARKS_FILE, &map);
}
