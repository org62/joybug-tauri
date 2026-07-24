use crate::state::BreakpointInfo;
use std::collections::HashMap;

const BREAKPOINTS_FILE: &str = "breakpoints.json";

pub fn load_breakpoints(launch_command: &str) -> Vec<BreakpointInfo> {
    let map: HashMap<String, Vec<BreakpointInfo>> = crate::data_dir::load_json(BREAKPOINTS_FILE);
    match map.get(launch_command) {
        Some(bps) => bps
            .iter()
            .map(|bp| BreakpointInfo {
                id: uuid::Uuid::new_v4().to_string(),
                address: 0,
                module_name: bp.module_name.clone(),
                module_offset: bp.module_offset,
                name: bp.name.clone(),
                group: bp.group.clone(),
                symbol: bp.symbol.clone(),
                // A persisted access trace reloads inert (disabled) — its collected
                // results are session-live only, so re-arming (which starts a fresh
                // trace on module load) is an explicit user action.
                enabled: bp.enabled && bp.bp_kind != "watchpoint",
                is_active: false,
                bp_kind: bp.bp_kind.clone(),
                hw_type: bp.hw_type.clone(),
                hw_size: bp.hw_size,
                // Same binary → module+RVA is stable, so the persisted file:line
                // stays valid until re-resolved on module load.
                source_file: bp.source_file.clone(),
                source_line: bp.source_line,
                auto: false,
                single_shot: false,
            })
            .collect(),
        None => Vec::new(),
    }
}

pub fn save_breakpoints(launch_command: &str, breakpoints: &[BreakpointInfo]) {
    // Read existing file to preserve other targets' breakpoints
    let mut map: HashMap<String, Vec<BreakpointInfo>> = crate::data_dir::load_json(BREAKPOINTS_FILE);

    // Auto-planted rows (module entry / TLS callbacks) are regenerated from settings
    // on each run, and single-shot rows are session-only — never persist either.
    let persistable: Vec<BreakpointInfo> = breakpoints.iter().filter(|b| !b.auto && !b.single_shot).cloned().collect();

    if persistable.is_empty() {
        map.remove(launch_command);
    } else {
        map.insert(launch_command.to_string(), persistable);
    }

    crate::data_dir::save_json(BREAKPOINTS_FILE, &map);
}
