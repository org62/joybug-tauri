use tauri::AppHandle;
use tracing::{debug, error, info};

use super::runner::emit_session_event;
use super::types::DebugSession;

/// Processes a set register request: modifies one register in the thread context, writes it back,
/// then re-reads and broadcasts the updated state.
pub(crate) fn process_set_register(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    register_name: &str,
    value: u64,
) {
    let pid = event.pid();
    let tid = event.tid();
    debug!("📤 Processing set register request: pid={}, tid={}, register={}, value=0x{:X}", pid, tid, register_name, value);

    // 1. Get current raw thread context
    let mut ctx = match session.get_thread_context(pid, tid) {
        Ok(joybug_core::protocol::ThreadContext::Win32RawContext(c)) => c,
        Err(e) => {
            error!("Failed to get thread context for set register: {}", e);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::toast_error(handle, &format!("Failed to get thread context: {}", e));
            }
            return;
        }
    };

    // 2. Match register name and set value
    #[cfg(target_arch = "x86_64")]
    {
        match register_name {
            "rax" => ctx.Rax = value,
            "rbx" => ctx.Rbx = value,
            "rcx" => ctx.Rcx = value,
            "rdx" => ctx.Rdx = value,
            "rsi" => ctx.Rsi = value,
            "rdi" => ctx.Rdi = value,
            "rbp" => ctx.Rbp = value,
            "rsp" => ctx.Rsp = value,
            "rip" => ctx.Rip = value,
            "r8" => ctx.R8 = value,
            "r9" => ctx.R9 = value,
            "r10" => ctx.R10 = value,
            "r11" => ctx.R11 = value,
            "r12" => ctx.R12 = value,
            "r13" => ctx.R13 = value,
            "r14" => ctx.R14 = value,
            "r15" => ctx.R15 = value,
            "eflags" => ctx.EFlags = value as u32,
            _ => {
                error!("Unknown x64 register: {}", register_name);
                if let Some(ref handle) = app_handle_clone {
                    crate::ui_logger::toast_error(handle, &format!("Unknown register: {}", register_name));
                }
                return;
            }
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        unsafe {
            match register_name {
                "x0" => ctx.Anonymous.X[0] = value,
                "x1" => ctx.Anonymous.X[1] = value,
                "x2" => ctx.Anonymous.X[2] = value,
                "x3" => ctx.Anonymous.X[3] = value,
                "x4" => ctx.Anonymous.X[4] = value,
                "x5" => ctx.Anonymous.X[5] = value,
                "x6" => ctx.Anonymous.X[6] = value,
                "x7" => ctx.Anonymous.X[7] = value,
                "x8" => ctx.Anonymous.X[8] = value,
                "x9" => ctx.Anonymous.X[9] = value,
                "x10" => ctx.Anonymous.X[10] = value,
                "x11" => ctx.Anonymous.X[11] = value,
                "x12" => ctx.Anonymous.X[12] = value,
                "x13" => ctx.Anonymous.X[13] = value,
                "x14" => ctx.Anonymous.X[14] = value,
                "x15" => ctx.Anonymous.X[15] = value,
                "x16" => ctx.Anonymous.X[16] = value,
                "x17" => ctx.Anonymous.X[17] = value,
                "x18" => ctx.Anonymous.X[18] = value,
                "x19" => ctx.Anonymous.X[19] = value,
                "x20" => ctx.Anonymous.X[20] = value,
                "x21" => ctx.Anonymous.X[21] = value,
                "x22" => ctx.Anonymous.X[22] = value,
                "x23" => ctx.Anonymous.X[23] = value,
                "x24" => ctx.Anonymous.X[24] = value,
                "x25" => ctx.Anonymous.X[25] = value,
                "x26" => ctx.Anonymous.X[26] = value,
                "x27" => ctx.Anonymous.X[27] = value,
                "x28" => ctx.Anonymous.X[28] = value,
                "x29" => ctx.Anonymous.Anonymous.Fp = value,
                "x30" => ctx.Anonymous.Anonymous.Lr = value,
                "sp" => ctx.Sp = value,
                "pc" => ctx.Pc = value,
                "cpsr" => ctx.Cpsr = value as u32,
                _ => {
                    error!("Unknown ARM64 register: {}", register_name);
                    if let Some(ref handle) = app_handle_clone {
                        crate::ui_logger::toast_error(handle, &format!("Unknown register: {}", register_name));
                    }
                    return;
                }
            }
        }
    }

    // 3. Write modified context back
    let write_ctx = joybug_core::protocol::ThreadContext::Win32RawContext(ctx);
    if let Err(e) = session.set_thread_context(pid, tid, write_ctx) {
        error!("Failed to set thread context: {}", e);
        if let Some(ref handle) = app_handle_clone {
            crate::ui_logger::toast_error(handle, &format!("Failed to set register: {}", e));
        }
        return;
    }

    // 4. Re-read context and update state
    match session.get_thread_context(pid, tid) {
        Ok(fresh_ctx) => {
            let mut state = session.state.lock().unwrap();
            state.current_context = Some(crate::events::convert_raw_context_to_serializable(fresh_ctx));
        }
        Err(e) => {
            error!("Failed to re-read thread context after set: {}", e);
        }
    }

    // 5. Emit session-updated to refresh the entire UI
    if let Some(ref handle) = app_handle_clone {
        emit_session_event(&session.state, handle);
    }

    info!("Successfully set register {} = 0x{:X}", register_name, value);
}
