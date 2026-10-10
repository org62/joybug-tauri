//! The telemetry worker: drains the recorder, anonymizes, delivers.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use joybug_core::perf::{self, PerfRecord};
use tauri::{AppHandle, Manager};
use tracing::warn;

use super::anonymize::{ndjson, Batch, Line, PendingSpan, RunInfo, SessionLine, SpanLine, WIRE_VERSION};
use super::{take_log_stats, Pending, Shared};
use crate::state::{EmbeddedServersMap, SessionStatesMap};

/// A report goes out at least this often while there is something to say.
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
/// ... or as soon as this many lines are waiting.
const FLUSH_LINES: usize = 500;
const POST_TIMEOUT: Duration = Duration::from_secs(5);
/// One run's local recording stops growing here.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Recordings kept in the folder; the oldest go first.
const MAX_FILES: usize = 10;

fn run_info(app: &AppHandle) -> RunInfo {
    RunInfo {
        v: WIRE_VERSION,
        run: uuid::Uuid::new_v4().simple().to_string(),
        app: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpus: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0),
    }
}

/// The local recording of this run: `telemetry/<run>.ndjson`, opened on the
/// first write.
struct FileSink {
    path: PathBuf,
    file: Option<File>,
    written: u64,
}

impl FileSink {
    fn new(run: &RunInfo) -> Self {
        Self { path: super::folder().join(format!("{}.ndjson", run.run)), file: None, written: 0 }
    }

    fn append(&mut self, run: &RunInfo, lines: &[Line]) -> std::io::Result<()> {
        if self.written >= MAX_FILE_BYTES {
            return Err(std::io::Error::other("the recording reached its size limit; restart the app to start a new one"));
        }
        let starting = self.file.is_none();
        if starting {
            let folder = super::folder();
            fs::create_dir_all(&folder)?;
            // Leave room for the recording about to be created.
            crate::data_dir::prune_oldest(&folder, "ndjson", MAX_FILES - 1);
            self.file = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
        }
        let text = ndjson(starting.then_some(run), lines).map_err(std::io::Error::other)?;
        let file = self.file.as_mut().expect("opened above");
        file.write_all(text.as_bytes())?;
        self.written += text.len() as u64;
        Ok(())
    }
}

pub(super) fn run(shared: &'static Shared, rx: Receiver<PerfRecord>, app: AppHandle) {
    let run = run_info(&app);
    let mut file = FileSink::new(&run);
    let mut spans: Vec<PendingSpan> = Vec::new();
    let mut described = Described::default();
    let mut last_flush = Instant::now();

    loop {
        if !shared.delivery().active() {
            // Nothing is recording and nothing can arrive (the sink is only
            // installed while a switch is on): drop what was left undelivered
            // and sleep until the settings change.
            spans.clear();
            while rx.try_recv().is_ok() {}
            shared.pending.lock().unwrap().clear();
            if shared.flush_requested.swap(false, Ordering::AcqRel) {
                shared.flushes.fetch_add(1, Ordering::Release);
            }
            std::thread::park();
            continue;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(record) => {
                spans.push(shared.anonymizer.lock().unwrap().core_span(record));
                // Take what else is already queued before looking at the clock.
                while spans.len() < FLUSH_LINES {
                    match rx.try_recv() {
                        Ok(record) => spans.push(shared.anonymizer.lock().unwrap().core_span(record)),
                        Err(_) => break,
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }

        let requested = shared.flush_requested.load(Ordering::Acquire);
        if !(requested || spans.len() >= FLUSH_LINES || last_flush.elapsed() >= FLUSH_INTERVAL) {
            continue;
        }
        if requested {
            // Everything recorded before the request is part of this flush.
            while let Ok(record) = rx.try_recv() {
                spans.push(shared.anonymizer.lock().unwrap().core_span(record));
            }
        }
        flush(shared, &app, &run, &mut file, &mut described, std::mem::take(&mut spans));
        last_flush = Instant::now();
        if requested {
            shared.flush_requested.store(false, Ordering::Release);
            shared.flushes.fetch_add(1, Ordering::Release);
        }
    }
}

/// What the current destinations have been told about the run so far. Spans
/// refer to sessions and modules by token and index, so a destination that
/// joins later (a collector address entered mid-run, the file switch turned
/// on) needs the tables from the start: they are sent again whenever the
/// destinations change.
#[derive(Default)]
struct Described {
    config: Option<super::Config>,
    sessions: HashSet<String>,
    modules: usize,
}

fn flush(shared: &Shared, app: &AppHandle, run: &RunInfo, file: &mut FileSink, described: &mut Described, spans: Vec<PendingSpan>) {
    let config = shared.delivery();
    let pending = std::mem::take(&mut *shared.pending.lock().unwrap());
    if !config.active() {
        return;
    }

    if described.config.as_ref() != Some(&config) {
        *described = Described { config: Some(config.clone()), ..Default::default() };
    }

    let mut lines: Vec<Line> = Vec::new();
    {
        let mut anonymizer = shared.anonymizer.lock().unwrap();
        // Sessions and modules first, so every span's module resolves.
        describe_sessions(app, &mut anonymizer, &mut described.sessions, &mut lines);
        lines.extend(anonymizer.modules()[described.modules..].iter().cloned().map(Line::Module));
        described.modules = anonymizer.modules().len();
        for item in pending {
            match item {
                Pending::Settings(settings) => lines.push(Line::Settings(settings)),
                Pending::Ui(record) => match anonymizer.ui_span(record) {
                    Some(span) => lines.push(Line::Span(span)),
                    None => {
                        shared.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
            }
        }
        lines.extend(spans.into_iter().map(|span| Line::Span(anonymizer.finish(span))));
    }

    let (writes, bytes, micros) = take_log_stats();
    if writes > 0 {
        lines.push(Line::Span(SpanLine {
            t: perf::now_us(),
            d: micros,
            n: "app.log_write".into(),
            req: String::new(),
            th: 0,
            s: None,
            a: [("writes".to_string(), writes), ("bytes".to_string(), bytes)].into(),
        }));
    }
    let dropped = perf::take_dropped();
    if dropped > 0 {
        shared.dropped.fetch_add(dropped, Ordering::Relaxed);
        lines.push(Line::Dropped { t: perf::now_us(), count: dropped });
    }
    if lines.is_empty() {
        return;
    }

    let mut error = None;
    let mut delivered = false;
    if config.to_file {
        match file.append(run, &lines) {
            Ok(()) => {
                delivered = true;
                *shared.file.lock().unwrap() = Some(file.path.clone());
            }
            Err(e) => error = Some(format!("recording to file: {e}")),
        }
    }
    if let Some(url) = &config.url {
        let count = lines.len() as u64;
        let batch = Batch { run: run.clone(), lines };
        match post(app, url, &batch) {
            Ok(()) => {
                delivered = true;
                shared.sent_batches.fetch_add(1, Ordering::Relaxed);
                shared.sent_records.fetch_add(count, Ordering::Relaxed);
            }
            Err(e) => {
                shared.failed_batches.fetch_add(1, Ordering::Relaxed);
                error = Some(format!("sending to {url}: {e}"));
            }
        }
    } else if delivered {
        shared.sent_records.fetch_add(lines.len() as u64, Ordering::Relaxed);
    }

    let mut last_error = shared.last_error.lock().unwrap();
    if let Some(error) = &error {
        // Once per distinct failure: a collector that is down fails every 2 s.
        if last_error.as_ref() != Some(error) {
            warn!("telemetry: {error}");
        }
    }
    if error.is_some() || delivered {
        *last_error = error;
    }
}

/// A failed batch is dropped, not retried: the data is a sample of what the
/// app is doing, and a backlog growing behind a dead collector helps nobody.
fn post(app: &AppHandle, url: &str, batch: &Batch) -> Result<(), String> {
    let request = crate::commands::updates::http()
        .post(url)
        .header(reqwest::header::USER_AGENT, crate::commands::updates::user_agent(&app.package_info().version.to_string()))
        .timeout(POST_TIMEOUT)
        .json(batch);
    tauri::async_runtime::block_on(async move {
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_success() { Ok(()) } else { Err(format!("collector answered {status}")) }
    })
}

/// Add a line for every session the destinations have not been told about,
/// and put the sessions' modules in the module table.
fn describe_sessions(app: &AppHandle, anonymizer: &mut super::anonymize::Anonymizer, described: &mut HashSet<String>, lines: &mut Vec<Line>) {
    let sessions: Vec<_> = {
        let Some(states) = app.try_state::<SessionStatesMap>() else { return };
        let map = states.lock().unwrap();
        map.iter().map(|(id, state)| (id.clone(), state.clone())).collect()
    };
    for (id, state) in sessions {
        let (modules, sandbox, arch) = {
            let state = state.lock().unwrap();
            (
                state.modules.iter().map(|m| (m.name.clone(), m.size.unwrap_or(0))).collect::<Vec<_>>(),
                state.sandbox.is_some(),
                state.arch.map(|_| format!("{:?}", state.target_arch()).to_ascii_lowercase()),
            )
        };
        // Until the target reports its architecture there is nothing to say yet.
        let Some(arch) = arch else { continue };
        if described.insert(id.clone()) {
            let token = anonymizer.session_token(&id);
            let embedded = app.try_state::<EmbeddedServersMap>().is_some_and(|servers| servers.lock().unwrap().contains_key(&id));
            let mode = if sandbox { "sandbox" } else if embedded { "local" } else { "remote" };
            lines.push(Line::Session(SessionLine { s: token, mode: mode.into(), arch }));
        }
        for (path, size) in modules {
            let system = crate::session::helpers::is_system_module_path(&path);
            anonymizer.module(&path, size, system);
        }
    }
}
