use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingSettings {
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub custom_bindings: HashMap<String, String>,
}

fn default_preset() -> String {
    "windbg".to_string()
}

impl Default for KeybindingSettings {
    fn default() -> Self {
        Self {
            preset: default_preset(),
            custom_bindings: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExceptionRule {
    pub code: u32,
    pub first_chance: String,  // "stop" | "pass" | "handled"
    pub second_chance: String, // "stop" | "pass" | "handled"
}

pub fn default_true() -> bool { true }
fn default_lightning_instructions() -> usize { 100 }
fn default_sandbox_memory_mb() -> u32 { 4096 }
fn default_sandbox_etw_preset() -> String { "all".to_string() }

/// "PEB Normalization" — toggles applied on process start that restore PEB
/// fields Windows leaves in their "debugger attached" state, so the target runs
/// like a normally launched process. `enabled` is the parent switch; the child
/// flags pick which individual PEB fields are restored when the parent is on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PebNormalizeSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub being_debugged: bool,
    #[serde(default = "default_true")]
    pub heap_flags: bool,
}

impl Default for PebNormalizeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            being_debugged: true,
            heap_flags: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSettings {
    pub stop_on_thread_create: bool,
    pub stop_on_thread_exit: bool,
    pub stop_on_dll_load: bool,
    pub stop_on_dll_unload: bool,
    pub stop_on_initial_breakpoint: bool,
    pub stop_on_process_create: bool,
    #[serde(default)]
    pub stop_on_process_exit: bool,
    #[serde(default)]
    pub stop_on_debug_output: bool,
    /// Plant a single-shot breakpoint at each loaded user module's entry point (DllMain/OEP).
    #[serde(default)]
    pub break_on_user_module_entry: bool,
    /// Plant a single-shot breakpoint at each loaded system (System32/SysWOW64) module's entry point.
    #[serde(default)]
    pub break_on_system_module_entry: bool,
    /// Plant single-shot breakpoints at each loaded user module's TLS callbacks.
    #[serde(default)]
    pub break_on_user_tls_callbacks: bool,
    /// Plant single-shot breakpoints at each loaded system (System32/SysWOW64) module's TLS callbacks.
    #[serde(default)]
    pub break_on_system_tls_callbacks: bool,
    #[serde(default)]
    pub keybindings: KeybindingSettings,
    #[serde(default)]
    pub exception_rules: Vec<ExceptionRule>,
    /// Symbolize the faulting/referenced addresses and walk the callstack for
    /// *every* exception, not just the ones that pause the UI. Off makes a
    /// non-stopping exception cheap again (the decoded one-liner only, no
    /// `GetCallStack` round-trip) for runs that raise them in a tight loop —
    /// C++ EH throws, guard-page tracing, program single-stepping set to "pass".
    #[serde(default = "default_true")]
    pub capture_exception_context: bool,
    #[serde(default)]
    pub peb_normalize: PebNormalizeSettings,
    /// Number of threads to use for memory scanning. `0` = all CPU cores.
    #[serde(default)]
    pub scan_thread_count: usize,
    /// Symbol path in `_NT_SYMBOL_PATH` syntax. Empty = env var / Microsoft symbol server.
    /// Applies to locally launched sessions, starting with the next session.
    #[serde(default)]
    pub symbol_path: String,
    /// When true, never download symbols; local caches still resolve.
    #[serde(default)]
    pub symbol_offline: bool,
    /// Source path substitutions for the source view: `(from, to)` prefix pairs
    /// applied case-insensitively when a compile-time path from the PDB doesn't
    /// exist on this machine (like WinDbg's srcpath mapping).
    #[serde(default)]
    pub source_map: Vec<(String, String)>,
    /// Ask GitHub Releases for a newer version on startup. Only affects the
    /// automatic check; the About page's manual check always runs.
    #[serde(default = "default_true")]
    pub auto_update_check: bool,
    /// Instructions the always-on "lightning" emulation runs at every pause to
    /// annotate the disassembly with what happens next.
    #[serde(default = "default_lightning_instructions")]
    pub lightning_instructions: usize,

    /// Default guest memory (MB) for new Windows Sandbox sessions.
    #[serde(default = "default_sandbox_memory_mb")]
    pub sandbox_default_memory_mb: u32,
    /// Default "collect ETW trace" toggle for new Windows Sandbox sessions.
    #[serde(default = "default_true")]
    pub sandbox_collect_etw: bool,
    /// Default ETW capture preset for new Windows Sandbox sessions:
    /// "all" | "files" | "registry" | "network".
    #[serde(default = "default_sandbox_etw_preset")]
    pub sandbox_etw_preset: String,
}

impl Default for DebugSettings {
    fn default() -> Self {
        Self {
            stop_on_thread_create: true,
            stop_on_thread_exit: false, // do not pause on thread exit by default
            stop_on_dll_load: true,
            stop_on_dll_unload: true,
            stop_on_initial_breakpoint: true,
            stop_on_process_create: true,
            stop_on_process_exit: false, // do not pause on process exit by default
            stop_on_debug_output: false,
            break_on_user_module_entry: false,
            break_on_system_module_entry: false,
            break_on_user_tls_callbacks: false,
            break_on_system_tls_callbacks: false,
            keybindings: KeybindingSettings::default(),
            exception_rules: Vec::new(),
            capture_exception_context: true,
            peb_normalize: PebNormalizeSettings::default(),
            scan_thread_count: 0, // 0 = all cores
            symbol_path: String::new(),
            symbol_offline: false,
            source_map: Vec::new(),
            auto_update_check: true,
            lightning_instructions: 100,
            sandbox_default_memory_mb: 4096,
            sandbox_collect_etw: true,
            sandbox_etw_preset: "all".to_string(),
        }
    }
}

impl DebugSettings {
    /// Symbol configuration for an embedded server. An empty `symbol_path`
    /// means unset (env var / Microsoft symbol server).
    pub fn symbol_config(&self) -> joybug_core::SymbolConfig {
        joybug_core::SymbolConfig {
            symbol_path: Some(self.symbol_path.trim())
                .filter(|s| !s.is_empty())
                .map(String::from),
            offline: self.symbol_offline,
        }
    }
}

pub type SettingsState = Mutex<DebugSettings>;

fn settings_file_path() -> PathBuf {
    crate::data_dir::joybug_data_dir().join("settings.json")
}

pub fn load_settings_from_disk() -> DebugSettings {
    let path = settings_file_path();
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(settings) = serde_json::from_slice::<DebugSettings>(&bytes) {
            return settings;
        }
    }
    DebugSettings::default()
}

pub fn save_settings_to_disk(settings: &DebugSettings) -> std::io::Result<()> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_vec_pretty(settings).expect("serialize settings");
    let mut file = fs::File::create(path)?;
    file.write_all(&data)?;
    Ok(())
}



#[cfg(test)]
mod tests {
    use super::*;

    /// The E2E helpers (and any settings.json written before the field existed)
    /// post only the `stop_on_*` toggles. Exception-context capture has to come
    /// back on from such a payload, not `false`.
    #[test]
    fn capture_exception_context_defaults_on_when_absent() {
        const PARTIAL: &str = r#"{
            "stop_on_thread_create": false,
            "stop_on_thread_exit": false,
            "stop_on_dll_load": false,
            "stop_on_dll_unload": false,
            "stop_on_initial_breakpoint": true,
            "stop_on_process_create": false,
            "stop_on_process_exit": false
        }"#;
        let settings: DebugSettings = serde_json::from_str(PARTIAL).expect("partial settings deserialize");
        assert!(settings.capture_exception_context);
        assert!(DebugSettings::default().capture_exception_context);

        let explicit = PARTIAL.replacen("{", "{ \"capture_exception_context\": false,", 1);
        let off: DebugSettings = serde_json::from_str(&explicit).expect("explicit off deserializes");
        assert!(!off.capture_exception_context);
    }
}
