//! Host platform description for the frontend.
//!
//! The UI is one bundle for every OS; what differs is which run modes and
//! panels the backend can actually serve. Rather than sprinkling `navigator`
//! sniffing through React, the backend states its capabilities once and the
//! frontend's `usePlatform()` gates on them. Everything here is a compile-time
//! fact (`cfg!`), so the command is pure and cheap.

use serde::Serialize;

/// Features that only exist on one platform and whose UI is hidden elsewhere.
#[derive(Debug, Clone, Serialize)]
pub struct PlatformFeatures {
    /// Windows Sandbox run mode (the mode tab, its settings section).
    pub sandbox: bool,
    /// ETW capture (the ETW-only mode, the host-ETW fold, the ETW Events tab).
    pub etw: bool,
    /// Registering as the Windows JIT / postmortem debugger.
    pub jit: bool,
    /// The Handles tab: NT objects on Windows, file descriptors on Linux.
    pub handles: bool,
    /// Dump writing from the session menu: a minidump on Windows, an ELF
    /// core file on Linux.
    pub minidump: bool,
    /// PEB normalization (anti-anti-debug) settings.
    pub peb_normalize: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
    /// `"windows"`, `"linux"`, or whatever `std::env::consts::OS` says.
    pub os: &'static str,
    pub features: PlatformFeatures,
    /// Prefilled launch command for a new session.
    pub default_launch_command: &'static str,
    /// Extensions for the "Executables" file-dialog filter; empty means
    /// executables are not identified by extension (Unix).
    pub exe_extensions: Vec<&'static str>,
}

pub fn platform_info() -> PlatformInfo {
    let windows = cfg!(windows);
    let linux = cfg!(target_os = "linux");
    PlatformInfo {
        os: std::env::consts::OS,
        features: PlatformFeatures {
            sandbox: windows,
            etw: windows,
            jit: windows,
            handles: windows || linux,
            minidump: windows || linux,
            peb_normalize: windows,
        },
        default_launch_command: if windows {
            "cmd.exe /c echo Hello World!"
        } else {
            "/bin/sh -c 'echo Hello World!'"
        },
        exe_extensions: if windows { vec!["exe", "com", "bat", "cmd"] } else { Vec::new() },
    }
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    platform_info()
}
