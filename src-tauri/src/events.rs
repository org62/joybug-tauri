use crate::state::{DebugEventInfo, SerializableThreadContext, Serializablex64ThreadContext};

pub fn convert_raw_context_to_serializable(
    raw_context: joybug2::protocol::ThreadContext,
) -> SerializableThreadContext {
    match raw_context {
        joybug2::protocol::ThreadContext::Win32RawContext(ctx) => {
            // This assumes x64 context
            SerializableThreadContext::X64(Serializablex64ThreadContext {
                rax: format!("{:#018x}", ctx.Rax),
                rbx: format!("{:#018x}", ctx.Rbx),
                rcx: format!("{:#018x}", ctx.Rcx),
                rdx: format!("{:#018x}", ctx.Rdx),
                rsi: format!("{:#018x}", ctx.Rsi),
                rdi: format!("{:#018x}", ctx.Rdi),
                rbp: format!("{:#018x}", ctx.Rbp),
                rsp: format!("{:#018x}", ctx.Rsp),
                rip: format!("{:#018x}", ctx.Rip),
                r8: format!("{:#018x}", ctx.R8),
                r9: format!("{:#018x}", ctx.R9),
                r10: format!("{:#018x}", ctx.R10),
                r11: format!("{:#018x}", ctx.R11),
                r12: format!("{:#018x}", ctx.R12),
                r13: format!("{:#018x}", ctx.R13),
                r14: format!("{:#018x}", ctx.R14),
                r15: format!("{:#018x}", ctx.R15),
                eflags: format!("{:#010x}", ctx.EFlags),
            })
        }
    }
}

pub fn debug_event_to_info(event: &joybug2::protocol_io::DebugEvent) -> DebugEventInfo {
    use joybug2::protocol_io::DebugEvent;

    match event {
        DebugEvent::ProcessCreated {
            pid,
            tid,
            image_file_name,
            base_of_image,
            size_of_image,
        } => DebugEventInfo {
            event_type: "ProcessCreated".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "Process created: PID={}, TID={}, Image={}, Base=0x{:X}, Size={}",
                pid,
                tid,
                image_file_name.as_deref().unwrap_or("Unknown"),
                base_of_image,
                size_of_image
                    .map(|s| format!("0x{:X}", s))
                    .unwrap_or_else(|| "Unknown".to_string())
            ),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::ProcessExited { pid, exit_code } => DebugEventInfo {
            event_type: "ProcessExited".to_string(),
            process_id: *pid,
            thread_id: 0, // ProcessExited doesn't have a tid field
            details: format!("Process exited: PID={}, Exit Code={}", pid, exit_code),
            can_continue: false,
            address: None,
            context: None,
        },
        DebugEvent::ThreadCreated {
            pid,
            tid,
            start_address,
        } => DebugEventInfo {
            event_type: "ThreadCreated".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "Thread created: PID={}, TID={}, Start Address=0x{:X}",
                pid, tid, start_address
            ),
            can_continue: true,
            address: Some(*start_address),
            context: None,
        },
        DebugEvent::ThreadExited {
            pid,
            tid,
            exit_code,
        } => DebugEventInfo {
            event_type: "ThreadExited".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "Thread exited: PID={}, TID={}, Exit Code={}",
                pid, tid, exit_code
            ),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::DllLoaded {
            pid,
            tid,
            dll_name,
            base_of_dll,
            size_of_dll,
        } => DebugEventInfo {
            event_type: "DllLoaded".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "DLL loaded: PID={}, TID={}, Name={}, Base=0x{:X}, Size={}",
                pid,
                tid,
                dll_name.as_deref().unwrap_or("Unknown"),
                base_of_dll,
                size_of_dll
                    .map(|s| format!("0x{:X}", s))
                    .unwrap_or_else(|| "Unknown".to_string())
            ),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::DllUnloaded {
            pid,
            tid,
            base_of_dll,
        } => DebugEventInfo {
            event_type: "DllUnloaded".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "DLL unloaded: PID={}, TID={}, Base=0x{:X}",
                pid, tid, base_of_dll
            ),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::Breakpoint { pid, tid, address } => DebugEventInfo {
            event_type: "Breakpoint".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "Breakpoint hit: PID={}, TID={}, Address=0x{:X}",
                pid, tid, address
            ),
            can_continue: true,
            address: Some(*address),
            context: None,
        },
        DebugEvent::Exception {
            pid,
            tid,
            code,
            address,
            first_chance,
            ..
        } => DebugEventInfo {
            event_type: "Exception".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "Exception occurred: PID={}, TID={}, Code=0x{:x}, Address=0x{:x}, First Chance={}",
                pid, tid, code, address, first_chance
            ),
            can_continue: true,
            address: Some(*address),
            context: None,
        },
        DebugEvent::Output { pid, tid, output } => DebugEventInfo {
            event_type: "Output".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!("Debug output: PID={}, TID={}, Output={}", pid, tid, output),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::RipEvent {
            pid,
            tid,
            error,
            event_type,
        } => DebugEventInfo {
            event_type: "RipEvent".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!(
                "RIP event: PID={}, TID={}, Error={}, Type={}",
                pid, tid, error, event_type
            ),
            can_continue: true,
            address: None,
            context: None,
        },
        DebugEvent::Unknown => DebugEventInfo {
            event_type: "Unknown".to_string(),
            process_id: 0,
            thread_id: 0,
            details: "Unknown debug event".to_string(),
            can_continue: true,
            address: None,
            context: None,
        },
    }
} 