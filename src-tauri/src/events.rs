use crate::state::{DebugEventInfo, SerializableThreadContext};

#[cfg(target_arch = "x86_64")]
use crate::state::Serializablex64ThreadContext;

#[cfg(target_arch = "aarch64")]
use crate::state::SerializableArm64ThreadContext;

pub fn convert_raw_context_to_serializable(
    raw_context: joybug2::protocol::ThreadContext,
) -> SerializableThreadContext {
    match raw_context {
        joybug2::protocol::ThreadContext::Win32RawContext(ctx) => {
            // Check target architecture at compile time
            #[cfg(target_arch = "x86_64")]
            {
                // x64 architecture - access x64 registers
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
            
            #[cfg(target_arch = "aarch64")]
            {
                // ARM64 architecture - access ARM64 registers through Anonymous union
                unsafe {
                    SerializableThreadContext::Arm64(SerializableArm64ThreadContext {
                        // ARM64 CONTEXT struct has X0-X30 registers accessed via Anonymous.X array
                        x0: format!("{:#018x}", ctx.Anonymous.X[0]),
                        x1: format!("{:#018x}", ctx.Anonymous.X[1]),
                        x2: format!("{:#018x}", ctx.Anonymous.X[2]),
                        x3: format!("{:#018x}", ctx.Anonymous.X[3]),
                        x4: format!("{:#018x}", ctx.Anonymous.X[4]),
                        x5: format!("{:#018x}", ctx.Anonymous.X[5]),
                        x6: format!("{:#018x}", ctx.Anonymous.X[6]),
                        x7: format!("{:#018x}", ctx.Anonymous.X[7]),
                        x8: format!("{:#018x}", ctx.Anonymous.X[8]),
                        x9: format!("{:#018x}", ctx.Anonymous.X[9]),
                        x10: format!("{:#018x}", ctx.Anonymous.X[10]),
                        x11: format!("{:#018x}", ctx.Anonymous.X[11]),
                        x12: format!("{:#018x}", ctx.Anonymous.X[12]),
                        x13: format!("{:#018x}", ctx.Anonymous.X[13]),
                        x14: format!("{:#018x}", ctx.Anonymous.X[14]),
                        x15: format!("{:#018x}", ctx.Anonymous.X[15]),
                        x16: format!("{:#018x}", ctx.Anonymous.X[16]),
                        x17: format!("{:#018x}", ctx.Anonymous.X[17]),
                        x18: format!("{:#018x}", ctx.Anonymous.X[18]),
                        x19: format!("{:#018x}", ctx.Anonymous.X[19]),
                        x20: format!("{:#018x}", ctx.Anonymous.X[20]),
                        x21: format!("{:#018x}", ctx.Anonymous.X[21]),
                        x22: format!("{:#018x}", ctx.Anonymous.X[22]),
                        x23: format!("{:#018x}", ctx.Anonymous.X[23]),
                        x24: format!("{:#018x}", ctx.Anonymous.X[24]),
                        x25: format!("{:#018x}", ctx.Anonymous.X[25]),
                        x26: format!("{:#018x}", ctx.Anonymous.X[26]),
                        x27: format!("{:#018x}", ctx.Anonymous.X[27]),
                        x28: format!("{:#018x}", ctx.Anonymous.X[28]),
                        x29: format!("{:#018x}", ctx.Anonymous.X[29]),  // Frame Pointer
                        x30: format!("{:#018x}", ctx.Anonymous.X[30]),  // Link Register
                        sp: format!("{:#018x}", ctx.Sp),
                        pc: format!("{:#018x}", ctx.Pc),
                        cpsr: format!("{:#010x}", ctx.Cpsr),
                    })
                }
            }
            
            #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
            {
                // Fallback for unsupported architectures
                compile_error!("Unsupported target architecture. Only x86_64 and aarch64 are supported.");
            }
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