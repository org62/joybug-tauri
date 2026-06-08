use crate::state::PatchInfo;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tracing::error;

fn patches_file_path() -> PathBuf {
    crate::data_dir::joybug_data_dir().join("patches.json")
}

pub fn load_patches(launch_command: &str) -> Vec<PatchInfo> {
    let path = patches_file_path();
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let map: HashMap<String, Vec<PatchInfo>> = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            error!("Failed to parse patches file: {}", e);
            return Vec::new();
        }
    };
    match map.get(launch_command) {
        Some(patches) => patches
            .iter()
            .map(|p| PatchInfo {
                id: uuid::Uuid::new_v4().to_string(),
                address: 0,
                module_name: p.module_name.clone(),
                module_offset: p.module_offset,
                original_bytes: p.original_bytes.clone(),
                patched_bytes: p.patched_bytes.clone(),
                assembly_text: p.assembly_text.clone(),
                original_disassembly: p.original_disassembly.clone(),
                enabled: p.enabled,
                is_applied: false,
                group: p.group.clone(),
            })
            .collect(),
        None => Vec::new(),
    }
}

pub fn save_patches(launch_command: &str, patches: &[PatchInfo]) {
    let path = patches_file_path();

    let mut map: HashMap<String, Vec<PatchInfo>> = if let Ok(bytes) = fs::read(&path) {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if patches.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), patches.to_vec());
    }

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match serde_json::to_vec_pretty(&map) {
        Ok(data) => {
            if let Err(e) = fs::File::create(&path).and_then(|mut f| f.write_all(&data)) {
                error!("Failed to save patches: {}", e);
            }
        }
        Err(e) => {
            error!("Failed to serialize patches: {}", e);
        }
    }
}
