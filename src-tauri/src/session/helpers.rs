use crate::state::{SessionStateUI, SessionStatusUI};
use tauri::{AppHandle, Emitter};
use tracing::info;

use super::types::{DebugSession, ScanError};

/// Emits a `ScanError` payload on the given scan-domain error event
/// (e.g. "scan-memory-error", "pointer-scan-error", "string-scan-error").
pub(crate) fn emit_scan_error(
    handle: &AppHandle,
    event: &str,
    session_id: String,
    error: impl std::fmt::Display,
) {
    let err = ScanError { session_id, error: error.to_string() };
    let _ = handle.emit(event, &err);
}

/// Format bytes into human readable format (KB, MB, GB)
pub(crate) fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Resolve which live PID a stored attach/open target maps to. Prefers the
/// stored PID when it's still alive. Otherwise (the target was restarted and
/// got a new PID) falls back to matching by image name: exactly one match
/// resolves automatically; zero or several matches are an error the caller
/// surfaces (for several, the UI offers a picker).
pub(crate) fn match_target_pid(
    processes: &[joybug2::protocol::ProcessInfo],
    stored_pid: u32,
    target_name: &str,
) -> std::result::Result<u32, String> {
    if processes.iter().any(|p| p.pid == stored_pid) {
        return Ok(stored_pid);
    }

    let want = target_name.to_lowercase();
    let matches: Vec<u32> = processes
        .iter()
        .filter(|p| p.name.to_lowercase() == want)
        .map(|p| p.pid)
        .collect();

    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(format!("Process '{}' is not running", target_name)),
        n => Err(format!(
            "{} processes named '{}' are running; pick one",
            n, target_name
        )),
    }
}

/// Extracts the filename (without extension) from a module path
pub(crate) fn extract_module_name(module_path: &str) -> String {
    std::path::Path::new(module_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(module_path)
        .to_string()
}

/// Clones the current module list from the shared session state.
pub(crate) fn get_modules_snapshot(session: &DebugSession) -> Vec<joybug2::protocol_io::ModuleInfo> {
    session.state.lock().unwrap().modules.clone()
}

/// Finds the module containing the given address, returns (short_name, offset_from_base)
pub(crate) fn find_module_for_address(modules: &[joybug2::protocol_io::ModuleInfo], address: u64) -> Option<(String, u64)> {
    for module in modules {
        if let Some(size) = module.size {
            if address >= module.base && address < module.base + size {
                return Some((extract_module_name(&module.name), address - module.base));
            }
        }
    }
    None
}

/// Formats a symbol as "module!name+0xoffset"
pub(crate) fn format_symbol(module: &str, name: &str, offset: u64) -> String {
    format!("{}!{}+0x{:x}", module, name, offset)
}

/// Extracts just the filename from a full module path (e.g. "C:\Windows\ntdll.dll" -> "ntdll.dll").
pub(crate) fn module_short_name(full_path: &str) -> String {
    std::path::Path::new(full_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| full_path.to_string())
}

/// Reports a step error to the UI logger and toast.
pub(crate) fn report_step_error(
    session: &DebugSession,
    app_handle_clone: &Option<AppHandle>,
    msg: &str,
) {
    if let Some(ref handle) = app_handle_clone {
        let session_id = {
            let state = session.state.lock().unwrap();
            state.id.clone()
        };
        crate::ui_logger::log_error(handle, msg, Some(session_id));
        crate::ui_logger::toast_error(handle, msg);
    }
}

/// Updates session state (modules and threads) based on debug events
pub(crate) fn update_session_from_event(state: &mut SessionStateUI, event: &joybug2::protocol_io::DebugEvent) {
    match event {
        joybug2::protocol_io::DebugEvent::DllLoaded { dll_name, base_of_dll, size_of_dll, .. } => {
            let module_name = dll_name.clone().unwrap_or_else(|| format!("Unknown_0x{:X}", base_of_dll));
            let module = joybug2::protocol_io::ModuleInfo {
                name: module_name.clone(),
                base: *base_of_dll,
                size: *size_of_dll,
            };
            if !state.modules.iter().any(|m| m.base == *base_of_dll) {
                state.modules.push(module);
                info!("Added module: {} at 0x{:X}", module_name, base_of_dll);
            }
        }
        joybug2::protocol_io::DebugEvent::ThreadCreated { tid, start_address, .. } => {
            let thread = joybug2::protocol_io::ThreadInfo {
                tid: *tid,
                start_address: *start_address,
            };
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added thread: {} at 0x{:X}", tid, start_address);
            }
        }
        joybug2::protocol_io::DebugEvent::ProcessCreated { pid, tid, image_file_name, base_of_image, size_of_image, .. } => {
            let module_name = image_file_name.clone().unwrap_or_else(|| "main.exe".to_string());
            let module = joybug2::protocol_io::ModuleInfo {
                name: module_name.clone(),
                base: *base_of_image,
                size: *size_of_image,
            };
            if !state.modules.iter().any(|m| m.base == *base_of_image) {
                state.modules.push(module);
                info!("Added main executable module: {} at 0x{:X}", module_name, base_of_image);
            }

            let thread = joybug2::protocol_io::ThreadInfo {
                tid: *tid,
                start_address: *base_of_image,
            };
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added initial thread: {} for process {} at 0x{:X}", tid, pid, base_of_image);
            }
        }
        joybug2::protocol_io::DebugEvent::ThreadExited { tid, .. } => {
            state.threads.retain(|t| t.tid != *tid);
            info!("Removed thread: {}", tid);
        }
        joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } => {
            state.modules.retain(|m| m.base != *base_of_dll);
            info!("Removed module at 0x{:X}", base_of_dll);
        }
        joybug2::protocol_io::DebugEvent::ProcessExited { .. } => {
            state.modules.clear();
            state.threads.clear();
            state.status = SessionStatusUI::Stopped;
            info!("Process exited, session stopped.");
        }
        _ => {}
    }
}
