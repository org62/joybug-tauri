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
    pub bp_kind: String,           // "software" | "hardware" | "watchpoint"
    #[serde(default)]
    pub hw_type: Option<String>,   // "Execute" | "Write" | "ReadWrite"
    #[serde(default)]
    pub hw_size: Option<u8>,       // 1, 2, 4, 8
    #[serde(default)]
    pub source_file: Option<String>, // resolved source file (display only)
    #[serde(default)]
    pub source_line: Option<u32>,    // resolved source line (display only)
    /// Auto-planted (module entry / TLS callback) breakpoint driven by a settings
    /// toggle. Not persisted to disk — regenerated per run on module load.
    #[serde(default)]
    pub auto: bool,
    /// One-shot breakpoint: armed via `set_single_shot_breakpoint_at`; the server
    /// auto-removes it on first hit (we drop the row when the hit event arrives).
    /// Session-only — never persisted to disk.
    #[serde(default)]
    pub single_shot: bool,
    /// Identity ("size:mtime_ns") of the module's on-disk file when this
    /// breakpoint was created/armed. A rebuilt binary changes it, meaning the
    /// stored RVA may land mid-instruction — such breakpoints are auto-disabled
    /// on reapply instead of being armed at a wrong location. None when the
    /// file wasn't inspectable (remote target, pre-existing entries).
    #[serde(default)]
    pub module_fingerprint: Option<String>,
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

/// A manually-loaded PDB for a module, remembered per target so a restart
/// re-applies it automatically. Keyed by module short name (base changes with
/// ASLR), like breakpoints and patches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolOverrideInfo {
    pub module_name: String, // lowercased module short name (incl. extension)
    pub pdb_path: String,    // user-chosen PDB file path
    pub force: bool,         // loaded despite a GUID/age mismatch ("Load anyway")
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
    modules: &[joybug_core::protocol_io::ModuleInfo],
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
    pub fn to_resolved_static(&self, modules: &[joybug_core::protocol_io::ModuleInfo]) -> ResolvedBookmark {
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

    // NEON/SIMD & floating-point state. V0-V31 are 128-bit vector registers,
    // formatted as "0x" + 32 hex digits (high 64 bits then low 64) to match the
    // x64 XMM encoding the frontend's lane decoder expects. Fpcr/Fpsr are the
    // floating-point control/status registers.
    #[serde(default)] pub v0: String, #[serde(default)] pub v1: String,
    #[serde(default)] pub v2: String, #[serde(default)] pub v3: String,
    #[serde(default)] pub v4: String, #[serde(default)] pub v5: String,
    #[serde(default)] pub v6: String, #[serde(default)] pub v7: String,
    #[serde(default)] pub v8: String, #[serde(default)] pub v9: String,
    #[serde(default)] pub v10: String, #[serde(default)] pub v11: String,
    #[serde(default)] pub v12: String, #[serde(default)] pub v13: String,
    #[serde(default)] pub v14: String, #[serde(default)] pub v15: String,
    #[serde(default)] pub v16: String, #[serde(default)] pub v17: String,
    #[serde(default)] pub v18: String, #[serde(default)] pub v19: String,
    #[serde(default)] pub v20: String, #[serde(default)] pub v21: String,
    #[serde(default)] pub v22: String, #[serde(default)] pub v23: String,
    #[serde(default)] pub v24: String, #[serde(default)] pub v25: String,
    #[serde(default)] pub v26: String, #[serde(default)] pub v27: String,
    #[serde(default)] pub v28: String, #[serde(default)] pub v29: String,
    #[serde(default)] pub v30: String, #[serde(default)] pub v31: String,
    #[serde(default)] pub fpcr: String,
    #[serde(default)] pub fpsr: String,
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
    pub events: Vec<joybug_core::protocol_io::DebugEvent>,
    pub modules: Vec<joybug_core::protocol_io::ModuleInfo>,
    pub threads: Vec<joybug_core::protocol_io::ThreadInfo>,
    pub current_event: Option<joybug_core::protocol_io::DebugEvent>,
    pub current_context: Option<SerializableThreadContext>,
    pub ui_sender: Option<mpsc::Sender<UICommand>>, // Send true to continue, false to stop
    pub ui_receiver: Option<mpsc::Receiver<UICommand>>,
    pub debug_result: Option<Result<(), String>>, // Track if debug session succeeded or failed
    /// Join handle of the debug-loop thread while one is running. Taken by
    /// restart so it can wait for the old loop to fully unwind before starting
    /// the next run (starting early races the old thread's final status write).
    pub debug_loop_handle: Option<std::thread::JoinHandle<()>>,
    /// In-memory mirror of this target's persisted failed-symbols list, lazily
    /// loaded on first use. The status poll runs every second; diffing against
    /// this keeps it off the disk entirely except on real transitions. Not
    /// cleared on stop — the store is per-target, so the mirror stays valid
    /// across runs. All access goes through `session::symbols`.
    pub failed_symbols_cache: Option<Vec<String>>,
    
    // Window/Tab states
    pub is_disassembly_window_open: bool,
    pub is_registers_window_open: bool,
    pub is_callstack_window_open: bool,

    // Breakpoints
    pub breakpoints: Vec<BreakpointInfo>,

    // Patches
    pub patches: Vec<PatchInfo>,
    /// Bumped on every view-affecting patch change (apply/undo/enable/update,
    /// module reapply/deactivate, image-byte restore) and carried in the
    /// `patches-updated` event. The runner re-broadcasts that event on every
    /// pause with an unchanged list; listeners that do expensive work (the
    /// assembly view's full re-decode) refresh only when this changes.
    pub patches_revision: u64,

    // Manually-loaded PDBs, re-applied per module on (re)start.
    pub symbol_overrides: Vec<SymbolOverrideInfo>,

    // Bookmarks
    pub bookmarks: Vec<BookmarkInfo>,

    // Exception handling
    pub pass_exception_on_continue: bool,

    /// In-progress source-line step. When set, the debug loop keeps single-stepping
    /// (auto-continuing without pausing the UI) until the PC leaves the starting
    /// source line, then clears this and pauses. `None` = normal instruction stepping.
    pub source_step: Option<SourceStepState>,

    /// Lazily-built original on-disk images per module base, used to flag
    /// in-memory code that differs from the file (patch detection). Cleared on
    /// session restart; entries dropped on module unload. See `session::image_cache`.
    pub original_images: HashMap<u64, Arc<crate::session::image_cache::OriginalModuleImage>>,

    /// Caches for memory-region annotation (PE sections per module, PEB
    /// address, per-thread TEB/stack bounds). Pruned against the live
    /// module/thread lists on every regions refresh; cleared on restart
    /// (addresses change with ASLR).
    pub region_annotation_cache: crate::session::region_annotations::RegionAnnotationCache,
}

/// Transient state for an active source-line step (see SessionStateUI::source_step).
#[derive(Debug, Clone)]
pub struct SourceStepState {
    pub kind: joybug_core::protocol::StepKind,
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
            debug_loop_handle: None,
            failed_symbols_cache: None,
            is_disassembly_window_open: false,
            is_registers_window_open: false,
            is_callstack_window_open: false,
            breakpoints: Vec::new(),
            patches: Vec::new(),
            patches_revision: 0,
            symbol_overrides: Vec::new(),
            bookmarks: Vec::new(),
            pass_exception_on_continue: false,
            source_step: None,
            original_images: HashMap::new(),
            region_annotation_cache: Default::default(),
        }
    }

    /// Free every per-run runtime resource: event/module/thread lists, the
    /// original-image and region-annotation caches (both can hold many MB), and
    /// stale server-side freeze handles. Called on stop (so a stopped session
    /// holds no memory for a dead target) and as part of `reset()`.
    pub fn clear_runtime_caches(&mut self) {
        self.events.clear();
        self.modules.clear();
        self.threads.clear();
        self.current_event = None;
        self.current_context = None;
        self.open_pid = None;
        self.embedded_server_port = None;

        self.pass_exception_on_continue = false;
        self.source_step = None;

        // Original-image cache is per-run (load bases change with ASLR).
        self.original_images.clear();
        self.region_annotation_cache = Default::default();

        // Keep bookmarks but drop stale server-side freeze handles (the freeze
        // threads die with the run's server connection).
        for bm in &mut self.bookmarks {
            bm.freeze_id = None;
        }
    }

    // Reset the state of a session to be ready for a new run
    pub fn reset(&mut self) {
        self.clear_runtime_caches();
        self.debug_result = None;

        // Reset window states
        self.is_disassembly_window_open = false;
        self.is_registers_window_open = false;
        self.is_callstack_window_open = false;

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
pub type EmbeddedServersMap = Mutex<HashMap<String, joybug_core::local_server::LocalServer>>;

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