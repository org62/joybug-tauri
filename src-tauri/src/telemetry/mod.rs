//! Opt-in performance telemetry: where the time goes between a user action
//! and the UI showing its result.
//!
//! Measurements are spans recorded through `joybug_core::perf` — the same
//! recorder core uses, so the app's own spans, the embedded debug server's and
//! the frontend's (through the `telemetry_record` command) land in one stream
//! on one clock. Nothing is recorded unless the user switched it on: with both
//! switches off no sink is installed and a span is one atomic load.
//!
//! A worker thread ([`sender`]) turns the stream into [`anonymize::Line`]s —
//! the only shape that ever leaves the process — and delivers them to the
//! configured collector and/or a local NDJSON file. The collector itself is a
//! role of this same executable ([`collector`]).

pub(crate) mod anonymize;
pub mod collector;
mod sender;

use std::cell::Cell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use joybug_core::perf::{self, PerfRecord};
use serde::Serialize;
use tauri::AppHandle;

use crate::settings::DebugSettings;
use anonymize::{Anonymizer, SettingsLine, UiRecord};

pub(crate) use joybug_core::perf::{enabled, request_scope, span, variant_name, Span};

/// Spans queued between the recording threads and the worker. A pause produces
/// a few dozen; this is minutes of headroom for a stalled worker.
const QUEUE_CAPACITY: usize = 32 * 1024;
/// Frontend records accepted per `telemetry_record` call.
const MAX_UI_RECORDS: usize = 4000;
/// Lines waiting for the worker besides the span queue (frontend records,
/// settings changes). Beyond this they are dropped and counted.
const MAX_PENDING: usize = 64 * 1024;

/// After the switches go off, what was recorded while they were on is still
/// delivered where it was headed — a recording switched off and handed over
/// must not be missing its last seconds.
const DRAIN_GRACE: Duration = Duration::from_secs(4);

/// Where reports go, derived from the settings.
#[derive(Debug, Clone, Default, PartialEq)]
struct Config {
    /// The collector URL, when sending is on and an address is set.
    url: Option<String>,
    to_file: bool,
}

impl Config {
    fn from_settings(settings: &DebugSettings) -> Self {
        Self {
            url: settings.telemetry_enabled.then(|| endpoint_url(&settings.telemetry_endpoint)).flatten(),
            to_file: settings.telemetry_record_to_file,
        }
    }

    fn active(&self) -> bool {
        self.url.is_some() || self.to_file
    }
}

/// The URL reports are POSTed to for a collector address as typed in Settings:
/// `host:port`, or a full `http(s)://` URL with or without a path.
pub(crate) fn endpoint_url(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() {
        return None;
    }
    let with_scheme = if address.contains("://") { address.to_string() } else { format!("http://{address}") };
    let (scheme, rest) = with_scheme.split_once("://")?;
    if !matches!(scheme, "http" | "https") || rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    match rest.split_once('/') {
        Some((_, path)) if !path.is_empty() => Some(with_scheme),
        Some((host, _)) => Some(format!("{scheme}://{host}{}", collector::RECORDS_PATH)),
        None => Some(format!("{scheme}://{rest}{}", collector::RECORDS_PATH)),
    }
}

enum Pending {
    Ui(UiRecord),
    Settings(SettingsLine),
}

struct Shared {
    /// The recorder's sink; installed in core only while a switch is on.
    tx: SyncSender<PerfRecord>,
    config: Mutex<Config>,
    /// The last active config and until when it still applies (see `DRAIN_GRACE`).
    draining: Mutex<Option<(Config, Instant)>>,
    anonymizer: Mutex<Anonymizer>,
    pending: Mutex<Vec<Pending>>,
    sent_records: AtomicU64,
    sent_batches: AtomicU64,
    failed_batches: AtomicU64,
    dropped: AtomicU64,
    last_error: Mutex<Option<String>>,
    file: Mutex<Option<PathBuf>>,
    /// Set to ask the worker for an immediate flush; `flushes` counts them.
    flush_requested: AtomicBool,
    flushes: AtomicU64,
    /// The worker's thread: it parks while nothing is recording and is
    /// unparked when the settings change.
    worker: OnceLock<std::thread::Thread>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

thread_local! {
    /// When this (session) thread last resumed the target.
    static RESUMED: Cell<Option<(u64, Instant)>> = const { Cell::new(None) };
}

/// Start the worker and apply the saved settings. Called once, when the app
/// has a handle.
pub fn init(app: AppHandle, settings: &DebugSettings) {
    let (tx, rx) = std::sync::mpsc::sync_channel(QUEUE_CAPACITY);
    let shared = SHARED.get_or_init(|| Shared {
        tx,
        config: Mutex::new(Config::default()),
        draining: Mutex::new(None),
        anonymizer: Mutex::new(Anonymizer::new()),
        pending: Mutex::new(Vec::new()),
        sent_records: AtomicU64::new(0),
        sent_batches: AtomicU64::new(0),
        failed_batches: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
        last_error: Mutex::new(None),
        file: Mutex::new(None),
        flush_requested: AtomicBool::new(false),
        flushes: AtomicU64::new(0),
        worker: OnceLock::new(),
    });
    let worker = std::thread::Builder::new()
        .name("telemetry".into())
        .spawn(move || sender::run(shared, rx, app))
        .expect("spawn telemetry worker");
    let _ = shared.worker.set(worker.thread().clone());
    apply_settings(settings);
}

/// Follow a settings change: install or remove the recorder's sink, and put
/// the settings that shape the measured paths on record.
pub fn apply_settings(settings: &DebugSettings) {
    let Some(shared) = SHARED.get() else { return };
    let config = Config::from_settings(settings);
    let active = config.active();
    {
        let mut current = shared.config.lock().unwrap();
        if current.active() && !active {
            *shared.draining.lock().unwrap() = Some((current.clone(), Instant::now() + DRAIN_GRACE));
        }
        *current = config;
    }
    perf::set_sink(active.then(|| shared.tx.clone()));
    if let Some(worker) = shared.worker.get() {
        worker.unpark();
    }
    if active {
        push_pending(shared, Pending::Settings(SettingsLine {
            t: perf::now_us(),
            skip_symbolization: settings.diag_skip_symbolization,
            naive_disassembly: settings.diag_naive_disassembly,
            symbol_offline: settings.symbol_offline,
            custom_symbol_path: !settings.symbol_path.trim().is_empty(),
            capture_exception_context: settings.capture_exception_context,
            lightning_instructions: settings.lightning_instructions as u64,
        }));
    }
}

impl Shared {
    /// Where a report goes right now: the configured destinations, or for a
    /// moment after switching off, the ones that were configured.
    fn delivery(&self) -> Config {
        let config = self.config.lock().unwrap().clone();
        if config.active() {
            return config;
        }
        match &*self.draining.lock().unwrap() {
            Some((previous, until)) if Instant::now() < *until => previous.clone(),
            _ => config,
        }
    }
}

fn push_pending(shared: &Shared, item: Pending) {
    let mut pending = shared.pending.lock().unwrap();
    if pending.len() < MAX_PENDING {
        pending.push(item);
    } else {
        shared.dropped.fetch_add(1, Ordering::Relaxed);
    }
}

/// Spans recorded on the calling thread belong to `session_id` from now on.
/// The debug-loop thread calls this once; it lives exactly as long as its run.
pub fn bind_session(session_id: &str) {
    if let Some(shared) = SHARED.get() {
        shared.anonymizer.lock().unwrap().bind_thread(perf::thread_no(), Some(session_id));
    }
}

/// The calling (session) thread is about to resume the target.
pub fn mark_resume() {
    RESUMED.with(|r| r.set(perf::enabled().then(|| (perf::now_us(), Instant::now()))));
}

/// The target stopped again: record how long it ran (`app.target_run`), which
/// is the part of a step's latency that is not ours.
pub fn target_stopped() {
    if let Some((start_us, started)) = RESUMED.with(|r| r.take()) {
        perf::record("app.target_run", start_us, started.elapsed().as_micros() as u64, &[]);
    }
}

/// Measurements from the frontend.
pub fn record_ui(records: Vec<UiRecord>) {
    let Some(shared) = SHARED.get() else { return };
    // Includes the frontend's last batch after a switch-off.
    if !shared.delivery().active() {
        return;
    }
    let total = records.len();
    for record in records.into_iter().take(MAX_UI_RECORDS) {
        push_pending(shared, Pending::Ui(record));
    }
    if total > MAX_UI_RECORDS {
        shared.dropped.fetch_add((total - MAX_UI_RECORDS) as u64, Ordering::Relaxed);
    }
}

/// What Settings shows about the telemetry at work.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TelemetryStatus {
    /// Spans are being recorded (either switch is effective).
    pub active: bool,
    /// The URL reports are POSTed to, when sending is on and an address is set.
    pub url: Option<String>,
    pub recording_to_file: bool,
    pub sent_records: u64,
    pub sent_batches: u64,
    pub failed_batches: u64,
    pub dropped: u64,
    pub last_error: Option<String>,
    pub file: Option<String>,
}

pub fn status() -> TelemetryStatus {
    let Some(shared) = SHARED.get() else { return TelemetryStatus::default() };
    let config = shared.config.lock().unwrap().clone();
    TelemetryStatus {
        active: config.active(),
        url: config.url,
        recording_to_file: config.to_file,
        sent_records: shared.sent_records.load(Ordering::Relaxed),
        sent_batches: shared.sent_batches.load(Ordering::Relaxed),
        failed_batches: shared.failed_batches.load(Ordering::Relaxed),
        dropped: shared.dropped.load(Ordering::Relaxed),
        last_error: shared.last_error.lock().unwrap().clone(),
        file: shared.file.lock().unwrap().as_ref().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Where the local recordings live.
pub fn folder() -> PathBuf {
    crate::data_dir::joybug_data_dir().join("telemetry")
}

/// Deliver what is queued now and wait (briefly) for it. Used on exit and by
/// anything that needs the report to be complete at a known point. Nothing to
/// wait for when nothing is being delivered.
pub fn flush(timeout: Duration) {
    let Some(shared) = SHARED.get() else { return };
    if !shared.delivery().active() {
        return;
    }
    let before = shared.flushes.load(Ordering::Acquire);
    shared.flush_requested.store(true, Ordering::Release);
    let deadline = Instant::now() + timeout;
    while shared.flushes.load(Ordering::Acquire) == before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

// Cost of the log writes, which sit on the session thread's hot path: every
// command and every debug event logs a line, and a release build writes it to
// the log file synchronously.
static LOG_WRITES: AtomicU64 = AtomicU64::new(0);
static LOG_BYTES: AtomicU64 = AtomicU64::new(0);
static LOG_MICROS: AtomicU64 = AtomicU64::new(0);

/// `(writes, bytes, microseconds)` of log output since the last call.
pub(super) fn take_log_stats() -> (u64, u64, u64) {
    (LOG_WRITES.swap(0, Ordering::Relaxed), LOG_BYTES.swap(0, Ordering::Relaxed), LOG_MICROS.swap(0, Ordering::Relaxed))
}

/// A log writer that accounts for its writes while telemetry is on. Wraps
/// either a writer or the `MakeWriter` that hands them out, so the wrapped
/// appender keeps its own (shared) locking.
pub struct TimedWriter<W>(pub W);

impl<'a, M: tracing_subscriber::fmt::MakeWriter<'a>> tracing_subscriber::fmt::MakeWriter<'a> for TimedWriter<M> {
    type Writer = TimedWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        TimedWriter(self.0.make_writer())
    }
}

impl<W: std::io::Write> std::io::Write for TimedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if !perf::enabled() {
            return self.0.write(buf);
        }
        let started = Instant::now();
        let result = self.0.write(buf);
        LOG_WRITES.fetch_add(1, Ordering::Relaxed);
        LOG_BYTES.fetch_add(buf.len() as u64, Ordering::Relaxed);
        LOG_MICROS.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        result
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_accepts_an_address_or_a_url() {
        assert_eq!(endpoint_url(""), None);
        assert_eq!(endpoint_url("   "), None);
        assert_eq!(endpoint_url("127.0.0.1:4318").as_deref(), Some("http://127.0.0.1:4318/v1/records"));
        assert_eq!(endpoint_url(" collector.example:80 ").as_deref(), Some("http://collector.example:80/v1/records"));
        assert_eq!(endpoint_url("https://t.example").as_deref(), Some("https://t.example/v1/records"));
        assert_eq!(endpoint_url("https://t.example/").as_deref(), Some("https://t.example/v1/records"));
        assert_eq!(endpoint_url("https://t.example/ingest").as_deref(), Some("https://t.example/ingest"));
        assert_eq!(endpoint_url("ftp://t.example"), None);
        assert_eq!(endpoint_url("http://"), None);
    }

    #[test]
    fn nothing_is_sent_without_both_the_switch_and_an_address() {
        let mut settings = DebugSettings::default();
        assert!(!Config::from_settings(&settings).active());

        settings.telemetry_endpoint = "127.0.0.1:4318".into();
        assert!(!Config::from_settings(&settings).active(), "an address alone sends nothing");

        settings.telemetry_endpoint.clear();
        settings.telemetry_enabled = true;
        assert!(!Config::from_settings(&settings).active(), "the switch alone sends nothing");

        settings.telemetry_endpoint = "127.0.0.1:4318".into();
        let config = Config::from_settings(&settings);
        assert!(config.active() && config.url.is_some() && !config.to_file);

        // The file switch stands on its own.
        let mut settings = DebugSettings::default();
        settings.telemetry_record_to_file = true;
        let config = Config::from_settings(&settings);
        assert!(config.active() && config.url.is_none() && config.to_file);
    }
}
