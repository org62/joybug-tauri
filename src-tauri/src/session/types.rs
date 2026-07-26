use crate::state::SessionStateUI;
use std::sync::{Arc, Mutex};

pub type DebugSession = joybug_core::protocol_io::DebugSession<Arc<Mutex<SessionStateUI>>>;

#[derive(Debug, Clone)]
pub enum UICommand {
    Go,
    GoPassException,
    StepIn,
    StepOver,
    StepOut,
    StepOverLine,
    StepIntoLine,
    Stop,
    Detach,
    Disassembly{ arch: joybug_core::interfaces::Architecture, address: u64, count: u32, compare_image: bool },
    DisassembleFunction{ arch: joybug_core::interfaces::Architecture, address: u64, max_instructions: u32, compare_image: bool },
    DisassembleBackward{ arch: joybug_core::interfaces::Architecture, target: u64, count: u32, compare_image: bool },
    GetCallStack,
    SearchSymbols{ pattern: String, limit: u32 },
    ReadMemory{ address: u64, size: usize },
    WriteMemory{ address: u64, data: Vec<u8> },
    GetMemoryRegions,
    Dereference{ address: u64, count: usize },
    DereferenceBatch{ addresses: Vec<u64> },
    Emulate {
        max_instructions: usize,
        mode: joybug_core::protocol_io::EmulationMode,
        exit_condition: Option<joybug_core::protocol_io::TraceExitCondition>,
        request_id: Option<String>,
        memory_reads: Vec<(u64, usize)>,
    },
    SetRegister { register_name: String, value: u64 },
    ToggleBreakpoint { address: u64, single_shot: bool },
    SetBreakpoints { addresses: Vec<u64>, group: Option<String>, single_shot: bool },
    SyncAutoBreakpoints,
    RemoveBreakpoint { breakpoint_id: String },
    RemoveBreakpoints { breakpoint_ids: Vec<String> },
    EnableBreakpoint { breakpoint_id: String, enabled: bool },
    EnableBreakpointGroup { group: String, enabled: bool },
    UpdateBreakpoint { breakpoint_id: String, name: Option<String>, group: Option<String> },
    SetHardwareBreakpoint { address: u64, hw_type: String, hw_size: u8 },
    StartWatchpointTrace { address: u64, hw_type: String, hw_size: u8 },
    StopWatchpointTrace { breakpoint_id: String },
    // `preview` marks a hover-preview fetch (Threads popover); the Call Stack
    // panel only follows non-preview (explicit selection) results.
    GetThreadCallStack { tid: u32, preview: bool },
    ResolveThreadSymbols,
    GetModuleExtraInfo { module_base: u64 },
    ResolveAddressToLine { address: u64 },
    GetSourceFileLineMap { module_base: u64, file_path: String, start_line: Option<u32>, end_line: Option<u32> },
    ListSourceFiles { module_base: u64 },
    SearchMemory { pattern: Vec<u8>, max_results: usize },
    AssemblePatch { address: u64, assembly_text: String, arch: joybug_core::interfaces::Architecture, nop_pad: bool },
    UndoPatch { patch_id: String },
    UndoPatches { patch_ids: Vec<String> },
    EnablePatch { patch_id: String, enabled: bool },
    UpdatePatch { patch_id: String, group: Option<String> },
    EnablePatchGroup { group: String, enabled: bool },
    /// Restore original on-disk image bytes for the modified run containing
    /// `address` (used when the diff wasn't created by a tracked UI patch).
    RestoreImageBytes { address: u64 },
    /// Diff every loaded module's executable sections against its on-disk
    /// image and emit the modified runs (the Image Patches window).
    ScanImagePatches,
    AddBookmark {
        kind: String,
        address: u64,
        value_type: Option<String>,
        name: Option<String>,
        comment: Option<String>,
        pointer_offsets: Option<Vec<u64>>,
        base_symbol: Option<String>,
        asm_text: Option<String>,
    },
    RemoveBookmark { id: String },
    RemoveBookmarks { ids: Vec<String> },
    UpdateBookmark {
        id: String,
        name: Option<String>,
        comment: Option<String>,
        group: Option<String>,
        value_type: Option<String>,
    },
    SetBookmarkValue { id: String, value: String },
    ToggleBookmarkLock { id: String, locked: bool },
    RefreshBookmarks,
}

impl UICommand {
    /// Commands whose handler resumes target execution
    /// (returns `CommandResult::ResumeExecution`). Keep in sync when adding a
    /// stepping/continue variant — batch pruning in `dispatch::dedup_commands`
    /// derives from this.
    pub(crate) fn is_resume(&self) -> bool {
        matches!(
            self,
            UICommand::Go
                | UICommand::GoPassException
                | UICommand::StepIn
                | UICommand::StepOver
                | UICommand::StepOut
                | UICommand::StepOverLine
                | UICommand::StepIntoLine
        )
    }
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

/// One annotation on a memory region ("what lives here").
#[derive(serde::Serialize, Clone)]
pub struct RegionAnnotation {
    /// "module" | "section" | "teb" | "peb" | "heap" | "stack" | "kuser"
    pub kind: String,
    pub label: String,
    /// Exact address of the annotated structure (TEB/PEB/heap base, section
    /// start, ...), when it has one — lets the UI link a badge to the typed
    /// view at that address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
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
    pub annotations: Vec<RegionAnnotation>,
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
    /// Every symbol starting exactly at this address, formatted "module!name".
    /// Usually 0 or 1, but aliases (e.g. NtClose/ZwClose) share an address — the
    /// frontend renders one label row per entry. Empty when not at a symbol start;
    /// the first column always shows the address.
    pub symbols: Vec<String>,
    pub bytes: String,
    pub mnemonic: String,
    pub op_str: String,
    pub is_jump: bool,
    pub is_call: bool,
    pub is_ret: bool,
    pub jump_target: Option<String>,
    pub is_patched: bool,
    /// When the in-memory bytes differ from the original on-disk image, the
    /// space-separated hex of the original image bytes covering this row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_bytes: Option<String>,
    /// Disassembly of the original image bytes at this address (may span more
    /// than one instruction if the patch changed instruction boundaries),
    /// joined with "; ". Shown on hover over a patched row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_disasm: Option<String>,
    pub source_file: Option<String>,
    pub source_line: Option<u32>,
    /// True for a synthetic `db 0xXX` row emitted where a byte couldn't be
    /// decoded — the frontend renders these in an error style.
    pub is_invalid: bool,
}

/// One contiguous run of in-memory code bytes differing from the on-disk
/// image (the Image Patches window). Addresses are hex strings so 64-bit
/// values survive the trip to JavaScript without precision loss.
#[derive(serde::Serialize)]
pub struct ImagePatchEntry {
    pub address: String,
    /// Lowercased module short name (e.g. "ntdll.dll").
    pub module: String,
    pub rva: String,
    /// Nearest preceding symbol as "module!name+0xoff", if resolvable.
    pub symbol: Option<String>,
    /// Space-separated hex of the original on-disk bytes for this run.
    pub original_bytes: String,
    /// Space-separated hex of the current in-memory bytes for this run.
    pub current_bytes: String,
    /// Disassembly of the original bytes, instructions joined with "; ".
    pub original_disasm: String,
    /// Disassembly of the current bytes, instructions joined with "; ".
    pub current_disasm: String,
    /// True when the run overlaps a tracked (user-assembled) patch.
    pub tracked: bool,
}

/// Event payload for a completed image-patch scan.
#[derive(serde::Serialize)]
pub struct ImagePatchesResult {
    pub session_id: String,
    pub patches: Vec<ImagePatchEntry>,
    /// True when scanning stopped early because the entry cap was hit.
    pub capped: bool,
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

#[derive(serde::Serialize)]
pub struct ScanMatchResult {
    pub session_id: String,
    pub scan_id: u64,
    pub match_count: u64,
    pub scan_time_us: u64,
}

#[derive(serde::Serialize)]
pub struct ScanResultsPayload {
    pub session_id: String,
    pub scan_id: u64,
    pub addresses: Vec<String>,
    pub values: Vec<ScanValueEntry>,
    pub total_count: u64,
}

#[derive(serde::Serialize)]
pub struct ScanValueEntry {
    pub value_type: String,
    pub display: String,
}

#[derive(serde::Serialize)]
pub struct ScanError {
    pub session_id: String,
    pub error: String,
}

/// Event payload for a started pointer scan.
#[derive(serde::Serialize)]
pub struct PointerScanStartResult {
    pub session_id: String,
    pub results_path: String,
    pub match_count: u64,
    pub scan_time_us: u64,
}

/// A single pointer path, with all addresses formatted as hex strings so 64-bit
/// values survive the trip to JavaScript without precision loss.
#[derive(serde::Serialize)]
pub struct PointerPathEntry {
    pub module_index: i32,
    pub module_base: String,
    pub base_offset: String,
    /// Symbolized static base ("module!name+0xoff"), if resolvable.
    pub base_symbol: Option<String>,
    pub offsets: Vec<String>,
    pub resolved: String,
}

/// Event payload for a page of pointer scan results.
#[derive(serde::Serialize)]
pub struct PointerScanResultsPayload {
    pub session_id: String,
    pub results_path: String,
    pub paths: Vec<PointerPathEntry>,
    pub total_count: u64,
}

/// Event payload for a started string scan.
#[derive(serde::Serialize)]
pub struct StringScanStartResult {
    pub session_id: String,
    pub results_path: String,
    pub match_count: u64,
    pub scan_time_us: u64,
    /// True if more strings existed than the cap; only the first are stored.
    pub capped: bool,
}

/// A single discovered string. `address` is a hex string so 64-bit values survive
/// the trip to JavaScript without precision loss.
#[derive(serde::Serialize)]
pub struct StringEntry {
    pub address: String,
    pub encoding: String,
    pub length: u32,
    pub text: String,
    pub truncated: bool,
}

/// Event payload for a page of string scan results.
#[derive(serde::Serialize)]
pub struct StringScanResultsPayload {
    pub session_id: String,
    pub results_path: String,
    pub strings: Vec<StringEntry>,
    pub total_count: u64,
}
