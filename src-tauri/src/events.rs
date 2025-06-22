use crate::state::DebugEventInfo;

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
        },
        DebugEvent::ProcessExited { pid, exit_code } => DebugEventInfo {
            event_type: "ProcessExited".to_string(),
            process_id: *pid,
            thread_id: 0, // ProcessExited doesn't have a tid field
            details: format!("Process exited: PID={}, Exit Code={}", pid, exit_code),
            can_continue: false,
            address: None,
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
        },
        DebugEvent::Output { pid, tid, output } => DebugEventInfo {
            event_type: "Output".to_string(),
            process_id: *pid,
            thread_id: *tid,
            details: format!("Debug output: PID={}, TID={}, Output={}", pid, tid, output),
            can_continue: true,
            address: None,
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
        },
        DebugEvent::Unknown => DebugEventInfo {
            event_type: "Unknown".to_string(),
            process_id: 0,
            thread_id: 0,
            details: "Unknown debug event".to_string(),
            can_continue: true,
            address: None,
        },
    }
} 