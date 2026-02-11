use crate::error::{Error, Result};
use crate::state::{SessionStateUI, SessionStatusUI};
use crate::settings::SettingsState;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info, warn};

pub use joybug2::local_server::LocalServer;

#[derive(Debug, Clone)]
pub enum UICommand {
    Go,
    StepIn,
    StepOver,
    StepOut,
    Stop,
    Disassembly{ arch: joybug2::interfaces::Architecture, address: u64, count: u32 },
    DisassembleFunction{ arch: joybug2::interfaces::Architecture, address: u64, max_instructions: u32 },
    GetCallStack,
    SearchSymbols{ pattern: String, limit: u32 },
    ReadMemory{ address: u64, size: usize },
    WriteMemory{ address: u64, data: Vec<u8> },
    GetMemoryRegions,
    Dereference{ address: u64, count: usize },
    Emulate {
        max_instructions: usize,
        mode: joybug2::protocol_io::EmulationMode,
        exit_condition: Option<joybug2::protocol_io::TraceExitCondition>,
        request_id: Option<String>,
    },
}

/// Event payload for successful memory read (may be partial)
#[derive(serde::Serialize)]
pub struct MemoryReadResult {
    pub session_id: String,
    pub address: u64,
    pub requested_size: usize,
    pub data: Vec<u8>,
}

/// Event payload for memory read error
#[derive(serde::Serialize)]
pub struct MemoryReadError {
    pub session_id: String,
    pub address: u64,
    pub error: String,
}

/// Event payload for successful memory write
#[derive(serde::Serialize)]
pub struct MemoryWriteResult {
    pub session_id: String,
    pub address: u64,
    pub success: bool,
    pub bytes_written: usize,
}

/// Event payload for memory write error
#[derive(serde::Serialize)]
pub struct MemoryWriteError {
    pub session_id: String,
    pub address: u64,
    pub error: String,
}

/// Event payload for successful memory regions enumeration
#[derive(serde::Serialize)]
pub struct MemoryRegionsResult {
    pub session_id: String,
    pub regions: Vec<SerializableMemoryRegion>,
}

/// Serializable memory region info
#[derive(serde::Serialize)]
pub struct SerializableMemoryRegion {
    pub base_address: String,
    pub allocation_base: String,
    pub region_size: u64,
    pub region_size_formatted: String,
    pub state: String,
    pub state_raw: u32,
    pub protect: String,
    pub protect_raw: u32,
    pub region_type: String,
    pub type_raw: u32,
}

/// Event payload for memory regions error
#[derive(serde::Serialize)]
pub struct MemoryRegionsError {
    pub session_id: String,
    pub error: String,
}

/// Event payload for successful dereference
#[derive(serde::Serialize)]
pub struct DereferenceResult {
    pub session_id: String,
    pub base_address: String,
    pub entries: Vec<SerializableDereferenceEntry>,
}

/// Serializable dereference entry
#[derive(serde::Serialize)]
pub struct SerializableDereferenceEntry {
    pub address: String,
    pub offset: i64,
    pub chain: Vec<SerializableDereferenceValue>,
}

/// Serializable dereference value
#[derive(serde::Serialize)]
#[serde(tag = "type")]
pub enum SerializableDereferenceValue {
    Pointer { address: String, symbol: Option<String> },
    Value { value: String },
    String { value: String },
    Instruction { value: String, symbol: Option<String> },
    LoopDetected { address: String },
}

/// Event payload for dereference error
#[derive(serde::Serialize)]
pub struct DereferenceError {
    pub session_id: String,
    pub address: String,
    pub error: String,
}

/// Format bytes into human readable format (KB, MB, GB)
fn format_bytes(bytes: u64) -> String {
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

/// Updates session state (modules and threads) based on debug events
fn update_session_from_event(state: &mut SessionStateUI, event: &joybug2::protocol_io::DebugEvent) {
    match event {
        joybug2::protocol_io::DebugEvent::DllLoaded { dll_name, base_of_dll, size_of_dll, .. } => {
            let module_name = dll_name.clone().unwrap_or_else(|| format!("Unknown_0x{:X}", base_of_dll));
            let module = joybug2::protocol_io::ModuleInfo {
                name: module_name.clone(),
                base: *base_of_dll,
                size: *size_of_dll,
            };
            // Check if module already exists to avoid duplicates
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
            // Check if thread already exists to avoid duplicates
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added thread: {} at 0x{:X}", tid, start_address);
            }
        }
        joybug2::protocol_io::DebugEvent::ProcessCreated { pid, tid, image_file_name, base_of_image, size_of_image, .. } => {
            // Add the main executable as a module
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
            
            // Add the initial thread for the process
            let thread = joybug2::protocol_io::ThreadInfo {
                tid: *tid,
                start_address: *base_of_image, // Use the base address of the main executable as the start address
            };
            if !state.threads.iter().any(|t| t.tid == thread.tid) {
                state.threads.push(thread);
                info!("Added initial thread: {} for process {} at 0x{:X}", tid, pid, base_of_image);
            }
        }
        joybug2::protocol_io::DebugEvent::ThreadExited { tid, .. } => {
            // Remove thread when it exits
            state.threads.retain(|t| t.tid != *tid);
            info!("Removed thread: {}", tid);
        }
        joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } => {
            // Remove module when DLL is unloaded
            state.modules.retain(|m| m.base != *base_of_dll);
            info!("Removed module at 0x{:X}", base_of_dll);
        }
        joybug2::protocol_io::DebugEvent::ProcessExited { .. } => {
            // Process has exited, clear all modules and threads
            state.modules.clear();
            state.threads.clear();
            state.status = SessionStatusUI::Stopped;
            info!("Process exited, session stopped.");
        }
        _ => {
            // Other events don't affect modules/threads
        }
    }
}

/// Processes a disassembly request and emits results to the frontend
fn process_disassembly_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    count: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing disassembly request: pid={}, address=0x{:X}, count={}", pid, address, count);
    match session.disassemble_memory(pid, address, count as usize, arch) {
        Ok(instructions) => {
            debug!("📥 Received {} instructions from disassemble_memory", instructions.len());
            
            // Convert to serializable format and emit event
            let serializable_instructions: Vec<crate::commands::SerializableInstruction> = instructions
                .iter()
                .map(|inst| {
                    let address_str = if let Some(ref sym) = inst.symbol_info {
                        format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
                    } else {
                        format!("{:#X}", inst.address)
                    };

                    let op_str = inst.symbolized_op_str.as_ref().unwrap_or(&inst.op_str);

                    crate::commands::SerializableInstruction {
                        address: format!("{:#X}", inst.address),
                        symbol: address_str,
                        bytes: inst
                            .bytes
                            .iter()
                            .map(|b| format!("{:02X}", b))
                            .collect::<Vec<String>>()
                            .join(" "),
                        mnemonic: inst.mnemonic.clone(),
                        op_str: op_str.clone(),
                        is_jump: inst.is_jump,
                        is_call: inst.is_call,
                        is_ret: inst.is_ret,
                        jump_target: inst.jump_target.map(|addr| format!("{:#X}", addr)),
                    }
                })
                .collect();

            // Emit disassembly results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                
                #[derive(serde::Serialize)]
                struct DisassemblyResult {
                    session_id: String,
                    address: u64,
                    instructions: Vec<crate::commands::SerializableInstruction>,
                }
                
                let result = DisassemblyResult {
                    session_id,
                    address,
                    instructions: serializable_instructions,
                };
                
                if let Err(e) = handle.emit("disassembly-updated", &result) {
                    error!("Failed to emit disassembly-updated event: {}", e);
                } else {
                    debug!("📡 Emitted disassembly-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to disassemble memory: {}", e);
            
            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                
                #[derive(serde::Serialize)]
                struct DisassemblyError {
                    session_id: String,
                    address: u64,
                    error: String,
                }
                
                let error_result = DisassemblyError {
                    session_id,
                    address,
                    error: e.to_string(),
                };
                
                if let Err(emit_err) = handle.emit("disassembly-error", &error_result) {
                    error!("Failed to emit disassembly-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a function disassembly request with bounds detection and emits results to the frontend
fn process_function_disassembly_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    arch: joybug2::interfaces::Architecture,
    address: u64,
    max_instructions: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing function disassembly request: pid={}, address=0x{:X}, max_instructions={}", pid, address, max_instructions);

    match session.disassemble_function(pid, address, max_instructions as usize, arch) {
        Ok((instructions, function_start, function_end, function_name)) => {
            debug!("📥 Received {} instructions from disassemble_function", instructions.len());

            // Convert to serializable format
            let serializable_instructions: Vec<crate::commands::SerializableInstruction> = instructions
                .iter()
                .map(|inst| {
                    let address_str = if let Some(ref sym) = inst.symbol_info {
                        format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
                    } else {
                        format!("{:#X}", inst.address)
                    };

                    let op_str = inst.symbolized_op_str.as_ref().unwrap_or(&inst.op_str);

                    crate::commands::SerializableInstruction {
                        address: format!("{:#X}", inst.address),
                        symbol: address_str,
                        bytes: inst
                            .bytes
                            .iter()
                            .map(|b| format!("{:02X}", b))
                            .collect::<Vec<String>>()
                            .join(" "),
                        mnemonic: inst.mnemonic.clone(),
                        op_str: op_str.clone(),
                        is_jump: inst.is_jump,
                        is_call: inst.is_call,
                        is_ret: inst.is_ret,
                        jump_target: inst.jump_target.map(|addr| format!("{:#X}", addr)),
                    }
                })
                .collect();

            // Emit function disassembly results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct FunctionDisassemblyResult {
                    session_id: String,
                    address: u64,
                    instructions: Vec<crate::commands::SerializableInstruction>,
                    function_start: Option<String>,
                    function_end: Option<String>,
                    function_name: Option<String>,
                }

                let result = FunctionDisassemblyResult {
                    session_id,
                    address,
                    instructions: serializable_instructions,
                    function_start: function_start.map(|a| format!("{:#X}", a)),
                    function_end: function_end.map(|a| format!("{:#X}", a)),
                    function_name,
                };

                if let Err(e) = handle.emit("function-disassembly-updated", &result) {
                    error!("Failed to emit function-disassembly-updated event: {}", e);
                } else {
                    debug!("📡 Emitted function-disassembly-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to disassemble function: {}", e);

            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize)]
                struct FunctionDisassemblyError {
                    session_id: String,
                    address: u64,
                    error: String,
                }

                let error_result = FunctionDisassemblyError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("function-disassembly-error", &error_result) {
                    error!("Failed to emit function-disassembly-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a callstack request and emits results to the frontend
fn process_callstack_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let tid = event.tid();
    debug!("📤 Processing callstack request: pid={}, tid={}", pid, tid);

    match session.get_call_stack(pid, tid) {
        Ok(frames) => {
            debug!("📥 Received {} frames from get_call_stack", frames.len());

            // Convert to serializable format
            let call_stack: Vec<crate::commands::CallStackData> = frames.iter().enumerate().map(|(i, frame)| {
                crate::commands::CallStackData {
                    frame_number: i,
                    instruction_pointer: format!("0x{:016x}", frame.instruction_pointer),
                    stack_pointer: format!("0x{:016x}", frame.stack_pointer),
                    frame_pointer: format!("0x{:016x}", frame.frame_pointer),
                    symbol_info: frame.symbol.as_ref().map(|sym| {
                        format!("{}!{}+0x{:x}", sym.module_name, sym.symbol_name, sym.offset)
                    }),
                }
            }).collect();

            // Emit callstack results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                #[derive(serde::Serialize, Clone)]
                struct CallStackResult<'a> {
                    session_id: String,
                    frames: &'a Vec<crate::commands::CallStackData>,
                }

                let result = CallStackResult {
                    session_id,
                    frames: &call_stack,
                };

                if let Err(e) = handle.emit("callstack-updated", &result) {
                    error!("Failed to emit callstack-updated event: {}", e);
                } else {
                    debug!("📡 Emitted callstack-updated event for pid {}, tid {}", pid, tid);
                }
            }
        }
        Err(e) => {
            error!("Failed to get call stack: {}", e);
            
            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                
                #[derive(serde::Serialize, Clone)]
                struct CallStackError {
                    session_id: String,
                    error: String,
                }
                
                let error_result = CallStackError {
                    session_id,
                    error: e.to_string(),
                };
                
                if let Err(emit_err) = handle.emit("callstack-error", &error_result) {
                    error!("Failed to emit callstack-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a symbol search request and emits results to the frontend
fn process_symbol_search(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    pattern: &str,
    limit: u32,
) {
    let pid = event.pid();
    debug!("📤 Processing symbol search request: pid={}, pattern='{}', limit={}", pid, pattern, limit);

    match session.find_symbols(pattern, limit as usize) {
        Ok(resolved_symbols) => {
            debug!("📥 Received {} symbols from find_symbols", resolved_symbols.len());
            
            // Convert to serializable format
            let symbols: Vec<crate::commands::SymbolData> = resolved_symbols.iter().map(|resolved_symbol| {
                // Extract just the symbol name from the full "module!symbol" format
                let symbol_name = if let Some(pos) = resolved_symbol.name.find('!') {
                    resolved_symbol.name[pos + 1..].to_string()
                } else {
                    resolved_symbol.name.clone()
                };
                
                crate::commands::SymbolData {
                    name: symbol_name,
                    module_name: resolved_symbol.module_name.clone(),
                    rva: resolved_symbol.rva,
                    va: format!("0x{:X}", resolved_symbol.va),
                    display_name: resolved_symbol.name.clone(), // Use the full name which is already "module!symbol"
                }
            }).collect();

            // Emit symbol search results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                
                #[derive(serde::Serialize)]
                struct SymbolSearchResult<'a> {
                    session_id: String,
                    pattern: &'a str,
                    symbols: &'a Vec<crate::commands::SymbolData>,
                }
                
                let result = SymbolSearchResult {
                    session_id,
                    pattern,
                    symbols: &symbols,
                };
                
                if let Err(e) = handle.emit("symbols-updated", &result) {
                    error!("Failed to emit symbols-updated event: {}", e);
                } else {
                    debug!("📡 Emitted symbols-updated event for pattern '{}'", pattern);
                }
            }
        }
        Err(e) => {
            error!("Failed to find symbols for pattern '{}': {}", pattern, e);
            
            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                
                #[derive(serde::Serialize)]
                struct SymbolSearchError<'a> {
                    session_id: String,
                    pattern: &'a str,
                    error: String,
                }
                
                let error_result = SymbolSearchError {
                    session_id,
                    pattern,
                    error: e.to_string(),
                };
                
                if let Err(emit_err) = handle.emit("symbols-error", &error_result) {
                    error!("Failed to emit symbols-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory read request and emits results to the frontend
fn process_memory_read(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    size: usize,
) {
    let pid = event.pid();
    debug!("📤 Processing memory read request: pid={}, address=0x{:X}, size={}", pid, address, size);

    match session.read_memory(pid, address, size) {
        Ok(data) => {
            let bytes_read = data.len();
            let is_partial = bytes_read < size && bytes_read > 0;

            if is_partial {
                info!(
                    "📥 Partial memory read: {} of {} bytes at 0x{:X}",
                    bytes_read, size, address
                );
            } else {
                debug!("📥 Received {} bytes from read_memory", bytes_read);
            }

            // Emit memory read results to frontend (including partial reads)
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryReadResult {
                    session_id,
                    address,
                    requested_size: size,
                    data,
                };

                if let Err(e) = handle.emit("memory-read-updated", &result) {
                    error!("Failed to emit memory-read-updated event: {}", e);
                } else {
                    debug!("📡 Emitted memory-read-updated event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to read memory at 0x{:X}: {}", address, e);

            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryReadError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-read-error", &error_result) {
                    error!("Failed to emit memory-read-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory write request and emits results to the frontend
fn process_memory_write(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    data: &[u8],
) {
    let pid = event.pid();
    debug!("📤 Processing memory write request: pid={}, address=0x{:X}, size={}", pid, address, data.len());

    match session.write_memory(pid, address, data.to_vec()) {
        Ok(_) => {
            debug!("📥 Successfully wrote {} bytes to memory", data.len());

            // Emit memory write results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryWriteResult {
                    session_id,
                    address,
                    success: true,
                    bytes_written: data.len(),
                };

                if let Err(e) = handle.emit("memory-write-result", &result) {
                    error!("Failed to emit memory-write-result event: {}", e);
                } else {
                    debug!("📡 Emitted memory-write-result event for address 0x{:X}", address);
                }
            }
        }
        Err(e) => {
            error!("Failed to write memory: {}", e);

            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryWriteError {
                    session_id,
                    address,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-write-error", &error_result) {
                    error!("Failed to emit memory-write-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a memory regions request and emits results to the frontend
fn process_memory_regions_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    debug!("📤 Processing memory regions request: pid={}", pid);

    match session.enumerate_memory_regions(pid) {
        Ok(regions) => {
            debug!("📥 Received {} memory regions", regions.len());

            // Convert to serializable format using joybug2 formatting helpers
            let serializable_regions: Vec<SerializableMemoryRegion> = regions
                .iter()
                .map(|r| SerializableMemoryRegion {
                    base_address: format!("0x{:016X}", r.base_address),
                    allocation_base: format!("0x{:016X}", r.allocation_base),
                    region_size: r.region_size,
                    region_size_formatted: format_bytes(r.region_size),
                    state: joybug2::formatting::memory::state_to_str(r.state).to_string(),
                    state_raw: r.state,
                    protect: joybug2::formatting::memory::protect_to_str(r.protect).to_string(),
                    protect_raw: r.protect,
                    region_type: joybug2::formatting::memory::type_to_str(r.region_type).to_string(),
                    type_raw: r.region_type,
                })
                .collect();

            // Emit memory regions results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = MemoryRegionsResult {
                    session_id,
                    regions: serializable_regions,
                };

                if let Err(e) = handle.emit("memory-regions-updated", &result) {
                    error!("Failed to emit memory-regions-updated event: {}", e);
                } else {
                    debug!("📡 Emitted memory-regions-updated event with {} regions", result.regions.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to enumerate memory regions: {}", e);

            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = MemoryRegionsError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("memory-regions-error", &error_result) {
                    error!("Failed to emit memory-regions-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Processes a dereference request and emits results to the frontend
fn process_dereference_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    address: u64,
    count: usize,
) {
    let pid = event.pid();
    debug!("📤 Processing dereference request: pid={}, address=0x{:X}, count={}", pid, address, count);

    match session.dereference(pid, address, count, None) {
        Ok(entries) => {
            debug!("📥 Received {} dereference entries", entries.len());

            // Convert to serializable format
            let serializable_entries: Vec<SerializableDereferenceEntry> = entries
                .iter()
                .map(|entry| {
                    let chain: Vec<SerializableDereferenceValue> = entry.chain.iter().map(|v| {
                        match v {
                            joybug2::protocol::DereferenceValue::Pointer(addr, sym) => {
                                SerializableDereferenceValue::Pointer {
                                    address: format!("0x{:016X}", addr),
                                    symbol: sym.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::Value(val) => {
                                SerializableDereferenceValue::Value {
                                    value: format!("0x{:X}", val),
                                }
                            }
                            joybug2::protocol::DereferenceValue::String(s) => {
                                SerializableDereferenceValue::String {
                                    value: s.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::Instruction(instr, sym) => {
                                SerializableDereferenceValue::Instruction {
                                    value: instr.clone(),
                                    symbol: sym.clone(),
                                }
                            }
                            joybug2::protocol::DereferenceValue::LoopDetected(addr) => {
                                SerializableDereferenceValue::LoopDetected {
                                    address: format!("0x{:016X}", addr),
                                }
                            }
                        }
                    }).collect();

                    SerializableDereferenceEntry {
                        address: format!("0x{:016X}", entry.address),
                        offset: entry.offset,
                        chain,
                    }
                })
                .collect();

            // Emit dereference results to frontend
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let result = DereferenceResult {
                    session_id,
                    base_address: format!("0x{:016X}", address),
                    entries: serializable_entries,
                };

                if let Err(e) = handle.emit("dereference-updated", &result) {
                    error!("Failed to emit dereference-updated event: {}", e);
                } else {
                    debug!("📡 Emitted dereference-updated event with {} entries", result.entries.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to dereference at 0x{:X}: {}", address, e);

            // Emit error event
            if let Some(ref handle) = app_handle_clone {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };

                let error_result = DereferenceError {
                    session_id,
                    address: format!("0x{:016X}", address),
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("dereference-error", &error_result) {
                    error!("Failed to emit dereference-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Formats a symbol as "module!name+0xoffset"
fn format_symbol(module: &str, name: &str, offset: u64) -> String {
    format!("{}!{}+0x{:x}", module, name, offset)
}

/// Extracts PC addresses from Tenet trace text (first key=value on each line is always the PC)
fn extract_pcs_from_tenet(trace_text: &str) -> Vec<u64> {
    trace_text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let first_comma = line.find(',').unwrap_or(line.len());
            let first_field = &line[..first_comma];
            let eq_pos = first_field.find('=')?;
            let hex_val = first_field[eq_pos + 1..].trim_start_matches("0x").trim_start_matches("0X");
            u64::from_str_radix(hex_val, 16).ok()
        })
        .collect()
}

/// Disassembles a set of unique addresses (1 instruction each) and returns instruction info
fn disassemble_addresses(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    pid: u32,
    addresses: &[u64],
    arch: joybug2::interfaces::Architecture,
) -> Vec<crate::commands::EmulationInstructionInfo> {
    let mut info = Vec::with_capacity(addresses.len());
    for &addr in addresses {
        if let Ok(instructions) = session.disassemble_memory(pid, addr, 1, arch) {
            if let Some(inst) = instructions.first() {
                let symbol = inst.symbol_info.as_ref().map(|sym| {
                    format_symbol(&sym.module_name, &sym.symbol_name, sym.offset)
                });
                let op_str = inst.symbolized_op_str.as_ref().unwrap_or(&inst.op_str).clone();
                info.push(crate::commands::EmulationInstructionInfo {
                    address: format!("0x{:X}", inst.address),
                    symbol,
                    mnemonic: inst.mnemonic.clone(),
                    op_str,
                });
            }
        }
    }
    info
}

/// Symbolize addresses in stop_reason strings like "Syscall(0x7FFC0E651262)"
fn symbolize_stop_reason(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    pid: u32,
    stop_reason: &str,
) -> String {
    // Match "Syscall(0xADDR)" or "ReachedAddress(0xADDR)"
    if let Some(start) = stop_reason.find("(0x") {
        if let Some(end) = stop_reason[start..].find(')') {
            let hex_str = &stop_reason[start + 1..start + end]; // "0x..."
            if let Ok(addr) = u64::from_str_radix(&hex_str[2..], 16) {
                if let Ok((_module, sym, offset)) = session.resolve_address_to_symbol(pid, addr) {
                    if let (Some(m), Some(s), Some(o)) = (_module, sym, offset) {
                        let symbol = format_symbol(&m, &s.name, o);
                        return format!("{}{}{}", &stop_reason[..start + 1], symbol, &stop_reason[start + end..]);
                    }
                }
            }
        }
    }
    stop_reason.to_string()
}

/// Processes an emulation request and emits results to the frontend
fn process_emulation_request(
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
    max_instructions: usize,
    mode: joybug2::protocol_io::EmulationMode,
    exit_condition: Option<joybug2::protocol_io::TraceExitCondition>,
    request_id: Option<String>,
) {
    let pid = event.pid();
    let tid = event.tid();
    debug!("📤 Processing emulation request: pid={}, tid={}, max_instructions={}, mode={:?}", pid, tid, max_instructions, mode);

    let session_id = {
        let state = session.state.lock().unwrap();
        state.id.clone()
    };

    match session.emulate_instructions(pid, tid, max_instructions, mode, exit_condition) {
        Ok(result) => {
            debug!("📥 Received emulation result");

            // Determine architecture for disassembly enrichment
            let arch = {
                let state = session.state.lock().unwrap();
                match &state.current_context {
                    Some(crate::state::SerializableThreadContext::X64(_)) => joybug2::interfaces::Architecture::X64,
                    Some(crate::state::SerializableThreadContext::Arm64(_)) => joybug2::interfaces::Architecture::Arm64,
                    None => {
                        #[cfg(target_arch = "x86_64")]
                        { joybug2::interfaces::Architecture::X64 }
                        #[cfg(target_arch = "aarch64")]
                        { joybug2::interfaces::Architecture::Arm64 }
                        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
                        { joybug2::interfaces::Architecture::X64 }
                    }
                }
            };

            // Collect unique addresses for BasicBlock and InstructionTrace modes
            let needs_disassembly = matches!(mode,
                joybug2::protocol_io::EmulationMode::BasicBlock |
                joybug2::protocol_io::EmulationMode::InstructionTrace
            );

            let unique_addrs: Vec<u64> = if needs_disassembly {
                let raw_addrs: Vec<u64> = match &result {
                    joybug2::protocol_io::EmulateResult::Emulation(data) => {
                        data.basic_blocks.clone()
                    }
                    joybug2::protocol_io::EmulateResult::Trace(trace) => {
                        extract_pcs_from_tenet(&trace.trace_text)
                    }
                };
                // Deduplicate while preserving first-seen order
                let mut seen = std::collections::HashSet::new();
                raw_addrs.into_iter().filter(|a| seen.insert(*a)).collect()
            } else {
                Vec::new()
            };

            let instruction_info = if !unique_addrs.is_empty() {
                debug!("📤 Disassembling {} unique addresses for emulation enrichment", unique_addrs.len());
                disassemble_addresses(session, pid, &unique_addrs, arch)
            } else {
                Vec::new()
            };

            if let Some(ref handle) = app_handle_clone {
                let payload = match result {
                    joybug2::protocol_io::EmulateResult::Emulation(data) => {
                        let stop_reason = symbolize_stop_reason(session, pid, &data.stop_reason);
                        crate::commands::EmulationResultPayload {
                            session_id,
                            request_id,
                            mode: format!("{:?}", mode),
                            final_pc: Some(format!("0x{:X}", data.final_pc)),
                            instructions_executed: data.instructions_executed,
                            stop_reason,
                            emulation_time_us: data.emulation_time_us,
                            pages_loaded: Some(data.pages_loaded),
                            basic_blocks: data.basic_blocks.iter().map(|addr| format!("0x{:X}", addr)).collect(),
                            trace_text: None,
                            trace_time_us: None,
                            instruction_info,
                            stats_text: data.stats_text,
                        }
                    }
                    joybug2::protocol_io::EmulateResult::Trace(trace) => {
                        let stop_reason = symbolize_stop_reason(session, pid, &trace.stop_reason);
                        crate::commands::EmulationResultPayload {
                            session_id,
                            request_id,
                            mode: format!("{:?}", mode),
                            final_pc: None,
                            instructions_executed: 0,
                            stop_reason,
                            emulation_time_us: trace.trace_time_us,
                            pages_loaded: None,
                            basic_blocks: Vec::new(),
                            trace_text: Some(trace.trace_text),
                            trace_time_us: Some(trace.trace_time_us),
                            instruction_info,
                            stats_text: trace.stats_text,
                        }
                    }
                };

                if let Err(e) = handle.emit("emulation-result", &payload) {
                    error!("Failed to emit emulation-result event: {}", e);
                } else {
                    debug!("📡 Emitted emulation-result event with {} instruction info entries", payload.instruction_info.len());
                }
            }
        }
        Err(e) => {
            error!("Failed to emulate instructions: {}", e);

            if let Some(ref handle) = app_handle_clone {
                #[derive(serde::Serialize)]
                struct EmulationError {
                    session_id: String,
                    error: String,
                }

                let error_result = EmulationError {
                    session_id,
                    error: e.to_string(),
                };

                if let Err(emit_err) = handle.emit("emulation-error", &error_result) {
                    error!("Failed to emit emulation-error event: {}", emit_err);
                }
            }
        }
    }
}

/// Handles UI commands in a loop, returns true to continue execution, false to stop session
fn handle_ui_commands(
    ui_receiver: &std::sync::mpsc::Receiver<UICommand>,
    session: &mut joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) -> Result<bool> {
    loop {
        match ui_receiver.recv() {
            Ok(command) => {
                info!("Received UI command: {:?}", command);

                match command {
                    UICommand::Go => {
                        debug!("📤 Go command - continuing execution");
                        // Set UI status to Running while target executes
                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true); // Continue execution
                    }
                    UICommand::StepIn => {
                        // Initiate single step into on current pid/tid
                        let pid = event.pid();
                        let tid = event.tid();

                        debug!("📤 StepIn command - pid={}, tid={}", pid, tid);

                        // Request a step into; stop after first step completes
                        session
                            .step(
                                pid,
                                tid,
                                joybug2::protocol_io::StepKind::Into,
                                |_s, _pid, _tid, _addr, _kind| {
                                    debug!("📥 StepIn handler called");
                                    Ok(joybug2::protocol_io::StepAction::Stop)
                                },
                            )
                            .map_err(|e| Error::DebugLoop(format!(
                                "Failed to start step-in: {}",
                                e
                            )))?;

                        // Target will run briefly until step completes; mark as Running
                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
                    }
                    UICommand::StepOver => {
                        // Initiate step over on current pid/tid
                        let pid = event.pid();
                        let tid = event.tid();

                        debug!("📤 StepOver command - pid={}, tid={}", pid, tid);

                        session
                            .step(
                                pid,
                                tid,
                                joybug2::protocol_io::StepKind::Over,
                                |_s, _pid, _tid, _addr, _kind| {
                                    debug!("📥 StepOver handler called");
                                    Ok(joybug2::protocol_io::StepAction::Stop)
                                },
                            )
                            .map_err(|e| Error::DebugLoop(format!(
                                "Failed to start step-over: {}",
                                e
                            )))?;

                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
                    }
                    UICommand::StepOut => {
                        // Initiate step out on current pid/tid
                        let pid = event.pid();
                        let tid = event.tid();

                        debug!("📤 StepOut command - pid={}, tid={}", pid, tid);

                        if let Err(e) = session.step(
                            pid,
                            tid,
                            joybug2::protocol_io::StepKind::Out,
                            |_s, _pid, _tid, _addr, _kind| {
                                debug!("📥 StepOut handler called");
                                Ok(joybug2::protocol_io::StepAction::Stop)
                            },
                        ) {
                            // Surface step-out error to UI, log, and stop the session per requirement
                            let msg = format!("Step out failed: {}", e);
                            if let Some(ref handle) = app_handle_clone {
                                let session_id = {
                                    let state = session.state.lock().unwrap();
                                    state.id.clone()
                                };
                                crate::ui_logger::log_error(handle, &msg, Some(session_id));
                                crate::ui_logger::toast_error(handle, &msg);
                            }
                            // Keep session paused: do NOT continue execution; wait for the next UI command
                            debug!("StepOut failed; staying paused and awaiting next command");
                            continue;
                        }

                        if let Some(handle) = app_handle_clone.as_ref() {
                            let mut s = session.state.lock().unwrap();
                            s.status = SessionStatusUI::Running;
                            drop(s);
                            emit_session_event(&session.state, handle);
                        }
                        return Ok(true);
                    }
                    UICommand::Disassembly { arch, address, count } => {
                        // Handle disassembly request
                        process_disassembly_request(session, app_handle_clone, event, arch, address, count);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::DisassembleFunction { arch, address, max_instructions } => {
                        // Handle function disassembly request
                        process_function_disassembly_request(session, app_handle_clone, event, arch, address, max_instructions);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::GetCallStack => {
                        process_callstack_request(session, app_handle_clone, event);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::SearchSymbols { ref pattern, limit } => {
                        process_symbol_search(session, app_handle_clone, event, pattern, limit);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::ReadMemory { address, size } => {
                        process_memory_read(session, app_handle_clone, event, address, size);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::WriteMemory { address, ref data } => {
                        process_memory_write(session, app_handle_clone, event, address, data);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::GetMemoryRegions => {
                        process_memory_regions_request(session, app_handle_clone, event);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::Dereference { address, count } => {
                        process_dereference_request(session, app_handle_clone, event, address, count);
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::Emulate { max_instructions, mode, ref exit_condition, ref request_id } => {
                        process_emulation_request(session, app_handle_clone, event, max_instructions, mode, exit_condition.clone(), request_id.clone());
                        // Continue in loop waiting for next command (Go or Stop)
                    }
                    UICommand::Stop => {
                        info!("Stop command received, terminating session");
                        let mut state = session.state.lock().unwrap();
                        state.status = SessionStatusUI::Stopped;
                        return Ok(false); // Stop session
                    }
                }
            }
            Err(_) => {
                debug!("❌ Debug session receiver disconnected");
                warn!("Debug session receiver disconnected");
                let mut state = session.state.lock().unwrap();
                state.status = SessionStatusUI::Error("Step receiver disconnected".to_string());
                return Ok(false); // Stop session
            }
        }
    }
}

pub fn run_debug_session(
    session_state: Arc<Mutex<SessionStateUI>>,
    app_handle: Option<AppHandle>,
) -> Result<()> {
    let (session_id, server_url, launch_command) = {
        let state = session_state.lock().unwrap();
        (state.id.clone(), state.server_url.clone(), state.launch_command.clone())
    };

    info!("Starting debug session: {}", session_id);

    // Get step receiver from session state
    let ui_receiver = {
        let mut state = session_state.lock().unwrap();
        match state.ui_receiver.take() {
            Some(rx) => rx,
            None => {
                // Session was started twice or receiver already taken due to race. Surface as error and stop.
                return Err(Error::InternalCommunication("UI receiver not available (session already running?)".to_string()));
            }
        }
    };

    // Mark status as Running at launch and notify UI
    {
        let mut state = session_state.lock().unwrap();
        state.status = SessionStatusUI::Running;
    }
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    // Create app handle clone for the closure
    let app_handle_clone = app_handle.clone();

    // Create main session with event handler and launch
    let _final_state = joybug2::protocol_io::DebugSession::new(session_state.clone(), Some(&server_url))
        .map_err(|e| Error::ConnectionFailed(e.to_string()))?
        .on_event(move |session, event| {
            debug!("📥 Received debug event from server: {}", event);
            info!("Debug event: {}", event);

            let handle = app_handle_clone.as_ref().unwrap();
            crate::ui_logger::log_debug(
                handle,
                &format!("Received debug event: {}", event),
                Some(session.state.lock().unwrap().id.clone()),
            );
            if !matches!(
                event,
                joybug2::protocol_io::DebugEvent::Output { .. }
                    | joybug2::protocol_io::DebugEvent::DllLoaded { .. }
                    | joybug2::protocol_io::DebugEvent::DllUnloaded { .. }
            ) {
                crate::ui_logger::toast_info(handle, &format!("{}", event));
            }

            // Special handling for OutputDebugString: log and toast raw string, do not pause
            if let joybug2::protocol_io::DebugEvent::Output { output, .. } = event {
                let session_id = {
                    let state = session.state.lock().unwrap();
                    state.id.clone()
                };
                // add "OutputDebugString: " to the output
                let output = format!("OutputDebugString: {}", output);
                crate::ui_logger::log_info(handle, &output, Some(session_id));
                crate::ui_logger::toast_info(handle, &output);

                // Record event but keep session running (no context fetch / pause)
                {
                    let mut state = session.state.lock().unwrap();
                    state.events.push(event.clone());
                }
                emit_session_event(&session.state, handle);
            }

            // Handle events that don't require thread context or user interaction first.
            // ProcessExited: always finalize/continue.
            if matches!(event, joybug2::protocol_io::DebugEvent::ProcessExited { .. }) {
                {
                    let mut state = session.state.lock().unwrap();
                    state.current_event = Some(event.clone());
                    state.events.push(event.clone());
                    update_session_from_event(&mut state, event);
                }
                emit_session_event(&session.state, handle);
                return Ok(true);
            }

            // ThreadExited: respect settings whether to pause or not
            if let joybug2::protocol_io::DebugEvent::ThreadExited { .. } = event {
                let should_pause_on_thread_exit = {
                    let s = handle.state::<SettingsState>();
                    let s = s.lock().unwrap();
                    s.stop_on_thread_exit
                };
                if !should_pause_on_thread_exit {
                    {
                        let mut state = session.state.lock().unwrap();
                        state.current_event = Some(event.clone());
                        state.events.push(event.clone());
                        update_session_from_event(&mut state, event);
                    }
                    emit_session_event(&session.state, handle);
                    return Ok(true);
                }
            }

            // Decide whether this event should pause or auto-continue based on user settings
            {
                let settings = handle.state::<SettingsState>().inner().lock().unwrap().clone();
                let should_pause = match event {
                    joybug2::protocol_io::DebugEvent::ProcessCreated { .. } => settings.stop_on_process_create,
                    joybug2::protocol_io::DebugEvent::ThreadCreated { .. } => settings.stop_on_thread_create,
                    joybug2::protocol_io::DebugEvent::ThreadExited { .. } => settings.stop_on_thread_exit,
                    joybug2::protocol_io::DebugEvent::DllLoaded { .. } => settings.stop_on_dll_load,
                    joybug2::protocol_io::DebugEvent::DllUnloaded { .. } => settings.stop_on_dll_unload,
                    joybug2::protocol_io::DebugEvent::InitialBreakpoint { .. } => settings.stop_on_initial_breakpoint,
                    _ => true,
                };

                if !should_pause {
                    // For non-pausing events, perform state update, emit any targeted events, notify UI, and continue.
                    let mut unloaded_module_name: Option<String> = None;
                    {
                        let mut state = session.state.lock().unwrap();
                        // Capture unloaded module name before removal
                        if let joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } = event {
                            if let Some(m) = state.modules.iter().find(|m| m.base == *base_of_dll) {
                                unloaded_module_name = Some(m.name.clone());
                            }
                        }
                        state.current_event = Some(event.clone());
                        state.events.push(event.clone());
                        update_session_from_event(&mut state, event);
                        // Keep status Running (do not set Paused)
                        state.status = SessionStatusUI::Running;
                    }

                    // Emit targeted events for DLL load/unload (with logging/toast handled there)
                    if let Some(ref handle) = app_handle_clone {
                        let state = session.state.lock().unwrap();
                        let session_id = state.id.clone();
                        drop(state);
                        match event {
                            joybug2::protocol_io::DebugEvent::DllUnloaded { pid, tid, base_of_dll } => {
                                #[derive(serde::Serialize)]
                                struct DllUnloadedEvent {
                                    session_id: String,
                                    pid: u32,
                                    tid: u32,
                                    base_of_dll: u64,
                                    dll_name: Option<String>,
                                }
                                let payload = DllUnloadedEvent { session_id: session_id.clone(), pid: *pid, tid: *tid, base_of_dll: *base_of_dll, dll_name: unloaded_module_name };
                                if let Err(e) = handle.emit("dll-unloaded", &payload) {
                                    error!("Failed to emit dll-unloaded event: {}", e);
                                } else {
                                    debug!("📡 Emitted dll-unloaded event for base 0x{:X}", base_of_dll);
                                }
                                let message = match &payload.dll_name {
                                    Some(name) => format!("DLL unloaded: {} @ 0x{:X}", name, base_of_dll),
                                    None => format!("DLL unloaded @ 0x{:X}", base_of_dll),
                                };
                                crate::ui_logger::log_info(handle, &message, Some(session_id));
                                crate::ui_logger::toast_info(handle, &message);
                            }
                            joybug2::protocol_io::DebugEvent::DllLoaded { pid, tid, dll_name, base_of_dll, size_of_dll } => {
                                #[derive(serde::Serialize)]
                                struct DllLoadedEvent<'a> {
                                    session_id: String,
                                    pid: u32,
                                    tid: u32,
                                    dll_name: &'a str,
                                    base_of_dll: u64,
                                    size_of_dll: Option<u64>,
                                }
                                let name = dll_name.as_deref().unwrap_or("<unknown>");
                                let payload = DllLoadedEvent { session_id: session_id.clone(), pid: *pid, tid: *tid, dll_name: name, base_of_dll: *base_of_dll, size_of_dll: *size_of_dll };
                                if let Err(e) = handle.emit("dll-loaded", &payload) {
                                    error!("Failed to emit dll-loaded event: {}", e);
                                } else {
                                    debug!("📡 Emitted dll-loaded event for base 0x{:X}", base_of_dll);
                                }
                                let message = match size_of_dll {
                                    Some(sz) => format!("DLL loaded: {} @ 0x{:X} (size: 0x{:X})", name, base_of_dll, sz),
                                    None => format!("DLL loaded: {} @ 0x{:X}", name, base_of_dll),
                                };
                                crate::ui_logger::log_info(handle, &message, Some(session_id));
                                crate::ui_logger::toast_info(handle, &message);
                            }
                            _ => {}
                        }
                    }

                    emit_session_event(&session.state, handle);
                    return Ok(true);
                }

                // Update session state from event (pausing path)
                let context = match session.get_thread_context(event.pid(), event.tid()) {
                    Ok(ctx) => ctx,
                    Err(e) => {
                        error!("Failed to get thread context: {}", e);
                        let mut state = session.state.lock().unwrap();
                        state.status = SessionStatusUI::Error(format!("GetThreadContext failed: {}", e));
                        emit_session_event(&session.state, handle);
                        return Ok(false);
                    }
                };
                let mut state = session.state.lock().unwrap();
                state.current_event = Some(event.clone());
                state.events.push(event.clone());
                state.status = SessionStatusUI::Paused; // Paused waiting for user input
                state.current_context = Some(crate::events::convert_raw_context_to_serializable(context));

                // For DllUnloaded, capture module name before state update removes it
                let mut unloaded_module_name: Option<String> = None;
                if let joybug2::protocol_io::DebugEvent::DllUnloaded { base_of_dll, .. } = event {
                    if let Some(m) = state.modules.iter().find(|m| m.base == *base_of_dll) {
                        unloaded_module_name = Some(m.name.clone());
                    }
                }

                update_session_from_event(&mut state, event);

                // Emit targeted events for specific debug events (we may use unloaded_module_name captured above)
                if let Some(ref handle) = app_handle_clone {
                    let session_id = state.id.clone();
                    match event {
                        joybug2::protocol_io::DebugEvent::DllUnloaded { pid, tid, base_of_dll } => {
                            #[derive(serde::Serialize)]
                            struct DllUnloadedEvent {
                                session_id: String,
                                pid: u32,
                                tid: u32,
                                base_of_dll: u64,
                                dll_name: Option<String>,
                            }
                            let payload = DllUnloadedEvent { session_id, pid: *pid, tid: *tid, base_of_dll: *base_of_dll, dll_name: unloaded_module_name };
                            if let Err(e) = handle.emit("dll-unloaded", &payload) {
                                error!("Failed to emit dll-unloaded event: {}", e);
                            } else {
                                debug!("📡 Emitted dll-unloaded event for base 0x{:X}", base_of_dll);
                            }

                            // Log and toast with DLL name when available
                            let message = match &payload.dll_name {
                                Some(name) => format!("DLL unloaded: {} @ 0x{:X}", name, base_of_dll),
                                None => format!("DLL unloaded @ 0x{:X}", base_of_dll),
                            };
                            let sid = payload.session_id.clone();
                            crate::ui_logger::log_info(handle, &message, Some(sid));
                            crate::ui_logger::toast_info(handle, &message);
                        }
                        joybug2::protocol_io::DebugEvent::DllLoaded { pid, tid, dll_name, base_of_dll, size_of_dll } => {
                            #[derive(serde::Serialize)]
                            struct DllLoadedEvent<'a> {
                                session_id: String,
                                pid: u32,
                                tid: u32,
                                dll_name: &'a str,
                                base_of_dll: u64,
                                size_of_dll: Option<u64>,
                            }
                            let name = dll_name.as_deref().unwrap_or("<unknown>");
                            let payload = DllLoadedEvent { session_id, pid: *pid, tid: *tid, dll_name: name, base_of_dll: *base_of_dll, size_of_dll: *size_of_dll };
                            if let Err(e) = handle.emit("dll-loaded", &payload) {
                                error!("Failed to emit dll-loaded event: {}", e);
                            } else {
                                debug!("📡 Emitted dll-loaded event for base 0x{:X}", base_of_dll);
                            }

                            // Log and toast with DLL name on load
                            let message = match size_of_dll {
                                Some(sz) => format!("DLL loaded: {} @ 0x{:X} (size: 0x{:X})", name, base_of_dll, sz),
                                None => format!("DLL loaded: {} @ 0x{:X}", name, base_of_dll),
                            };
                            let sid = payload.session_id.clone();
                            crate::ui_logger::log_info(handle, &message, Some(sid));
                            crate::ui_logger::toast_info(handle, &message);
                        }
                        _ => {}
                    }
                }

            }
            // Get thread context if applicable
            //let req = joybug2::protocol::DebuggerRequest::GetThreadContext { pid, tid };
            //debug!("📤 Sending GetThreadContext request to server: pid={}, tid={}", pid, tid);
            //match session.send_and_receive(&req) {
            //    Ok(joybug2::protocol::DebuggerResponse::ThreadContext { context: raw_context }) => {
            //        debug!("📥 Received ThreadContext response from server");
            //        let mut state = session.state.lock().unwrap();
            //        state.current_context = Some(crate::events::convert_raw_context_to_serializable(raw_context));
            //    }
            //    Ok(other_resp) => {
            //        debug!("📥 Received unexpected response from server: {:?}", other_resp);
            //        warn!("Expected ThreadContext response, got {:?}", other_resp);
            //    }
            //    Err(e) => {
            //        debug!("❌ Failed to get thread context from server: {}", e);
            //        error!("Failed to get thread context: {}", e);
            //    }
            //}

            // Emit session events
            emit_session_event(&session.state, handle);

            info!("Debug event received, waiting for user command");

            // Wait for user commands
            match handle_ui_commands(&ui_receiver, session, &app_handle_clone, event) {
                Ok(should_continue) => {
                    // Return the boolean value to control the session loop
                    return Ok(should_continue);
                }
                Err(e) => {
                    error!("Error handling UI commands: {}", e);
                    let mut state = session.state.lock().unwrap();
                    state.status = SessionStatusUI::Error(e.to_string());
                    return Ok(false); // Stop session on error
                }
            }
        })
        .launch(launch_command)
        .map_err(|e| Error::DebugLoop(e.to_string()))?;

    // Mark session as finished
    {
        let mut state = session_state.lock().unwrap();
        if !matches!(state.status, SessionStatusUI::Error(_)) {
            state.status = SessionStatusUI::Stopped;
            state.reset();
        }
        state.current_event = None;
    }

    // Emit final session update
    if let Some(ref handle) = app_handle {
        emit_session_event(&session_state, handle);
    }

    info!("Debug session {} finished", session_id);
    Ok(())
}




// Helper function to emit session-updated events
pub(crate) fn emit_session_event(
    session_state: &Arc<Mutex<SessionStateUI>>,
    app_handle: &AppHandle,
) {
    // Create a DebugSession snapshot from SessionState
    let debug_session = {
        let state = session_state.lock().unwrap();
        state.to_debug_session()
    };
    
    if let Err(e) = app_handle.emit("session-updated", &debug_session) {
        error!("Failed to emit session-updated event for {}: {}", debug_session.id, e);
    }
} 