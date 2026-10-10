//! The receiving end of the telemetry, as roles of this same executable:
//!
//! ```text
//! joybug-tauri --telemetry-collect 127.0.0.1:4318 [--out <dir>]
//! joybug-tauri --telemetry-summarize <file-or-dir> [--out <file>]
//! ```
//!
//! `--telemetry-collect` is a plain HTTP server: the app POSTs a
//! [`Batch`] to [`RECORDS_PATH`] and the collector appends its lines to
//! `<dir>/<run>.ndjson` — the same file the app's "record to file" switch
//! writes, so `--telemetry-summarize` reads either. It has no TLS and no
//! authentication of its own: bind it to loopback, or put a reverse proxy in
//! front of it.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::anonymize::{ndjson, Batch, Line, ModuleLine, RunInfo, SpanLine};
use crate::commands::IndexSource;

/// Where batches are POSTed.
pub const RECORDS_PATH: &str = "/v1/records";
const COLLECT_FLAG: &str = "--telemetry-collect";
const SUMMARIZE_FLAG: &str = "--telemetry-summarize";
const OUT_FLAG: &str = "--out";
/// Largest batch accepted. The app flushes every 500 lines, a few hundred KB.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum Role {
    Collect { addr: String, out: PathBuf },
    Summarize { path: PathBuf, out: Option<PathBuf> },
}

/// The telemetry role the command line asks for, if any. A raw scan, like
/// core's `guest_roles`: the GUI's own arguments fall through.
pub fn role_from_argv(argv: &[String]) -> Option<Role> {
    let value_of = |flag: &str| argv.iter().position(|a| a == flag).and_then(|i| argv.get(i + 1)).cloned();
    if let Some(addr) = value_of(COLLECT_FLAG) {
        let out = value_of(OUT_FLAG).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("telemetry"));
        return Some(Role::Collect { addr, out });
    }
    value_of(SUMMARIZE_FLAG).map(|path| Role::Summarize { path: PathBuf::from(path), out: value_of(OUT_FLAG).map(PathBuf::from) })
}

/// Run a role to completion and exit the process.
pub fn run(role: Role) -> ! {
    let mut console = console();
    let code = match role {
        Role::Collect { addr, out } => match collect(&addr, &out, &mut console) {
            Ok(()) => 0,
            Err(e) => {
                let _ = writeln!(console, "telemetry collector: {e}");
                1
            }
        },
        Role::Summarize { path, out } => match summarize(&path) {
            Ok(report) => {
                let _ = console.write_all(report.as_bytes());
                match out.map(|out| fs::write(&out, &report).map_err(|e| format!("{}: {e}", out.display()))) {
                    Some(Err(e)) => {
                        let _ = writeln!(console, "{e}");
                        1
                    }
                    _ => 0,
                }
            }
            Err(e) => {
                let _ = writeln!(console, "telemetry summary: {e}");
                1
            }
        },
    };
    let _ = console.flush();
    std::process::exit(code)
}

/// Where a role prints. A release build is a GUI-subsystem executable: started
/// from a terminal without redirection it has no stdout, so borrow the
/// terminal's console.
fn console() -> Box<dyn Write> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
        // SAFETY: plain Win32 calls with no pointers.
        let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if stdout.is_null() || stdout as isize == -1 {
            unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
            return match OpenOptions::new().write(true).open("CONOUT$") {
                Ok(console) => Box::new(console),
                Err(_) => Box::new(std::io::sink()),
            };
        }
    }
    Box::new(std::io::stdout())
}

/// A run id as the app makes them: it becomes a file name, so nothing else is
/// accepted.
fn is_run_id(run: &str) -> bool {
    (8..=64).contains(&run.len()) && run.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Append a batch to its run's file, starting the file with the run line.
fn store(out: &Path, batch: &Batch) -> Result<PathBuf, String> {
    if !is_run_id(&batch.run.run) {
        return Err("bad run id".into());
    }
    let path = out.join(format!("{}.ndjson", batch.run.run));
    let text = ndjson((!path.exists()).then_some(&batch.run), &batch.lines).map_err(|e| e.to_string())?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

fn collect(addr: &str, out: &Path, console: &mut dyn Write) -> Result<(), String> {
    fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let server = tiny_http::Server::http(addr).map_err(|e| format!("cannot listen on {addr}: {e}"))?;
    let _ = writeln!(console, "telemetry collector listening on http://{}{RECORDS_PATH}, writing to {}", server.server_addr(), out.display());
    let _ = console.flush();

    for mut request in server.incoming_requests() {
        let (status, note) = if request.method() != &tiny_http::Method::Post || request.url() != RECORDS_PATH {
            (404, None)
        } else if request.body_length().is_some_and(|len| len as u64 > MAX_BODY_BYTES) {
            (413, None)
        } else {
            let mut body = Vec::new();
            match request.as_reader().take(MAX_BODY_BYTES + 1).read_to_end(&mut body) {
                Ok(_) if body.len() as u64 > MAX_BODY_BYTES => (413, None),
                Ok(_) => match serde_json::from_slice::<Batch>(&body) {
                    Ok(batch) => match store(out, &batch) {
                        Ok(path) => (204, Some(format!("{} lines -> {}", batch.lines.len(), path.display()))),
                        Err(e) => (400, Some(e)),
                    },
                    Err(e) => (400, Some(format!("not a batch: {e}"))),
                },
                Err(e) => (400, Some(format!("read failed: {e}"))),
            }
        };
        if let Some(note) = note {
            let _ = writeln!(console, "{status} {note}");
            let _ = console.flush();
        }
        let _ = request.respond(tiny_http::Response::empty(status));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/// One recorded run, read back.
#[derive(Default)]
struct Report {
    run: Option<RunInfo>,
    sessions: Vec<String>,
    settings: Vec<super::anonymize::SettingsLine>,
    modules: BTreeMap<u32, ModuleLine>,
    spans: Vec<SpanLine>,
    dropped: u64,
    unreadable: u64,
}

fn read_report(path: &Path) -> std::io::Result<Report> {
    let mut report = Report::default();
    for text in fs::read_to_string(path)?.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Line>(text) {
            Ok(Line::Run(run)) => report.run = Some(run),
            Ok(Line::Session(s)) => {
                // Sent again whenever the app's destinations change.
                let session = format!("{} ({}, {})", s.s, s.mode, s.arch);
                if !report.sessions.contains(&session) {
                    report.sessions.push(session);
                }
            }
            Ok(Line::Settings(s)) => report.settings.push(s),
            Ok(Line::Module(m)) => {
                report.modules.insert(m.i, m);
            }
            Ok(Line::Span(span)) => report.spans.push(span),
            Ok(Line::Dropped { count, .. }) => report.dropped += count,
            Err(_) => report.unreadable += 1,
        }
    }
    Ok(report)
}

/// Durations of a group of spans (or of one of their attributes).
#[derive(Default)]
struct Stat {
    values: Vec<u64>,
}

impl Stat {
    fn of(values: impl IntoIterator<Item = u64>) -> Self {
        let mut values: Vec<u64> = values.into_iter().collect();
        values.sort_unstable();
        Self { values }
    }
    fn count(&self) -> usize {
        self.values.len()
    }
    fn total(&self) -> u64 {
        self.values.iter().sum()
    }
    fn max(&self) -> u64 {
        self.values.last().copied().unwrap_or(0)
    }
    /// Nearest-rank percentile.
    fn pct(&self, p: usize) -> u64 {
        match self.values.len() {
            0 => 0,
            n => self.values[((n * p).div_ceil(100)).clamp(1, n) - 1],
        }
    }
    fn line(&self) -> String {
        format!("n={:<6} total={:>10} p50={:>9} p95={:>9} max={:>9}", self.count(), ms(self.total()), ms(self.pct(50)), ms(self.pct(95)), ms(self.max()))
    }
}

/// Microseconds as milliseconds.
fn ms(micros: u64) -> String {
    format!("{:.2}ms", micros as f64 / 1000.0)
}

fn named<'a>(spans: &'a [SpanLine], name: &'a str) -> impl Iterator<Item = &'a SpanLine> {
    spans.iter().filter(move |s| s.n == name)
}

fn attr(span: &SpanLine, key: &str) -> u64 {
    span.a.get(key).copied().unwrap_or(0)
}

/// The disassembly view's listing loads: `ui.asm.load.<reason>`, the reason
/// being why the view asked (`AsmLoadReason` in `src/lib/perf.ts`).
const ASM_LOAD_PREFIX: &str = "ui.asm.load.";

/// The requests that wait for the target, not for us.
const WAITING_REQUESTS: [&str; 3] = ["Continue", "Launch", "Attach"];

fn summarize_report(name: &str, report: &Report, out: &mut String) {
    let spans = &report.spans;
    let _ = writeln!(out, "== {name}");
    match &report.run {
        Some(run) => {
            let _ = writeln!(out, "run {}  app {}  {} {}  {} cpus", run.run, run.app, run.os, run.arch, run.cpus);
        }
        None => {
            let _ = writeln!(out, "(no run line)");
        }
    }
    let _ = writeln!(out, "sessions: {}", if report.sessions.is_empty() { "-".to_string() } else { report.sessions.join(", ") });
    if let Some(s) = report.settings.last() {
        let _ = writeln!(
            out,
            "settings: skip_symbolization={} naive_disassembly={} symbol_offline={} custom_symbol_path={} capture_exception_context={} lightning_instructions={} ({} change(s) recorded)",
            s.skip_symbolization, s.naive_disassembly, s.symbol_offline, s.custom_symbol_path, s.capture_exception_context, s.lightning_instructions, report.settings.len()
        );
    }
    let _ = writeln!(out, "{} spans, {} modules, {} dropped, {} unreadable line(s)", spans.len(), report.modules.len(), report.dropped, report.unreadable);

    // --- the headline -----------------------------------------------------
    let _ = writeln!(out, "\n-- step latency (step issued -> next frame painted)");
    let steps: Vec<&SpanLine> = named(spans, "ui.step").collect();
    if steps.is_empty() {
        let _ = writeln!(out, "  no steps recorded");
    } else {
        let _ = writeln!(out, "  total            {}", Stat::of(steps.iter().map(|s| s.d)).line());
        for (key, label) in [("event_us", "to pause event  "), ("commit_us", "to view commit  "), ("paint_us", "to paint        ")] {
            let _ = writeln!(out, "  {label} {}", Stat::of(steps.iter().map(|s| attr(s, key))).line());
        }
        let reloads = steps.iter().filter(|s| attr(s, "reloaded") > 0).count();
        let _ = writeln!(out, "  {reloads} of {} steps left the loaded listing and reloaded it", steps.len());
        let _ = writeln!(out, "  of which the target ran: {}", Stat::of(named(spans, "app.target_run").map(|s| s.d)).line());
    }

    // --- every span -------------------------------------------------------
    let _ = writeln!(out, "\n-- spans by total time");
    let mut groups: BTreeMap<(String, String), Vec<u64>> = BTreeMap::new();
    for span in spans {
        groups.entry((span.n.clone(), span.req.clone())).or_default().push(span.d);
    }
    let mut rows: Vec<(String, Stat)> = groups
        .into_iter()
        .map(|((n, req), values)| (if req.is_empty() { n } else { format!("{n} [{req}]") }, Stat::of(values)))
        .collect();
    rows.sort_by_key(|(_, stat)| std::cmp::Reverse(stat.total()));
    for (label, stat) in &rows {
        let _ = writeln!(out, "  {label:<52} {}", stat.line());
    }

    // --- the suspects -----------------------------------------------------
    let _ = writeln!(out, "\n-- suspects");
    let waits: Vec<&SpanLine> = named(spans, "symbols.wait_for_loading").collect();
    let _ = writeln!(
        out,
        "  blocked waiting for symbols to load: {}  ({} hit the wait timeout)",
        Stat::of(waits.iter().map(|s| s.d)).line(),
        waits.iter().filter(|s| attr(s, "timed_out") > 0).count()
    );
    let scans: Vec<&SpanLine> = named(spans, "symbols.raw_scan").collect();
    let _ = writeln!(
        out,
        "  linear symbol scans:                 {}  (largest module scanned: {} symbols)",
        Stat::of(scans.iter().map(|s| s.d)).line(),
        scans.iter().map(|s| attr(s, "symbols")).max().unwrap_or(0)
    );
    let _ = writeln!(out, "  function-table first loads:          {}", Stat::of(named(spans, "symbols.function_table_load").map(|s| s.d)).line());
    let _ = writeln!(out, "  debug-file artifact parses:          {}", Stat::of(named(spans, "symbols.parse_artifact").map(|s| s.d)).line());
    let _ = writeln!(out, "  symbol loads (background):           {}", Stat::of(named(spans, "symbols.load_module").map(|s| s.d)).line());
    let bounds: Vec<&SpanLine> = named(spans, "disasm.function_bounds").collect();
    let _ = writeln!(
        out,
        "  function bounds:                     {}  ({} read the module file, name lookups took {})",
        Stat::of(bounds.iter().map(|s| s.d)).line(),
        bounds.iter().filter(|s| attr(s, "file_parse") > 0).count(),
        ms(bounds.iter().map(|s| attr(s, "name_us")).sum())
    );
    let functions: Vec<&SpanLine> = named(spans, "disasm.function").collect();
    let _ = writeln!(out, "  function listings decoded twice:     {} of {}", functions.iter().filter(|s| attr(s, "decodes") > 1).count(), functions.len());

    let listings: Vec<&SpanLine> = named(spans, "disasm.decode_listing").collect();
    let sum = |key: &str| ms(listings.iter().map(|s| attr(s, key)).sum());
    let _ = writeln!(
        out,
        "  listing decode ({} decodes, {} instructions): read {}  modules {}  decode {} (of which symbols {}, {} lookups)  indirect targets {} ({} reads)  lines {}",
        listings.len(),
        listings.iter().map(|s| attr(s, "instructions")).sum::<u64>(),
        sum("read_us"),
        sum("modules_us"),
        sum("decode_us"),
        sum("symbolize_us"),
        listings.iter().map(|s| attr(s, "resolver_calls")).sum::<u64>(),
        sum("indirect_us"),
        listings.iter().map(|s| attr(s, "indirect_reads")).sum::<u64>(),
        sum("lines_us"),
    );

    let commands: Vec<&SpanLine> = named(spans, "app.command").collect();
    let _ = writeln!(out, "  commands waiting in the session queue: {}", Stat::of(commands.iter().map(|s| attr(s, "queue_us"))).line());
    let mut by_command: BTreeMap<&str, (Vec<u64>, Vec<u64>)> = BTreeMap::new();
    for span in &commands {
        let entry = by_command.entry(span.req.as_str()).or_default();
        entry.0.push(span.d);
        entry.1.push(attr(span, "queue_us"));
    }
    let mut busiest: Vec<(&str, Stat, Stat)> = by_command.into_iter().map(|(req, (run, queue))| (req, Stat::of(run), Stat::of(queue))).collect();
    busiest.sort_by_key(|(_, run, _)| std::cmp::Reverse(run.total()));
    for (req, run, queue) in busiest.iter().take(8) {
        let _ = writeln!(out, "    {req:<24} ran {}   waited p95={} max={}", run.line(), ms(queue.pct(95)), ms(queue.max()));
    }

    let loads: Vec<&SpanLine> = spans.iter().filter(|s| s.n.starts_with(ASM_LOAD_PREFIX)).collect();
    let mut by_reason: BTreeMap<&str, usize> = BTreeMap::new();
    for load in &loads {
        *by_reason.entry(&load.n[ASM_LOAD_PREFIX.len()..]).or_default() += 1;
    }
    let reasons: Vec<String> = by_reason.iter().map(|(reason, n)| format!("{reason} {n}")).collect();
    let _ = writeln!(out, "  disassembly loads requested by the view: {} ({})", loads.len(), if reasons.is_empty() { "-".to_string() } else { reasons.join(", ") });
    let _ = writeln!(out, "    request -> result applied:         {}", Stat::of(loads.iter().map(|s| s.d)).line());

    let scans: Vec<&SpanLine> = named(spans, "app.image_patch_scan").collect();
    let _ = writeln!(
        out,
        "  image-patch scans (background):      {}  ({} superseded, {} MB read)",
        Stat::of(scans.iter().map(|s| s.d)).line(),
        scans.iter().filter(|s| attr(s, "cancelled") > 0).count(),
        scans.iter().map(|s| attr(s, "bytes")).sum::<u64>() / (1024 * 1024)
    );

    let _ = writeln!(out, "\n-- source view");
    let resolves: Vec<&SpanLine> = named(spans, "ui.source.resolve").collect();
    let _ = writeln!(
        out,
        "  address -> line (request to answer):  {}  ({} answered \"line table still loading\")",
        Stat::of(resolves.iter().map(|s| s.d)).line(),
        resolves.iter().filter(|s| attr(s, "pending") > 0).count()
    );
    let _ = writeln!(out, "  line table loading -> ready:          {}", Stat::of(named(spans, "ui.source.line_info_wait").map(|s| s.d)).line());
    let opens: Vec<&SpanLine> = named(spans, "app.source.open").collect();
    let index_from = |from: IndexSource| opens.iter().filter(|s| attr(s, "index_from") == from as u64).count();
    let _ = writeln!(
        out,
        "  file open (locate + index):           {}  (locating took {}, largest file {} KB; index from memory {}, disk {}, built {})",
        Stat::of(opens.iter().map(|s| s.d)).line(),
        ms(opens.iter().map(|s| attr(s, "locate_us")).sum()),
        opens.iter().map(|s| attr(s, "bytes")).max().unwrap_or(0) / 1024,
        index_from(IndexSource::Memory),
        index_from(IndexSource::Disk),
        index_from(IndexSource::Built)
    );
    let _ = writeln!(out, "  checksum verification (background):   {}", Stat::of(named(spans, "app.source.checksum").map(|s| s.d)).line());
    let _ = writeln!(out, "  file open, as the view saw it:        {}", Stat::of(named(spans, "ui.invoke.source.open").map(|s| s.d)).line());
    let windows: Vec<&SpanLine> = named(spans, "app.source.read_window").collect();
    let _ = writeln!(
        out,
        "  window reads:                         {}  ({} had to fetch the index again)",
        Stat::of(windows.iter().map(|s| s.d)).line(),
        windows.iter().filter(|s| attr(s, "index_from") != IndexSource::Memory as u64).count()
    );
    let _ = writeln!(out, "  window reads, as the view saw them:   {}", Stat::of(named(spans, "ui.invoke.source.window").map(|s| s.d)).line());
    let _ = writeln!(out, "  line map (request to answer):         {}", Stat::of(named(spans, "ui.source.line_map").map(|s| s.d)).line());

    let renders: Vec<&SpanLine> = spans.iter().filter(|s| s.n.starts_with("ui.render.")).collect();
    let mut by_view: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
    for span in &renders {
        by_view.entry(span.n.as_str()).or_default().push(span.d);
    }
    for (view, values) in by_view {
        let _ = writeln!(out, "  {view:<36} {}", Stat::of(values).line());
    }
    let _ = writeln!(out, "  main-thread stalls over 50 ms:       {}", Stat::of(named(spans, "ui.longtask").map(|s| s.d)).line());

    let logs: Vec<&SpanLine> = named(spans, "app.log_write").collect();
    let _ = writeln!(
        out,
        "  log writes:                          {} in {} writes, {} bytes",
        ms(logs.iter().map(|s| s.d).sum()),
        logs.iter().map(|s| attr(s, "writes")).sum::<u64>(),
        logs.iter().map(|s| attr(s, "bytes")).sum::<u64>()
    );
    let server: Vec<&SpanLine> = named(spans, "server.request").collect();
    let _ = writeln!(out, "  server requests waiting for the platform lock: {}", Stat::of(server.iter().map(|s| attr(s, "lock_wait_us"))).line());
    let client: Vec<&SpanLine> = named(spans, "client.request").filter(|s| !WAITING_REQUESTS.contains(&s.req.as_str())).collect();
    let _ = writeln!(
        out,
        "  debug protocol ({} round trips): encode {}  decode {}  largest response {} bytes",
        client.len(),
        ms(client.iter().map(|s| attr(s, "encode_us")).sum()),
        ms(client.iter().map(|s| attr(s, "decode_us")).sum()),
        client.iter().map(|s| attr(s, "resp_bytes")).max().unwrap_or(0)
    );
    let _ = writeln!(out, "  events emitted to the webview:       {}", Stat::of(spans.iter().filter(|s| s.n.starts_with("app.emit.")).map(|s| s.d)).line());

    // --- modules ----------------------------------------------------------
    let mut by_module: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    for span in spans {
        if let Some(index) = span.a.get("module") {
            by_module.entry(*index).or_default().push(span.d);
        }
    }
    let mut modules: Vec<(u64, Stat)> = by_module.into_iter().map(|(i, values)| (i, Stat::of(values))).collect();
    modules.sort_by_key(|(_, stat)| std::cmp::Reverse(stat.total()));
    if !modules.is_empty() {
        let _ = writeln!(out, "\n-- modules by time spent on them");
        for (index, stat) in modules.iter().take(10) {
            let (label, size) = match report.modules.get(&(*index as u32)) {
                Some(m) => (m.name.as_str(), m.size),
                None => ("?", 0),
            };
            let symbols = named(spans, "symbols.load_module").filter(|s| s.a.get("module") == Some(index)).map(|s| attr(s, "symbols")).max();
            let symbols = symbols.map(|n| n.to_string()).unwrap_or_else(|| "?".into());
            let _ = writeln!(out, "  {label:<28} {:>7} KB {symbols:>8} symbols  {}", size / 1024, stat.line());
        }
    }
    let _ = writeln!(out);
}

/// A plain-text report of one recording, or of every recording in a folder.
pub fn summarize(path: &Path) -> Result<String, String> {
    let mut files: Vec<PathBuf> = if path.is_dir() {
        fs::read_dir(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "ndjson"))
            .collect()
    } else {
        vec![path.to_path_buf()]
    };
    files.sort();
    if files.is_empty() {
        return Err(format!("no .ndjson recordings in {}", path.display()));
    }
    let mut out = String::new();
    for file in files {
        let report = read_report(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        summarize_report(&file.display().to_string(), &report, &mut out);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn run_info(run: &str) -> RunInfo {
        RunInfo { v: 1, run: run.into(), app: "0.0.0".into(), os: "windows".into(), arch: "x86_64".into(), cpus: 8 }
    }

    fn span(n: &str, req: &str, d: u64, attrs: &[(&str, u64)]) -> Line {
        Line::Span(SpanLine { t: 1, d, n: n.into(), req: req.into(), th: 1, s: None, a: attrs.iter().map(|(k, v)| (k.to_string(), *v)).collect() })
    }

    #[test]
    fn roles_come_from_their_flags_only() {
        assert_eq!(role_from_argv(&args(&[])), None);
        assert_eq!(role_from_argv(&args(&["--listen", "0.0.0.0:9000", "--out", "x"])), None);
        assert_eq!(
            role_from_argv(&args(&["--telemetry-collect", "127.0.0.1:4318"])),
            Some(Role::Collect { addr: "127.0.0.1:4318".into(), out: PathBuf::from("telemetry") })
        );
        assert_eq!(
            role_from_argv(&args(&["--telemetry-collect", "127.0.0.1:0", "--out", "d"])),
            Some(Role::Collect { addr: "127.0.0.1:0".into(), out: PathBuf::from("d") })
        );
        assert_eq!(
            role_from_argv(&args(&["--telemetry-summarize", "d", "--out", "r.txt"])),
            Some(Role::Summarize { path: PathBuf::from("d"), out: Some(PathBuf::from("r.txt")) })
        );
    }

    #[test]
    fn a_run_id_cannot_leave_the_output_folder() {
        assert!(is_run_id("0123456789abcdef0123456789abcdef"));
        for bad in ["", "short", "../../etc/passwd", r"..\..\evil0000", "aaaaaaaa/bbbbbbbb", "aaaaaaaa.ndjson"] {
            assert!(!is_run_id(bad), "{bad}");
        }
        let dir = TempDir::new("joybug-telemetry-test");
        let batch = Batch { run: run_info("../../escape00"), lines: vec![] };
        assert!(store(&dir.0, &batch).is_err());
    }

    #[test]
    fn stored_batches_summarize() {
        let dir = TempDir::new("joybug-telemetry-test");
        let dir = &dir.0;
        let run = run_info("0123456789abcdef");
        let first = Batch {
            run: run.clone(),
            lines: vec![
                Line::Module(ModuleLine { i: 0, name: "ntdll.dll".into(), system: true, size: 2048 * 1024 }),
                span("symbols.wait_for_loading", "DisassembleFunction", 5_000_000, &[("timed_out", 1), ("module", 0)]),
                span("app.command", "DisassembleFunction", 5_100_000, &[("queue_us", 300)]),
            ],
        };
        let second = Batch {
            run,
            lines: vec![
                span("ui.step", "", 40_000, &[("event_us", 30_000), ("commit_us", 6_000), ("paint_us", 4_000)]),
                span("ui.asm.load.patches_updated", "", 9_000, &[("rows", 40)]),
                span("ui.invoke.source.open", "", 12_340, &[("lines", 100)]),
                Line::Dropped { t: 1, count: 2 },
            ],
        };
        let path = store(dir, &first).unwrap();
        assert_eq!(store(dir, &second).unwrap(), path);

        // One run line, then every line of both batches.
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1 + 3 + 4);
        assert_eq!(text.matches(r#""kind":"run""#).count(), 1);

        let report = summarize(dir).unwrap();
        assert!(report.contains("5 spans"), "{report}");
        assert!(report.contains("(1 hit the wait timeout)"), "{report}");
        assert!(report.contains("patches_updated 1"), "{report}");
        assert!(report.contains("file open, as the view saw it:        n=1"), "{report}");
        assert!(report.contains("2 dropped"), "{report}");
        assert!(report.contains("ntdll.dll"), "{report}");
        assert!(report.contains("p50=  40.00ms"), "{report}");
    }

    #[test]
    fn percentiles_use_the_nearest_rank() {
        let stat = Stat::of([5, 1, 3, 2, 4]);
        assert_eq!((stat.pct(50), stat.pct(95), stat.max(), stat.total()), (3, 5, 5, 15));
        assert_eq!(Stat::default().pct(50), 0);
    }
}
