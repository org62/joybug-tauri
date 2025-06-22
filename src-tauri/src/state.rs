use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use joybug2::protocol_io::DebugClient;

// Serializable snapshot of session state for frontend communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSession {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub status: SessionStatus,
    pub current_event: Option<DebugEventInfo>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionStatus {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "arch")]
pub enum SerializableThreadContext {
    X64(Serializablex64ThreadContext),
    Arm64, // Placeholder for future use
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
pub struct SessionState {
    // Session metadata
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub launch_command: String,
    pub created_at: String,
    
    // Runtime state
    pub status: SessionStatus,
    pub events: Vec<joybug2::protocol_io::DebugEvent>,
    pub modules: Vec<joybug2::protocol_io::ModuleInfo>,
    pub threads: Vec<joybug2::protocol_io::ThreadInfo>,
    pub current_event: Option<joybug2::protocol_io::DebugEvent>,
    pub current_context: Option<SerializableThreadContext>,
    pub step_sender: Option<mpsc::Sender<bool>>, // Send true to continue, false to stop
    pub step_receiver: Option<mpsc::Receiver<bool>>,
    pub debug_result: Option<Result<(), String>>, // Track if debug session succeeded or failed
    
    // Auxiliary client for one-off commands
    pub aux_client: Option<Arc<Mutex<DebugClient>>>,
}

impl SessionState {
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
            status: SessionStatus::Created,
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

    // Create a serializable snapshot of this session state
    pub fn to_debug_session(&self) -> DebugSession {
        DebugSession {
            id: self.id.clone(),
            name: self.name.clone(),
            server_url: self.server_url.clone(),
            launch_command: self.launch_command.clone(),
            status: self.status.clone(),
            current_event: self.current_event.as_ref().map(|event| {
                let mut info = crate::events::debug_event_to_info(event);
                info.context = self.current_context.clone();
                
                // If address is missing from the event, try to get it from the context's RIP
                if info.address.is_none() {
                    if let Some(SerializableThreadContext::X64(ref ctx)) = self.current_context {
                        if let Ok(rip) = u64::from_str_radix(&ctx.rip.trim_start_matches("0x"), 16) {
                            info.address = Some(rip);
                        }
                    }
                }
                info
            }),
            created_at: self.created_at.clone(),
        }
    }
}

// Global state - now just holding session states, no duplicate session storage
pub type SessionStatesMap = Mutex<HashMap<String, Arc<Mutex<SessionState>>>>;
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