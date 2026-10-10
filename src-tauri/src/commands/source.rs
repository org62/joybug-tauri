use crate::error::{Error, Result};
use crate::session::source::{
    emit_source_error, emit_source_file_line_map, emit_source_files_listed,
    resolve_and_emit_source_line,
};
use crate::session::UICommand;
use crate::settings::SettingsState;
use crate::state::SessionStatesMap;
use super::source_index::{self, ChecksumKind, IndexedFile, LineIndex};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tracing::{debug, info};

#[tauri::command]
pub fn resolve_address_to_line(
    session_id: String,
    address: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address_val = super::parse_hex_u64(&address, "address")?;
    debug!("Resolve address to line for session {} at 0x{:X}", session_id, address_val);
    super::paused_or_oob(
        &session_id,
        &session_states,
        &oob_pool,
        UICommand::ResolveAddressToLine { address: address_val },
        |oob, pid| resolve_and_emit_source_line(oob, &app_handle, session_id.clone(), pid, address_val),
    )
}

#[tauri::command]
pub fn get_source_file_line_map(
    session_id: String,
    module_base: String,
    file_path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let module_base_val = super::parse_hex_u64(&module_base, "module base")?;
    debug!("Source file line map for session {} module 0x{:X} file {} [{:?}..{:?}]", session_id, module_base_val, file_path, start_line, end_line);
    let file_path_cmd = file_path.clone();
    super::paused_or_oob(
        &session_id,
        &session_states,
        &oob_pool,
        UICommand::GetSourceFileLineMap { module_base: module_base_val, file_path: file_path_cmd, start_line, end_line },
        |oob, pid| match oob.get_source_file_line_map(pid, module_base_val, &file_path, start_line, end_line) {
            Ok((file, entries)) => emit_source_file_line_map(
                &app_handle, session_id.clone(), module_base_val, file_path.clone(), file, entries,
            ),
            Err(e) => emit_source_error(&app_handle, "source-file-line-map-error", session_id.clone(), e.to_string()),
        },
    )
}

#[tauri::command]
pub fn list_source_files(
    session_id: String,
    module_base: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let module_base_val = super::parse_hex_u64(&module_base, "module base")?;
    debug!("List source files for session {} module 0x{:X}", session_id, module_base_val);
    super::paused_or_oob(
        &session_id,
        &session_states,
        &oob_pool,
        UICommand::ListSourceFiles { module_base: module_base_val },
        |oob, pid| match oob.list_source_files(pid, module_base_val) {
            Ok(files) => emit_source_files_listed(&app_handle, session_id.clone(), module_base_val, files),
            Err(e) => emit_source_error(&app_handle, "source-files-error", session_id.clone(), e.to_string()),
        },
    )
}

// ---------------------------------------------------------------------------
// Windowed source-file reading.
//
// The Source view never loads a whole file: `open_source_file` indexes it once
// (see `source_index`: a parallel pass, cached on disk) and `read_source_window`
// then seeks via the index and returns only the requested line range, so
// multi-GB files display with bounded memory in both the backend and the
// webview. The checksum against the module's debug info is verified in the
// background and reported by `source-checksum-verified`.
// ---------------------------------------------------------------------------

/// Sanity ceiling — far above any real source file; guards against a bad path.
const MAX_SOURCE_FILE_SIZE: u64 = 8 * 1024 * 1024 * 1024;

/// Most windowed reads a single view keeps around; small LRU.
const MAX_CACHED_INDEXES: usize = 8;

/// Managed LRU cache of indexed files, keyed by resolved path. Clones share the
/// same cache, so a handle can move into `run_blocking` closures.
#[derive(Default, Clone)]
pub struct SourceIndexCache {
    inner: Arc<Mutex<Vec<(String, Arc<IndexedFile>)>>>,
    /// One lock per path being indexed, so a file is read once however many
    /// requests arrive for it meanwhile (a view re-asks on every step).
    indexing: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>>,
}

impl SourceIndexCache {
    fn get(&self, path: &str, len: u64, mtime_ns: u128) -> Option<Arc<IndexedFile>> {
        let mut cache = self.inner.lock().unwrap();
        if let Some(pos) = cache.iter().position(|(p, _)| p == path) {
            let (_, file) = &cache[pos];
            if file.index.len == len && file.index.mtime_ns == mtime_ns {
                let entry = cache.remove(pos);
                let file = entry.1.clone();
                cache.push(entry); // move-to-front (most-recently-used at the end)
                return Some(file);
            }
            cache.remove(pos); // stale — drop it
        }
        None
    }

    fn put(&self, path: String, file: Arc<IndexedFile>) {
        let mut cache = self.inner.lock().unwrap();
        cache.retain(|(p, _)| p != &path);
        cache.push((path, file));
        while cache.len() > MAX_CACHED_INDEXES {
            cache.remove(0);
        }
    }

    /// The index of the file at `path`: from memory, else from the disk cache,
    /// else built now (and stored). Says where it came from, for telemetry.
    fn index(&self, resolved_path: &str, path: &Path, len: u64, mtime: u128) -> std::io::Result<(Arc<IndexedFile>, IndexSource)> {
        if let Some(file) = self.get(resolved_path, len, mtime) {
            return Ok((file, IndexSource::Memory));
        }
        // Single-flight: whoever gets here first indexes; the others wait for
        // it and find the result in memory.
        let gate = self.indexing.lock().unwrap().entry(resolved_path.to_string()).or_default().clone();
        let _indexing = gate.lock().unwrap();
        if let Some(file) = self.get(resolved_path, len, mtime) {
            self.indexing.lock().unwrap().remove(resolved_path);
            return Ok((file, IndexSource::Memory));
        }
        let indexed = self.load_or_build(resolved_path, path, len, mtime);
        self.indexing.lock().unwrap().remove(resolved_path);
        indexed
    }

    fn load_or_build(&self, resolved_path: &str, path: &Path, len: u64, mtime: u128) -> std::io::Result<(Arc<IndexedFile>, IndexSource)> {
        let (file, from) = match source_index::load(resolved_path, len, mtime) {
            Some(file) => (file, IndexSource::Disk),
            None => {
                let file = IndexedFile::new(LineIndex::build(path, mtime)?, None);
                source_index::save(resolved_path, &file);
                (file, IndexSource::Built)
            }
        };
        let file = Arc::new(file);
        self.put(resolved_path.to_string(), file.clone());
        Ok((file, from))
    }
}

/// Where a file's line index came from: the `index_from` attribute of the
/// `app.source.open` and `app.source.read_window` spans.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexSource {
    Memory = 0,
    Disk = 1,
    Built = 2,
}

/// Metadata returned by `open_source_file`.
#[derive(serde::Serialize)]
pub struct SourceFileMeta {
    /// The path actually opened (after source-map substitution).
    pub resolved_path: String,
    /// Total line count (a maximal run of non-newline chars, `\n`- or EOF-terminated).
    pub line_count: u64,
    /// Whether the on-disk file matches the PDB's recorded checksum. `None` when
    /// the PDB has no checksum (e.g. MASM), the kind is unknown, or the answer
    /// is not in yet (`checksum_pending`).
    pub checksum_matches: Option<bool>,
    /// The checksum is being verified in the background; the answer arrives as
    /// a `source-checksum-verified` event.
    pub checksum_pending: bool,
}

/// Payload of `source-checksum-verified`.
#[derive(serde::Serialize, Clone)]
struct SourceChecksumVerified {
    resolved_path: String,
    matches: bool,
}

/// One window of source lines.
#[derive(serde::Serialize)]
pub struct SourceWindow {
    /// 1-based line number of `lines[0]`.
    pub start_line: u64,
    pub lines: Vec<String>,
}

/// Resolve a compile-time PDB path against the local disk: the exact path first,
/// then each `(from, to)` prefix substitution from settings (case-insensitive).
fn resolve_source_path(file_path: &str, source_map: &[(String, String)]) -> Option<PathBuf> {
    let exact = PathBuf::from(file_path);
    if exact.is_file() {
        return Some(exact);
    }
    let lower = file_path.to_lowercase();
    for (from, to) in source_map {
        let from = from.trim();
        if from.is_empty() {
            continue;
        }
        if lower.starts_with(&from.to_lowercase()) {
            let mapped = PathBuf::from(format!("{}{}", to, &file_path[from.len()..]));
            if mapped.is_file() {
                return Some(mapped);
            }
        }
    }
    None
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Open a source file for windowed reading: resolve the path and index it (or
/// find its index in the cache). Needs no debug session. The body runs on the
/// blocking pool (see `run_blocking`) — indexing a file not seen before, or a
/// slow path probe like a dead UNC prefix from a PDB, would otherwise freeze
/// the UI (sync command) or stall the shared async workers (bare async).
///
/// The checksum against the module's debug info is not part of opening: when
/// it is not already known for this file it is verified on a background thread
/// (`checksum_pending`) and reported by `source-checksum-verified`.
#[tauri::command]
pub async fn open_source_file(
    file_path: String,
    checksum_kind: Option<String>,
    checksum: Option<String>,
    settings: State<'_, SettingsState>,
    index_cache: State<'_, SourceIndexCache>,
    app_handle: tauri::AppHandle,
) -> Result<SourceFileMeta> {
    let source_map = settings.lock().unwrap().source_map.clone();
    let index_cache = index_cache.inner().clone();
    super::run_blocking(move || {
        open_source_file_impl(file_path, checksum_kind, checksum, source_map, index_cache, app_handle)
    })
    .await
}

fn open_source_file_impl(
    file_path: String,
    checksum_kind: Option<String>,
    checksum: Option<String>,
    source_map: Vec<(String, String)>,
    index_cache: SourceIndexCache,
    app_handle: tauri::AppHandle,
) -> Result<SourceFileMeta> {
    // Path resolution probes the disk through the source map; indexing reads
    // the whole file unless its index is cached.
    let mut span = crate::telemetry::span("app.source.open");
    let started = std::time::Instant::now();
    let resolved = resolve_source_path(&file_path, &source_map)
        .ok_or_else(|| Error::InvalidParameter(format!("Source file not found: {}", file_path)))?;
    let resolved_path = resolved.display().to_string();
    span.attr_elapsed("locate_us", started);

    let meta = std::fs::metadata(&resolved)
        .map_err(|e| Error::InvalidParameter(format!("Cannot stat {}: {}", resolved_path, e)))?;
    if meta.len() > MAX_SOURCE_FILE_SIZE {
        return Err(Error::InvalidParameter(format!(
            "Source file too large ({} bytes): {}",
            meta.len(),
            resolved_path
        )));
    }
    span.attr("bytes", meta.len());

    let (file, index_from) = index_cache
        .index(&resolved_path, &resolved, meta.len(), mtime_ns(&meta))
        .map_err(|e| Error::InvalidParameter(format!("Cannot index {}: {}", resolved_path, e)))?;
    let line_count = file.index.line_count;
    span.attr("index_from", index_from as u64);
    span.attr("lines", line_count);

    // Verify only when the PDB recorded a checksum we can compute.
    let want = match (checksum_kind.as_deref().and_then(ChecksumKind::parse), checksum) {
        (Some(kind), Some(sum)) if !sum.is_empty() => Some((kind, sum)),
        _ => None,
    };
    let (checksum_matches, checksum_pending) = match want {
        None => (None, false),
        Some((kind, expected)) => match file.checksum(kind) {
            Some(actual) => (Some(actual.eq_ignore_ascii_case(&expected)), false),
            None => {
                verify_checksum_in_background(app_handle, file, resolved, resolved_path.clone(), kind, expected);
                (None, true)
            }
        },
    };
    span.attr("checksum_pending", checksum_pending as u64);
    info!(
        "Opened source file {} ({} lines, checksum_matches={:?}, pending={})",
        resolved_path, line_count, checksum_matches, checksum_pending
    );

    Ok(SourceFileMeta { resolved_path, line_count, checksum_matches, checksum_pending })
}

/// Hash the file on a thread of its own, remember the result with the index
/// (in memory and on disk) and report whether it matches `expected`. One
/// verification per file at a time: an open that finds one under way just
/// waits for its event.
fn verify_checksum_in_background(
    app_handle: tauri::AppHandle,
    file: Arc<IndexedFile>,
    path: PathBuf,
    resolved_path: String,
    kind: ChecksumKind,
    expected: String,
) {
    if !file.begin_verifying() {
        return;
    }
    std::thread::spawn(move || {
        let mut span = crate::telemetry::span("app.source.checksum");
        span.attr("bytes", file.index.len);
        let computed = source_index::file_checksum(&path, kind);
        drop(span);
        match computed {
            Ok(actual) => {
                file.set_checksum(kind, &actual);
                source_index::save(&resolved_path, &file);
                let verified = SourceChecksumVerified { resolved_path, matches: actual.eq_ignore_ascii_case(&expected) };
                let _ = app_handle.emit("source-checksum-verified", verified);
            }
            Err(e) => tracing::warn!("Checksum of {} not verified: {}", resolved_path, e),
        }
        file.end_verifying();
    });
}

/// Read `count` lines starting at `start_line` (1-based) from an already-opened
/// source file. Uses the cached sparse index (rebuilding it if evicted).
/// Runs on the blocking pool for the same reason as `open_source_file`.
#[tauri::command]
pub async fn read_source_window(
    resolved_path: String,
    start_line: u64,
    count: u64,
    index_cache: State<'_, SourceIndexCache>,
) -> Result<SourceWindow> {
    let index_cache = index_cache.inner().clone();
    super::run_blocking(move || read_source_window_impl(resolved_path, start_line, count, index_cache)).await
}

fn read_source_window_impl(
    resolved_path: String,
    start_line: u64,
    count: u64,
    index_cache: SourceIndexCache,
) -> Result<SourceWindow> {
    let mut span = crate::telemetry::span("app.source.read_window");
    span.attr("lines", count);
    let path = PathBuf::from(&resolved_path);
    let meta = std::fs::metadata(&path)
        .map_err(|e| Error::InvalidParameter(format!("Cannot stat {}: {}", resolved_path, e)))?;
    let len = meta.len();
    let mtime = mtime_ns(&meta);

    // Normally in memory from the open; evicted or changed, it comes back
    // from the disk cache or a rebuild.
    let (file, index_from) = index_cache
        .index(&resolved_path, &path, len, mtime)
        .map_err(|e| Error::InvalidParameter(format!("Cannot index {}: {}", resolved_path, e)))?;
    span.attr("index_from", index_from as u64);
    let index = &file.index;

    let start_line = start_line.max(1);
    if start_line > index.line_count {
        return Ok(SourceWindow { start_line, lines: Vec::new() });
    }

    // Seek to the indexed block the line starts in (or just before), then
    // read past the line breaks between there and `start_line`.
    let (base, skip) = index.seek_for_line(start_line);

    let file = std::fs::File::open(&path)
        .map_err(|e| Error::InvalidParameter(format!("Cannot read {}: {}", resolved_path, e)))?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(base))
        .map_err(|e| Error::InvalidParameter(format!("Seek failed in {}: {}", resolved_path, e)))?;

    let mut scratch = Vec::new();
    for _ in 0..skip {
        scratch.clear();
        if reader.read_until(b'\n', &mut scratch).unwrap_or(0) == 0 {
            break;
        }
    }

    let cap = count.min(index.line_count.saturating_sub(start_line - 1)) as usize;
    let mut lines = Vec::with_capacity(cap.min(64_000));
    for _ in 0..count {
        scratch.clear();
        let n = reader.read_until(b'\n', &mut scratch).unwrap_or(0);
        if n == 0 {
            break;
        }
        while matches!(scratch.last(), Some(b'\n') | Some(b'\r')) {
            scratch.pop();
        }
        lines.push(String::from_utf8_lossy(&scratch).into_owned());
    }

    Ok(SourceWindow { start_line, lines })
}
