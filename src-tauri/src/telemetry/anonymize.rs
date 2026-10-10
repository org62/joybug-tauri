//! The telemetry wire format, and the one place that decides what a record may
//! say about the user's target.
//!
//! Everything that leaves the process — to the collector or to the local
//! file — is a [`Line`] built here. The rules:
//!
//! * A span is a name from our own source, a duration and numbers. Never a
//!   string from the target.
//! * A module is its index in the run's module table. The table names a
//!   module only when it lives in the OS's system directories (`ntdll.dll`,
//!   `libc.so.6`); any other module is a salted hash of its file name, with a
//!   salt that lives for one app run — enough to tell two modules apart inside
//!   a report, useless for recognising a module across reports.
//! * A session is a salted hash of its id, for the same reason.
//! * Nothing else: no paths, addresses, symbol names, command lines, register
//!   or memory contents, exception text.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use joybug_core::perf::PerfRecord;

pub const WIRE_VERSION: u32 = 1;

/// Core's attribute naming the module a span was about (see `perf::path_key`).
/// Translated to `module` (a table index) or dropped; never forwarded.
const MODULE_KEY_ATTR: &str = "module_key";

/// One line of a report (an NDJSON line in the file, an element of a batch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Line {
    Run(RunInfo),
    Session(SessionLine),
    Settings(SettingsLine),
    Module(ModuleLine),
    Span(SpanLine),
    /// Spans lost because the recorder's queue was full.
    Dropped { t: u64, count: u64 },
}

/// The app run a report belongs to. `run` is random per process start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunInfo {
    pub v: u32,
    pub run: String,
    pub app: String,
    pub os: String,
    pub arch: String,
    pub cpus: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionLine {
    pub s: String,
    /// "local" | "remote" | "sandbox"
    pub mode: String,
    pub arch: String,
}

/// The settings that change what the measured paths do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsLine {
    pub t: u64,
    pub skip_symbolization: bool,
    pub naive_disassembly: bool,
    pub symbol_offline: bool,
    pub custom_symbol_path: bool,
    pub capture_exception_context: bool,
    pub lightning_instructions: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModuleLine {
    pub i: u32,
    pub name: String,
    pub system: bool,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpanLine {
    /// Start, microseconds since the Unix epoch.
    pub t: u64,
    /// Duration in microseconds.
    pub d: u64,
    pub n: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub req: String,
    #[serde(default)]
    pub th: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub a: BTreeMap<String, u64>,
}

/// What is POSTed to the collector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Batch {
    pub run: RunInfo,
    pub lines: Vec<Line>,
}

/// A measurement from the frontend, as the `telemetry_record` command takes it.
#[derive(Debug, Clone, Deserialize)]
pub struct UiRecord {
    pub n: String,
    pub t: f64,
    pub d: f64,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub a: HashMap<String, f64>,
}

/// `lines` as NDJSON, the format of a recording: one line each, after the run
/// line when the file is being started (`run_if_new`).
pub fn ndjson(run_if_new: Option<&RunInfo>, lines: &[Line]) -> serde_json::Result<String> {
    let mut text = String::new();
    if let Some(run) = run_if_new {
        text.push_str(&serde_json::to_string(&Line::Run(run.clone()))?);
        text.push('\n');
    }
    for line in lines {
        text.push_str(&serde_json::to_string(line)?);
        text.push('\n');
    }
    Ok(text)
}

const MAX_UI_ATTRS: usize = 16;

fn is_ui_name(name: &str) -> bool {
    name.len() <= 64
        && name.strip_prefix("ui.").is_some_and(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
        })
}

fn is_attr_key(key: &str) -> bool {
    // Starts with a letter: a key is a word of ours, never a number in disguise.
    key.len() <= 32
        && key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn to_u64(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 { value as u64 } else { 0 }
}

/// The file name of a module path from either OS, lowercased.
fn file_name_lower(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_ascii_lowercase()
}

/// A span whose module is not in the table yet: resolved (or stripped) by
/// [`Anonymizer::finish`] once the table has been refreshed.
pub struct PendingSpan {
    line: SpanLine,
    module_key: Option<u64>,
}

pub struct Anonymizer {
    salt: [u8; 16],
    /// `perf::path_key` of a module path -> its table index.
    modules: HashMap<u64, u32>,
    /// The module table, in index order.
    module_lines: Vec<ModuleLine>,
    /// Session id -> token.
    sessions: HashMap<String, String>,
    /// Recorder thread number -> token of the session that thread serves.
    threads: HashMap<u64, String>,
}

impl Anonymizer {
    pub fn new() -> Self {
        Self {
            salt: *uuid::Uuid::new_v4().as_bytes(),
            modules: HashMap::new(),
            module_lines: Vec::new(),
            sessions: HashMap::new(),
            threads: HashMap::new(),
        }
    }

    fn salted(&self, what: &str, value: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.salt);
        hasher.update(what.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        crate::data_dir::hex_lower(&hasher.finalize()[..6])
    }

    /// The token a session is known by in the report.
    pub fn session_token(&mut self, session_id: &str) -> String {
        if let Some(token) = self.sessions.get(session_id) {
            return token.clone();
        }
        let token = self.salted("session", session_id);
        self.sessions.insert(session_id.to_string(), token.clone());
        token
    }

    /// Spans recorded on `thread` from now on belong to `session_id`
    /// (`None`: to no session).
    pub fn bind_thread(&mut self, thread: u64, session_id: Option<&str>) {
        match session_id {
            Some(id) => {
                let token = self.session_token(id);
                self.threads.insert(thread, token);
            }
            None => {
                self.threads.remove(&thread);
            }
        }
    }

    /// Put a module in the table (a no-op when it is there already) and
    /// return its line.
    pub fn module(&mut self, path: &str, size: u64, system: bool) -> &ModuleLine {
        let key = joybug_core::perf::path_key(path);
        let next = self.module_lines.len() as u32;
        let i = *self.modules.entry(key).or_insert(next);
        if i == next {
            let file_name = file_name_lower(path);
            let name = if system { file_name } else { format!("m-{}", self.salted("module", &file_name)) };
            self.module_lines.push(ModuleLine { i, name, system, size });
        }
        &self.module_lines[i as usize]
    }

    /// The module table so far, in index order. A destination must be given
    /// all of it: spans name modules by index only.
    pub fn modules(&self) -> &[ModuleLine] {
        &self.module_lines
    }

    /// A span from the in-process recorder (core's and the app's own).
    pub fn core_span(&self, record: PerfRecord) -> PendingSpan {
        let mut module_key = None;
        let mut a = BTreeMap::new();
        for (key, value) in record.attrs {
            if key == MODULE_KEY_ATTR {
                module_key = Some(value);
            } else {
                a.insert(key.to_string(), value);
            }
        }
        PendingSpan {
            line: SpanLine {
                t: record.start_us,
                d: record.dur_us,
                n: record.name.to_string(),
                req: record.request.to_string(),
                th: record.thread,
                s: self.threads.get(&record.thread).cloned(),
                a,
            },
            module_key,
        }
    }

    /// Resolve a pending span's module against the table as it stands now. A
    /// module the table does not know stays unnamed.
    pub fn finish(&self, pending: PendingSpan) -> SpanLine {
        let mut line = pending.line;
        if let Some(index) = pending.module_key.and_then(|key| self.modules.get(&key)) {
            line.a.insert("module".to_string(), *index as u64);
        }
        line
    }

    /// A span from the frontend. Its name and attribute keys are checked
    /// against the shapes our own code produces, so a string from anywhere
    /// else cannot ride along; values are numbers by type.
    pub fn ui_span(&mut self, record: UiRecord) -> Option<SpanLine> {
        if !is_ui_name(&record.n) || record.a.len() > MAX_UI_ATTRS || !record.a.keys().all(|k| is_attr_key(k)) {
            return None;
        }
        let s = record.s.as_deref().map(|id| self.session_token(id));
        Some(SpanLine {
            t: to_u64(record.t),
            d: to_u64(record.d),
            n: record.n,
            req: String::new(),
            th: 0,
            s,
            a: record.a.into_iter().map(|(k, v)| (k, to_u64(v))).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET_PATH: &str = r"C:\Users\alice\Secret Project\payroll_agent.exe";
    const SECRET_ID: &str = "3f2c9a54-1b7e-4d0a-9c11-5a0f3e8d7b21";

    fn json(line: &impl Serialize) -> String {
        serde_json::to_string(line).unwrap()
    }

    #[test]
    fn a_user_module_is_never_named() {
        let mut anon = Anonymizer::new();
        let line = anon.module(SECRET_PATH, 0x1000, false).clone();
        let text = json(&line).to_ascii_lowercase();
        for leak in ["payroll", "alice", "secret", "users", ".exe"] {
            assert!(!text.contains(leak), "{leak} leaked in {text}");
        }
        assert!(line.name.starts_with("m-"));
        // Already in the table: the same line, not a second one.
        assert_eq!(anon.module(SECRET_PATH, 0x1000, false), &line);
        assert_eq!(anon.modules().len(), 1);
    }

    #[test]
    fn a_system_module_keeps_its_file_name_only() {
        let mut anon = Anonymizer::new();
        let line = anon.module(r"C:\Windows\System32\ntdll.dll", 0x200000, true);
        assert_eq!(line.name, "ntdll.dll");
        let line = anon.module("/usr/lib/x86_64-linux-gnu/libc.so.6", 1, true);
        assert_eq!(line.name, "libc.so.6");
    }

    #[test]
    fn the_hash_differs_between_runs() {
        let a = Anonymizer::new().module(SECRET_PATH, 0, false).name.clone();
        let b = Anonymizer::new().module(SECRET_PATH, 0, false).name.clone();
        assert_ne!(a, b);
    }

    #[test]
    fn a_core_span_names_its_module_by_index_or_not_at_all() {
        let mut anon = Anonymizer::new();
        let key = joybug_core::perf::path_key(SECRET_PATH);
        let record = || PerfRecord {
            name: "disasm.decode_listing",
            request: "DisassembleFunction",
            start_us: 10,
            dur_us: 20,
            thread: 7,
            attrs: vec![("module_key", key), ("instructions", 12)],
        };

        // Not in the table: the key is dropped, not forwarded.
        let line = anon.finish(anon.core_span(record()));
        assert_eq!(line.a.keys().collect::<Vec<_>>(), vec!["instructions"]);
        assert!(!json(&line).contains(&key.to_string()));

        anon.module(r"C:\Windows\System32\ntdll.dll", 0, true);
        let index = anon.module(SECRET_PATH, 0, false).i;
        let line = anon.finish(anon.core_span(record()));
        assert_eq!(line.a.get("module"), Some(&(index as u64)));
        assert!(!line.a.contains_key("module_key"));
    }

    #[test]
    fn a_session_is_a_token_and_threads_carry_it() {
        let mut anon = Anonymizer::new();
        anon.bind_thread(7, Some(SECRET_ID));
        let token = anon.session_token(SECRET_ID);
        assert!(!token.contains(&SECRET_ID[..8]));
        let record = PerfRecord { name: "app.command", request: "", start_us: 0, dur_us: 0, thread: 7, attrs: vec![] };
        assert_eq!(anon.core_span(record.clone()).line.s, Some(token));
        anon.bind_thread(7, None);
        assert_eq!(anon.core_span(record).line.s, None);
    }

    #[test]
    fn a_ui_span_cannot_carry_text() {
        let mut anon = Anonymizer::new();
        let ui = |n: &str, key: &str| UiRecord {
            n: n.to_string(),
            t: 5.0,
            d: 7.9,
            s: Some(SECRET_ID.to_string()),
            a: HashMap::from([(key.to_string(), 3.0)]),
        };
        let line = anon.ui_span(ui("ui.step", "paint_us")).unwrap();
        assert_eq!((line.t, line.d), (5, 7));
        assert!(!json(&line).contains(SECRET_ID));

        // The reason for a listing travels in the name, as a word of ours.
        for name in ["ui.asm.load.navigation", "ui.asm.load.pc_follow", "ui.asm.load.patches_updated", "ui.asm.load.symbols_loaded", "ui.asm.load.refresh", "ui.invoke.source.open", "ui.invoke.source.window"] {
            assert_eq!(anon.ui_span(ui(name, "rows")).unwrap().n, name);
        }
        assert!(anon.ui_span(ui("ui.asm.load.ntdll!NtClose", "rows")).is_none(), "a symbol as a reason");
        assert!(anon.ui_span(ui("ui.asm.load.0x7FF612340000", "rows")).is_none(), "an address as a reason");

        assert!(anon.ui_span(ui("step", "paint_us")).is_none(), "not ours");
        assert!(anon.ui_span(ui(r"ui.C:\Users\alice", "x")).is_none(), "a path as a name");
        assert!(anon.ui_span(ui("ui.step", "ntdll!NtClose")).is_none(), "a symbol as a key");
        assert!(anon.ui_span(ui("ui.step", "0x7ff612340000")).is_none(), "an address as a key");
    }

    #[test]
    fn lines_round_trip() {
        let line = Line::Span(SpanLine { t: 1, d: 2, n: "ui.step".into(), req: String::new(), th: 0, s: None, a: BTreeMap::from([("x".to_string(), 1)]) });
        let text = json(&line);
        assert_eq!(text, r#"{"kind":"span","t":1,"d":2,"n":"ui.step","th":0,"a":{"x":1}}"#);
        assert_eq!(serde_json::from_str::<Line>(&text).unwrap(), line);
    }
}
