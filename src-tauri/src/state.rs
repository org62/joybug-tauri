use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use crate::session::UICommand;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakpointInfo {
    pub id: String,              // UUID
    pub address: u64,            // current resolved absolute address (0 if unresolved)
    pub module_name: String,     // e.g. "ntdll.dll" (lowercase for matching)
    pub module_offset: u64,      // RVA within module
    pub name: Option<String>,    // user-assigned label
    pub group: Option<String>,   // group name
    pub symbol: Option<String>,  // resolved symbol e.g. "kernel32!CreateFileW+0x10"
    pub enabled: bool,           // user toggle
    pub is_active: bool,         // currently set in debuggee
    #[serde(default = "default_bp_kind")]
    pub bp_kind: String,           // "software" | "hardware"
    #[serde(default)]
    pub hw_type: Option<String>,   // "Execute" | "Write" | "ReadWrite"
    #[serde(default)]
    pub hw_size: Option<u8>,       // 1, 2, 4, 8
    #[serde(default)]
    pub source_file: Option<String>, // resolved source file (display only)
    #[serde(default)]
    pub source_line: Option<u32>,    // resolved source line (display only)
}

fn default_bp_kind() -> String {
    "software".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchInfo {
    pub id: String,                    // UUID
    pub address: u64,                  // resolved absolute address (0 if unresolved)
    pub module_name: String,           // lowercase module short name
    pub module_offset: u64,            // RVA within module
    pub original_bytes: Vec<u8>,       // saved for undo
    pub patched_bytes: Vec<u8>,        // assembled result
    pub assembly_text: String,         // what the user typed
    pub original_disassembly: String,  // "mov eax, ebx" — for display
    pub enabled: bool,                 // user toggle
    pub is_applied: bool,              // currently written in debuggee
    #[serde(default)]
    pub group: Option<String>,         // group name
}

/// A persisted bookmark: a typed/named memory cell (Cheat-Engine style), a
/// pointer chain, or a code annotation. Keyed per target by launch_command, like
/// breakpoints and patches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookmarkInfo {
    pub id: String,                          // UUID (regenerated on load)
    pub kind: String,                        // "value" | "pointer" | "code"
    // Base address: module-relative preferred, raw fallback (like pins/breakpoints).
    pub module_name: Option<String>,         // lowercased short name incl. extension
    pub module_offset: Option<u64>,          // RVA within module
    pub raw_address: Option<String>,         // "0x..." when not in a module
    // Metadata
    pub name: Option<String>,                // user label
    pub comment: Option<String>,             // user comment (esp. "code" kind)
    pub group: Option<String>,               // group name
    pub value_type: Option<String>,          // "U8".."F64" for value/pointer kinds
    // Pointer-chain kind
    #[serde(default)]
    pub pointer_offsets: Option<Vec<u64>>,   // chain offsets (base -> target)
    #[serde(default)]
    pub base_symbol: Option<String>,         // "module!sym+0x10" (display only)
    // Code kind
    #[serde(default)]
    pub asm_text: Option<String>,            // snapshot of the instruction line
    // Lock / freeze (server-side)
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub locked_value: Option<String>,        // value kept frozen while locked
    // Runtime only: server-side freeze handle while locked (not persisted).
    #[serde(skip, default)]
    pub freeze_id: Option<u64>,
}

/// Frontend-facing bookmark with live resolution data. Sent in the session
/// snapshot and in `bookmarks-updated` events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedBookmark {
    pub id: String,
    pub kind: String,
    pub module_name: Option<String>,
    pub module_offset: Option<u64>,
    pub raw_address: Option<String>,
    pub name: Option<String>,
    pub comment: Option<String>,
    pub group: Option<String>,
    pub value_type: Option<String>,
    pub pointer_offsets: Option<Vec<u64>>,
    pub base_symbol: Option<String>,
    pub asm_text: Option<String>,
    pub locked: bool,
    pub resolved_address: String,            // "0x.." | "mod+0x.." | ""
    pub is_resolved: bool,
    pub current_value: Option<String>,       // live read + formatted (None until refreshed)
}

/// Resolve a bookmark's static base address from the loaded modules (no pointer
/// chain following — that needs a live client). Shared by the initial snapshot
/// (`to_resolved_static`) and the live emit path in `session::bookmarks`.
pub(crate) fn bookmark_static_address(
    bm: &BookmarkInfo,
    modules: &[joybug2::protocol_io::ModuleInfo],
) -> Option<u64> {
    if let (Some(name), Some(offset)) = (&bm.module_name, bm.module_offset) {
        // Bookmarks store the module stem (no extension); match on that.
        let want = name.to_lowercase();
        modules
            .iter()
            .find(|m| crate::session::helpers::extract_module_name(&m.name).to_lowercase() == want)
            .map(|m| m.base + offset)
    } else if let Some(raw) = &bm.raw_address {
        u64::from_str_radix(raw.trim_start_matches("0x").trim_start_matches("0X"), 16).ok()
    } else {
        None
    }
}

impl ResolvedBookmark {
    /// Build a `ResolvedBookmark` from its source bookmark, the resolved absolute
    /// address (if any), and an optional live value. Single source of truth for
    /// the field mapping and the `resolved_address` fallback formatting.
    pub(crate) fn build(
        bm: &BookmarkInfo,
        addr: Option<u64>,
        current_value: Option<String>,
    ) -> Self {
        let resolved_address = match addr {
            Some(a) => format!("0x{:X}", a),
            None => match (&bm.module_name, bm.module_offset) {
                (Some(n), Some(off)) => format!("{}+0x{:X}", n, off),
                _ => bm.raw_address.clone().unwrap_or_default(),
            },
        };
        ResolvedBookmark {
            id: bm.id.clone(),
            kind: bm.kind.clone(),
            module_name: bm.module_name.clone(),
            module_offset: bm.module_offset,
            raw_address: bm.raw_address.clone(),
            name: bm.name.clone(),
            comment: bm.comment.clone(),
            group: bm.group.clone(),
            value_type: bm.value_type.clone(),
            pointer_offsets: bm.pointer_offsets.clone(),
            base_symbol: bm.base_symbol.clone(),
            asm_text: bm.asm_text.clone(),
            locked: bm.locked,
            resolved_address,
            is_resolved: addr.is_some(),
            current_value,
        }
    }
}

impl BookmarkInfo {
    /// Build a snapshot ResolvedBookmark using only the module list (no memory
    /// reads). Value-kind addresses resolve here; pointer chains resolve later on
    /// a live refresh.
    pub fn to_resolved_static(&self, modules: &[joybug2::protocol_io::ModuleInfo]) -> ResolvedBookmark {
        // Pointer bookmarks need a live chain walk, so they aren't "resolved" here.
        let resolved = if self.kind == "pointer" {
            None
        } else {
            bookmark_static_address(self, modules)
        };
        ResolvedBookmark::build(self, resolved, None)
    }
}

// Serializable snapshot of session state for frontend communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSessionUI {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub working_directory: Option<String>,
    pub is_local_run: bool,
    /// When set, this session attaches to an already-running process (by PID)
    /// instead of launching `launch_command`.
    pub attach_pid: Option<u32>,
    /// When true, this session opens the target non-invasively (no debugger attach).
    pub non_invasive: bool,
    pub status: SessionStatusUI,
    pub current_event: Option<DebugEventInfo>,
    pub created_at: String,
    pub disassembly_window_open: bool,
    pub registers_window_open: bool,
    pub callstack_window_open: bool,
    pub breakpoints: Vec<BreakpointInfo>,
    pub patches: Vec<PatchInfo>,
    pub bookmarks: Vec<ResolvedBookmark>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionStatusUI {
    Stopped,
    Running,
    Paused,
    /// Non-invasive session: the target process is opened (by PID) for
    /// memory/enumeration operations but never attached with a debugger, so
    /// there is no debug loop and no run/step/continue.
    Open,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Serializablex64ThreadContext {
    pub rax: String, pub rbx: String, pub rcx: String, pub rdx: String,
    pub rsi: String, pub rdi: String, pub rbp: String, pub rsp: String,
    pub rip: String,
    pub r8: String, pub r9: String, pub r10: String, pub r11: String,
    pub r12: String, pub r13: String, pub r14: String, pub r15: String,
    pub eflags: String,
    // 128-bit XMM registers, formatted "0x" + 32 hex digits (high 64 bits then low).
    pub xmm0: String, pub xmm1: String, pub xmm2: String, pub xmm3: String,
    pub xmm4: String, pub xmm5: String, pub xmm6: String, pub xmm7: String,
    pub xmm8: String, pub xmm9: String, pub xmm10: String, pub xmm11: String,
    pub xmm12: String, pub xmm13: String, pub xmm14: String, pub xmm15: String,
    // Debug registers (64-bit hex): DR0-DR3 address slots, DR6 status, DR7 control.
    pub dr0: String, pub dr1: String, pub dr2: String, pub dr3: String,
    pub dr6: String, pub dr7: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SerializableArm64ThreadContext {
    // General purpose registers
    pub x0: String, pub x1: String, pub x2: String, pub x3: String,
    pub x4: String, pub x5: String, pub x6: String, pub x7: String,
    pub x8: String, pub x9: String, pub x10: String, pub x11: String,
    pub x12: String, pub x13: String, pub x14: String, pub x15: String,
    pub x16: String, pub x17: String, pub x18: String, pub x19: String,
    pub x20: String, pub x21: String, pub x22: String, pub x23: String,
    pub x24: String, pub x25: String, pub x26: String, pub x27: String,
    pub x28: String, pub x29: String, pub x30: String,
    
    // Stack pointer and program counter
    pub sp: String,
    pub pc: String,
    
    // Processor state
    pub cpsr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "arch")]
pub enum SerializableThreadContext {
    X64(Serializablex64ThreadContext),
    Arm64(SerializableArm64ThreadContext),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugEventInfo {
    pub event_type: String,
    pub process_id: u32,
    pub thread_id: u32,
    pub details: String,
    pub can_continue: bool,
    pub address: Option<u64>,
    pub context: Option<SerializableThreadContext>,
    pub exception_code: Option<u32>,
    pub exception_first_chance: Option<bool>,
}

// Session state - the single source of truth for each session
pub struct SessionStateUI {
    // Session metadata
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub working_directory: Option<String>,
    pub is_local_run: bool,
    /// When set, the session attaches to this already-running PID instead of
    /// launching `launch_command`.
    pub attach_pid: Option<u32>,
    /// When true, the session opens the target process non-invasively
    /// (`OpenProcess` only, no `DebugActiveProcess`/debug loop).
    pub non_invasive: bool,
    /// The live PID a non-invasive session is operating on, resolved at start.
    /// Used as the OOB pid source when there is no `current_event`.
    pub open_pid: Option<u32>,
    pub embedded_server_port: Option<u16>,
    pub created_at: String,

    // Runtime state
    pub status: SessionStatusUI,
    pub events: Vec<joybug2::protocol_io::DebugEvent>,
    pub modules: Vec<joybug2::protocol_io::ModuleInfo>,
    pub threads: Vec<joybug2::protocol_io::ThreadInfo>,
    pub current_event: Option<joybug2::protocol_io::DebugEvent>,
    pub current_context: Option<SerializableThreadContext>,
    pub ui_sender: Option<mpsc::Sender<UICommand>>, // Send true to continue, false to stop
    pub ui_receiver: Option<mpsc::Receiver<UICommand>>,
    pub debug_result: Option<Result<(), String>>, // Track if debug session succeeded or failed
    
    // Window/Tab states
    pub is_disassembly_window_open: bool,
    pub is_registers_window_open: bool,
    pub is_callstack_window_open: bool,

    // Breakpoints
    pub breakpoints: Vec<BreakpointInfo>,

    // Patches
    pub patches: Vec<PatchInfo>,

    // Bookmarks
    pub bookmarks: Vec<BookmarkInfo>,

    // Exception handling
    pub pass_exception_on_continue: bool,

    /// In-progress source-line step. When set, the debug loop keeps single-stepping
    /// (auto-continuing without pausing the UI) until the PC leaves the starting
    /// source line, then clears this and pauses. `None` = normal instruction stepping.
    pub source_step: Option<SourceStepState>,
}

/// Transient state for an active source-line step (see SessionStateUI::source_step).
#[derive(Debug, Clone)]
pub struct SourceStepState {
    pub kind: joybug2::protocol::StepKind,
    /// Starting (file, line); `None` when the start had no line info (degrades to
    /// a single instruction step).
    pub start: Option<(String, u32)>,
    pub count: u32,
}

impl SessionStateUI {
    pub fn new(
        id: String,
        name: String,
        server_url: String,
        launch_command: String,
        working_directory: Option<String>,
        is_local_run: bool,
        attach_pid: Option<u32>,
        non_invasive: bool,
    ) -> Self {
        let (step_sender, step_receiver) = mpsc::channel();
        Self {
            id,
            name,
            server_url,
            launch_command,
            working_directory,
            is_local_run,
            attach_pid,
            non_invasive,
            open_pid: None,
            embedded_server_port: None,
            created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            status: SessionStatusUI::Stopped,
            events: Vec::new(),
            modules: Vec::new(),
            threads: Vec::new(),
            current_event: None,
            current_context: None,
            ui_sender: Some(step_sender),
            ui_receiver: Some(step_receiver),
            debug_result: None,
            is_disassembly_window_open: false,
            is_registers_window_open: false,
            is_callstack_window_open: false,
            breakpoints: Vec::new(),
            patches: Vec::new(),
            bookmarks: Vec::new(),
            pass_exception_on_continue: false,
            source_step: None,
        }
    }

    // Reset the state of a session to be ready for a new run
    pub fn reset(&mut self) {
        self.events.clear();
        self.modules.clear();
        self.threads.clear();
        self.current_event = None;
        self.current_context = None;
        self.debug_result = None;
        self.open_pid = None;
        self.embedded_server_port = None;

        // Reset window states
        self.is_disassembly_window_open = false;
        self.is_registers_window_open = false;
        self.is_callstack_window_open = false;

        self.pass_exception_on_continue = false;
        self.source_step = None;

        // Keep breakpoints but mark all as inactive/unresolved
        for bp in &mut self.breakpoints {
            bp.is_active = false;
            bp.address = 0;
        }

        // Keep patches but mark all as unapplied/unresolved
        for patch in &mut self.patches {
            patch.is_applied = false;
            patch.address = 0;
        }

        // Keep bookmarks but drop stale server-side freeze handles (the freeze
        // threads die with the previous run's server connection).
        for bm in &mut self.bookmarks {
            bm.freeze_id = None;
        }

        let (step_sender, step_receiver) = mpsc::channel();
        self.ui_sender = Some(step_sender);
        self.ui_receiver = Some(step_receiver);
    }

    // Create a serializable snapshot of this session state
    pub fn to_debug_session(&self) -> DebugSessionUI {
        DebugSessionUI {
            id: self.id.clone(),
            name: self.name.clone(),
            server_url: self.server_url.clone(),
            launch_command: self.launch_command.clone(),
            working_directory: self.working_directory.clone(),
            is_local_run: self.is_local_run,
            attach_pid: self.attach_pid,
            non_invasive: self.non_invasive,
            status: self.status.clone(),
            current_event: self.current_event.as_ref().map(|event| {
                let mut info = crate::events::debug_event_to_info(event);
                info.context = self.current_context.clone();
                
                // If address is missing from the event, try to get it from the context's instruction pointer
                if info.address.is_none() {
                    match &self.current_context {
                        Some(SerializableThreadContext::X64(ref ctx)) => {
                            if let Ok(rip) = u64::from_str_radix(&ctx.rip.trim_start_matches("0x"), 16) {
                                info.address = Some(rip);
                            }
                        }
                        Some(SerializableThreadContext::Arm64(ref ctx)) => {
                            if let Ok(pc) = u64::from_str_radix(&ctx.pc.trim_start_matches("0x"), 16) {
                                info.address = Some(pc);
                            }
                        }
                        None => {}
                    }
                }
                info
            }),
            created_at: self.created_at.clone(),
            disassembly_window_open: self.is_disassembly_window_open,
            registers_window_open: self.is_registers_window_open,
            callstack_window_open: self.is_callstack_window_open,
            breakpoints: self.breakpoints.clone(),
            patches: self.patches.clone(),
            bookmarks: self
                .bookmarks
                .iter()
                .map(|bm| bm.to_resolved_static(&self.modules))
                .collect(),
        }
    }
}

// Global state - now just holding session states, no duplicate session storage
pub type SessionStatesMap = Mutex<HashMap<String, Arc<Mutex<SessionStateUI>>>>;
pub type LogsState = Mutex<Vec<LogEntry>>;
pub type EmbeddedServersMap = Mutex<HashMap<String, joybug2::local_server::LocalServer>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub session_id: Option<String>,
}

impl LogEntry {
    pub fn new(level: &str, message: &str, session_id: Option<String>) -> Self {
        Self {
            timestamp: chrono::Utc::now()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
            level: level.to_string(),
            message: message.to_string(),
            session_id,
        }
    }
} 