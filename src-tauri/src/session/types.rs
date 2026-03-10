use crate::state::SessionStateUI;
use std::sync::{Arc, Mutex};

pub type DebugSession = joybug2::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>;

#[derive(Debug, Clone)]
pub enum UICommand {
    Go,
    GoPassException,
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
    DereferenceBatch{ addresses: Vec<u64> },
    Emulate {
        max_instructions: usize,
        mode: joybug2::protocol_io::EmulationMode,
        exit_condition: Option<joybug2::protocol_io::TraceExitCondition>,
        request_id: Option<String>,
        memory_reads: Vec<(u64, usize)>,
    },
    SetRegister { register_name: String, value: u64 },
    ToggleBreakpoint { address: u64 },
    RemoveBreakpoint { breakpoint_id: String },
    EnableBreakpoint { breakpoint_id: String, enabled: bool },
    EnableBreakpointGroup { group: String, enabled: bool },
    UpdateBreakpoint { breakpoint_id: String, name: Option<String>, group: Option<String> },
    SetHardwareBreakpoint { address: u64, hw_type: String, hw_size: u8 },
    GetThreadCallStack { tid: u32 },
    ResolveThreadSymbols,
    GetModuleExtraInfo { module_base: u64 },
    SearchMemory { pattern: Vec<u8>, max_results: usize },
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

/// Event payload for successful memory search
#[derive(serde::Serialize)]
pub struct MemorySearchResult {
    pub session_id: String,
    pub addresses: Vec<String>,
    pub capped: bool,
}

/// Event payload for memory search error
#[derive(serde::Serialize)]
pub struct MemorySearchError {
    pub session_id: String,
    pub error: String,
}

// Types that were in commands.rs but are produced by session's process_* functions

#[derive(serde::Serialize)]
pub struct SerializableInstruction {
    pub address: String,
    pub symbol: String,
    pub bytes: String,
    pub mnemonic: String,
    pub op_str: String,
    pub is_jump: bool,
    pub is_call: bool,
    pub is_ret: bool,
    pub jump_target: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct CallStackData {
    pub frame_number: usize,
    pub instruction_pointer: String,
    pub stack_pointer: String,
    pub frame_pointer: String,
    pub symbol_info: Option<String>,
}

#[derive(serde::Serialize)]
pub struct SymbolData {
    pub name: String,
    pub module_name: String,
    pub rva: u32,
    pub va: String,
    pub display_name: String,
    pub is_function: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct EmulationInstructionInfo {
    pub address: String,
    pub symbol: Option<String>,
    pub mnemonic: String,
    pub op_str: String,
}

#[derive(serde::Serialize)]
pub struct EmulationResultPayload {
    pub session_id: String,
    pub request_id: Option<String>,
    pub mode: String,
    pub final_pc: Option<String>,
    pub instructions_executed: usize,
    pub stop_reason: String,
    pub emulation_time_us: u64,
    pub pages_loaded: Option<usize>,
    pub basic_blocks: Vec<String>,
    pub trace_text: Option<String>,
    pub trace_time_us: Option<u64>,
    pub instruction_info: Vec<EmulationInstructionInfo>,
    pub stats_text: String,
    pub memory_snapshots: Vec<MemorySnapshotEntry>,
}

#[derive(serde::Serialize)]
pub struct MemorySnapshotEntry {
    pub address: String,
    pub data: Vec<u8>,
}
