// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Role first: this same exe is also the debug server, the ETW collector and
    // the desktop probe that run inside a Windows Sandbox, where there is no
    // WebView2 and no desktop for a window. Nothing Tauri-related may run
    // before this decision. The role contract (which flags pick what) is
    // core's `guest_roles`, the same one `sandbox::provision` builds command
    // lines against; it is a raw argv scan, so the GUI's own arguments (Tauri,
    // WebView2, "open with") fall through untouched.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(role) = joybug_core::guest_roles::from_argv(&argv) {
        joybug_core::guest_roles::run(role, argv);
    }
    joybug_tauri_lib::run()
}
