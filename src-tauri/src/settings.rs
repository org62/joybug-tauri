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

fn default_true() -> bool { true }

/// "Debugger Hiding" — anti-anti-debug toggles applied on process start.
/// `hide_from_peb` is the parent switch; the five child flags pick which
/// individual PEB techniques run when the parent is enabled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebuggerHidingSettings {
    #[serde(default)]
    pub hide_from_peb: bool,
    #[serde(default = "default_true")]
    pub being_debugged: bool,
    #[serde(default = "default_true")]
    pub heap_flags: bool,
    #[serde(default = "default_true")]
    pub nt_global_flag: bool,
    #[serde(default = "default_true")]
    pub startup_info: bool,
    #[serde(default = "default_true")]
    pub os_build_number: bool,
}

impl Default for DebuggerHidingSettings {
    fn default() -> Self {
        Self {
            hide_from_peb: false,
            being_debugged: true,
            heap_flags: true,
            nt_global_flag: true,
            startup_info: true,
            os_build_number: true,
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
    #[serde(default)]
    pub debugger_hiding: DebuggerHidingSettings,
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
            debugger_hiding: DebuggerHidingSettings::default(),
            scan_thread_count: 0, // 0 = all cores
            symbol_path: String::new(),
            symbol_offline: false,
            source_map: Vec::new(),
            auto_update_check: true,
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


