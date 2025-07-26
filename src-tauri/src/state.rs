use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use crate::session::StepCommand;

// Serializable snapshot of session state for frontend communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSessionUI {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub status: SessionStatusUI,
    pub current_event: Option<DebugEventInfo>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionStatusUI {
    Created,
    Connecting,
    Connected,
    Running,
    Paused,
    Finished,
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
}

// Session state - the single source of truth for each session
pub struct SessionStateUI {
    // Session metadata
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub created_at: String,
    
    // Runtime state
    pub status: SessionStatusUI,
    pub events: Vec<joybug2::protocol_io::DebugEvent>,
    pub modules: Vec<joybug2::protocol_io::ModuleInfo>,
    pub threads: Vec<joybug2::protocol_io::ThreadInfo>,
    pub current_event: Option<joybug2::protocol_io::DebugEvent>,
    pub current_context: Option<SerializableThreadContext>,
    pub step_sender: Option<mpsc::Sender<StepCommand>>, // Send true to continue, false to stop
    pub step_receiver: Option<mpsc::Receiver<StepCommand>>,
    pub debug_result: Option<Result<(), String>>, // Track if debug session succeeded or failed
    
    // Auxiliary client for one-off commands
    pub aux_client: Option<Arc<Mutex<joybug2::protocol_io::DebugSession<()>>>>,
}

impl SessionStateUI {
    pub fn new(
        id: String,
        name: String,
        server_url: String,
        launch_command: String,
    ) -> Self {
        let (step_sender, step_receiver) = mpsc::channel();
        Self {
            id,
            name,
            server_url,
            launch_command,
            created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            status: SessionStatusUI::Created,
            events: Vec::new(),
            modules: Vec::new(),
            threads: Vec::new(),
            current_event: None,
            current_context: None,
            step_sender: Some(step_sender),
            step_receiver: Some(step_receiver),
            debug_result: None,
            aux_client: None,
        }
    }

    // Reset the state of a session to be ready for a new run
    pub fn reset(&mut self) {
        self.status = SessionStatusUI::Created;
        self.events.clear();
        self.modules.clear();
        self.threads.clear();
        self.current_event = None;
        self.current_context = None;
        self.debug_result = None;
        self.aux_client = None;

        let (step_sender, step_receiver) = mpsc::channel();
        self.step_sender = Some(step_sender);
        self.step_receiver = Some(step_receiver);
    }

    // Create a serializable snapshot of this session state
    pub fn to_debug_session(&self) -> DebugSessionUI {
        DebugSessionUI {
            id: self.id.clone(),
            name: self.name.clone(),
            server_url: self.server_url.clone(),
            launch_command: self.launch_command.clone(),
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
        }
    }
}

// Global state - now just holding session states, no duplicate session storage
pub type SessionStatesMap = Mutex<HashMap<String, Arc<Mutex<SessionStateUI>>>>;
pub type LogsState = Mutex<Vec<LogEntry>>;

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