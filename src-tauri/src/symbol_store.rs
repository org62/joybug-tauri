use crate::state::SymbolOverrideInfo;
use std::collections::HashMap;

const SYMBOL_OVERRIDES_FILE: &str = "symbol_overrides.json";

/// Manually-loaded PDBs for a target, keyed by `launch_command` (like
/// breakpoints/patches/bookmarks). Entries carry no address — they key on module
/// short name — so they load verbatim.
pub fn load_symbol_overrides(launch_command: &str) -> Vec<SymbolOverrideInfo> {
    let map: HashMap<String, Vec<SymbolOverrideInfo>> = crate::data_dir::load_json(SYMBOL_OVERRIDES_FILE);
    map.get(launch_command).cloned().unwrap_or_default()
}

pub fn save_symbol_overrides(launch_command: &str, overrides: &[SymbolOverrideInfo]) {
    // Read existing file to preserve other targets' overrides.
    let mut map: HashMap<String, Vec<SymbolOverrideInfo>> = crate::data_dir::load_json(SYMBOL_OVERRIDES_FILE);

    if overrides.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), overrides.to_vec());
    }

    crate::data_dir::save_json(SYMBOL_OVERRIDES_FILE, &map);
}
