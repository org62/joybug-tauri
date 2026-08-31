// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Role first: this same exe is also the debug server and the ETW collector
    // that run inside a Windows Sandbox, where there is no WebView2 and no
    // desktop for a window. Nothing Tauri-related may run before this decision.
    if let Some(mode) = joybug_tauri_lib::guest_mode::from_args() {
        joybug_tauri_lib::guest_mode::run(mode);
    }
    joybug_tauri_lib::run()
}
