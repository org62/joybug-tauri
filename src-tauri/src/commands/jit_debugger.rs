//! Tauri commands for the Windows JIT (AeDebug) debugger toggle and the
//! startup hand-off. All the machinery lives in `crate::jit`; only the IPC
//! surface belongs here.

use crate::error::Result;
use crate::jit::{self, JitDebuggerStatus, StartupAttach, StartupAttachState};
use tauri::State;

/// Read AeDebug. Registry reads need no elevation.
#[tauri::command]
pub async fn get_jit_debugger_status() -> Result<JitDebuggerStatus> {
    super::run_blocking(jit::status).await
}

/// Register (UAC prompt) or restore the previous debugger (UAC prompt). Blocks
/// until the elevated helper exits.
#[tauri::command]
pub async fn set_jit_debugger(enable: bool) -> Result<()> {
    let flag = if enable { jit::REGISTER_FLAG } else { jit::UNREGISTER_FLAG };
    super::run_blocking(move || jit::run_elevated(flag)).await
}

/// The `-p <pid> -e <handle>` a JIT launch carried, handed out once: a UI
/// reload must not attach a second time.
#[tauri::command]
pub fn get_startup_attach(state: State<'_, StartupAttachState>) -> Option<StartupAttach> {
    state.0.lock().unwrap().take()
}
