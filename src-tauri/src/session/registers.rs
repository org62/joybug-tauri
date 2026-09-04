use tauri::AppHandle;
use tracing::{debug, error, info};

use super::runner::emit_session_event;
use super::types::DebugSession;

/// Writes `value` into the register named `name` of a raw thread context.
/// Returns `false` when the name is not a register of that register file.
/// Dispatch is per register file (a WOW64 thread on any host is x86), not
/// per host architecture.
fn write_register(ctx: &mut joybug_core::protocol::ThreadContext, name: &str, value: u64) -> bool {
    match ctx {
        joybug_core::protocol::ThreadContext::Wow64RawContext(c) => {
            let v32 = value as u32;
            match name {
                "eax" => c.Eax = v32,
                "ebx" => c.Ebx = v32,
                "ecx" => c.Ecx = v32,
                "edx" => c.Edx = v32,
                "esi" => c.Esi = v32,
                "edi" => c.Edi = v32,
                "ebp" => c.Ebp = v32,
                "esp" => c.Esp = v32,
                "eip" => c.Eip = v32,
                "eflags" => c.EFlags = v32,
                _ => return false,
            }
        }
        #[cfg(target_arch = "x86_64")]
        joybug_core::protocol::ThreadContext::Win32RawContext(c) => match name {
            "rax" => c.Rax = value,
            "rbx" => c.Rbx = value,
            "rcx" => c.Rcx = value,
            "rdx" => c.Rdx = value,
            "rsi" => c.Rsi = value,
            "rdi" => c.Rdi = value,
            "rbp" => c.Rbp = value,
            "rsp" => c.Rsp = value,
            "rip" => c.Rip = value,
            "r8" => c.R8 = value,
            "r9" => c.R9 = value,
            "r10" => c.R10 = value,
            "r11" => c.R11 = value,
            "r12" => c.R12 = value,
            "r13" => c.R13 = value,
            "r14" => c.R14 = value,
            "r15" => c.R15 = value,
            "eflags" => c.EFlags = value as u32,
            _ => return false,
        },
        #[cfg(target_arch = "aarch64")]
        joybug_core::protocol::ThreadContext::Win32RawContext(c) => unsafe {
            match name {
                "x0" => c.Anonymous.X[0] = value,
                "x1" => c.Anonymous.X[1] = value,
                "x2" => c.Anonymous.X[2] = value,
                "x3" => c.Anonymous.X[3] = value,
                "x4" => c.Anonymous.X[4] = value,
                "x5" => c.Anonymous.X[5] = value,
                "x6" => c.Anonymous.X[6] = value,
                "x7" => c.Anonymous.X[7] = value,
                "x8" => c.Anonymous.X[8] = value,
                "x9" => c.Anonymous.X[9] = value,
                "x10" => c.Anonymous.X[10] = value,
                "x11" => c.Anonymous.X[11] = value,
                "x12" => c.Anonymous.X[12] = value,
                "x13" => c.Anonymous.X[13] = value,
                "x14" => c.Anonymous.X[14] = value,
                "x15" => c.Anonymous.X[15] = value,
                "x16" => c.Anonymous.X[16] = value,
                "x17" => c.Anonymous.X[17] = value,
                "x18" => c.Anonymous.X[18] = value,
                "x19" => c.Anonymous.X[19] = value,
                "x20" => c.Anonymous.X[20] = value,
                "x21" => c.Anonymous.X[21] = value,
                "x22" => c.Anonymous.X[22] = value,
                "x23" => c.Anonymous.X[23] = value,
                "x24" => c.Anonymous.X[24] = value,
                "x25" => c.Anonymous.X[25] = value,
                "x26" => c.Anonymous.X[26] = value,
                "x27" => c.Anonymous.X[27] = value,
                "x28" => c.Anonymous.X[28] = value,
                "x29" => c.Anonymous.Anonymous.Fp = value,
                "x30" => c.Anonymous.Anonymous.Lr = value,
                "sp" => c.Sp = value,
                "pc" => c.Pc = value,
                "cpsr" => c.Cpsr = value as u32,
                _ => return false,
            }
        },
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        joybug_core::protocol::ThreadContext::Win32RawContext(_) => return false,
    }
    true
}

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
    let tid = session.state.lock().unwrap().active_tid(event);
    debug!("📤 Processing set register request: pid={}, tid={}, register={}, value=0x{:X}", pid, tid, register_name, value);

    // 1. Get current raw thread context
    let mut ctx = match session.get_thread_context(pid, tid) {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to get thread context for set register: {}", e);
            if let Some(ref handle) = app_handle_clone {
                crate::ui_logger::toast_error(handle, &format!("Failed to get thread context: {}", e));
            }
            return;
        }
    };

    // 2. Set the register
    if !write_register(&mut ctx, register_name, value) {
        error!("Unknown register: {}", register_name);
        if let Some(ref handle) = app_handle_clone {
            crate::ui_logger::toast_error(handle, &format!("Unknown register: {}", register_name));
        }
        return;
    }

    // 3. Write modified context back
    if let Err(e) = session.set_thread_context(pid, tid, ctx) {
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
