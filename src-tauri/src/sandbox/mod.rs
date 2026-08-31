//! Windows Sandbox run mode — the app-side shell around the reusable mechanism
//! in `joybug_core::sandbox`.
//!
//! Core owns the provisioning mechanism (boot the VM, share folders, start the
//! in-guest server, run the ETW tracer). This module keeps only the concerns
//! that are the app's: staging the embedded guest binaries (`payload`), the
//! on-disk data-directory layout, mapping the app's serde settings onto core's
//! [`ProvisionConfig`], and tearing down against the app's handle map.

pub mod availability;
pub mod payload;

use std::path::PathBuf;

use tracing::info;

use crate::state::SandboxSettings;
use joybug_core::sandbox::{EtwCaptureSpec, MountSpec, ProvisionConfig};

// Re-export the core surface the rest of the app references through
// `crate::sandbox::*`, so nothing else depends on the winsandbox crate or
// `joybug_core::sandbox` paths directly.
pub use joybug_core::sandbox::{exec_blocking, start_tracer, RunAs, SandboxHandle};

/// Port the in-guest server listens on. The guest IP disambiguates it host-side,
/// so a fixed port is fine.
const GUEST_SERVER_PORT: u16 = 9000;

/// Provision a sandbox for `session_id` and return a handle whose `server_url`
/// points at the in-guest server. Stages the embedded guest binaries, resolves
/// the app's per-session data-dir paths, maps the app settings onto core's
/// [`ProvisionConfig`], and delegates to [`joybug_core::sandbox::provision`].
pub fn provision(
    session_id: &str,
    settings: &SandboxSettings,
    launch_command: &str,
    working_directory: Option<&str>,
    symbol_cfg: &joybug_core::SymbolConfig,
) -> Result<SandboxHandle, String> {
    let guest_bin_dir = payload::stage().map_err(|e| format!("stage the guest binary: {e}"))?;
    // Persistent symbol cache shared across sandbox runs (guests are ephemeral,
    // so without this every run re-downloads ntdll/kernel32 PDBs).
    let symbols_dir = crate::data_dir::joybug_data_dir().join("symbols");

    let cfg = ProvisionConfig {
        guest_bin_dir,
        guest_exe: payload::GUEST_EXE.to_string(),
        io_dir: session_io_dir(session_id),
        symbols_dir,
        etw_out_file: etw_out_file_name(session_id),
        server_port: GUEST_SERVER_PORT,
        mounts: settings
            .mounts
            .iter()
            .map(|m| MountSpec { host_path: m.host_path.clone(), read_only: m.read_only })
            .collect(),
        memory_mb: settings.memory_mb,
        debug: settings.debug,
        collect_etw: settings.collect_etw,
        etw: EtwCaptureSpec {
            ops: settings.etw.capture.ops.clone(),
            callstacks: settings.etw.callstacks,
        },
        symbol_offline: symbol_cfg.offline,
        launch_command: launch_command.to_string(),
        working_directory: working_directory.map(str::to_string),
    };
    joybug_core::sandbox::provision(&cfg)
}

/// Host side of a session's writable `C:\io` share (`<data>/sandbox/<sid>/io`).
/// Single owner of the on-disk layout — `provision` stages into it and
/// `commands::etw_trace` polls it after the session ends. Does not create it.
pub fn session_io_dir(session_id: &str) -> PathBuf {
    crate::data_dir::joybug_data_dir()
        .join("sandbox")
        .join(session_id)
        .join("io")
}

/// Basename of the per-session ETW JSONL the guest tracer writes into the io dir.
pub fn etw_out_file_name(session_id: &str) -> String {
    format!("events-{session_id}.jsonl")
}

/// Full host path of a sandbox session's ETW JSONL.
pub fn io_events_path(session_id: &str) -> PathBuf {
    session_io_dir(session_id).join(etw_out_file_name(session_id))
}

/// Remove and stop the sandbox VM backing `session_id`, if any. Binds the handle
/// out of the map lock before dropping so a slow `wsb stop` never holds the
/// mutex; the drop itself BLOCKS on `wsb stop` — call from a background thread
/// when the caller must stay responsive. Returns whether a sandbox was found.
pub fn teardown(handles: &crate::state::SandboxHandlesMap, session_id: &str) -> bool {
    let handle = handles.lock().unwrap().remove(session_id);
    match handle {
        Some(handle) => {
            info!("stopping Windows Sandbox for session {}", session_id);
            drop(handle); // RunningSandbox::Drop runs `wsb stop`
            true
        }
        None => false,
    }
}
