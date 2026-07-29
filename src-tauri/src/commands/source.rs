use crate::error::{Error, Result};
use crate::session::source::{
    emit_source_error, emit_source_file_line_map, emit_source_files_listed,
    emit_source_line_resolved,
};
use crate::session::UICommand;
use crate::settings::SettingsState;
use crate::state::SessionStatesMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
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
        |oob, pid| match oob.resolve_address_to_line(pid, address_val) {
            Ok(info) => emit_source_line_resolved(&app_handle, session_id.clone(), address_val, info),
            Err(e) => emit_source_error(&app_handle, "source-line-error", session_id.clone(), e.to_string()),
        },
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
// The Source view never loads a whole file: `open_source_file` streams it once
// to count lines, verify the checksum, and build a *sparse* offset index (one
// byte offset every INDEX_STRIDE lines). `read_source_window` then seeks via the
// index and returns only the requested line range, so multi-GB files display
// with bounded memory in both the backend and the webview.
// ---------------------------------------------------------------------------

/// Record a byte offset every this many lines. The index for a 250 M-line file is
/// then ~122 K entries (~1 MB); a window read seeks then scans at most this many
/// lines forward.
const INDEX_STRIDE: u64 = 2048;

/// Sanity ceiling — far above any real source file; guards against a bad path.
const MAX_SOURCE_FILE_SIZE: u64 = 8 * 1024 * 1024 * 1024;

/// Streaming scan buffer.
const SCAN_BUF: usize = 1 << 20;

/// Most windowed reads a single view keeps around; small LRU.
const MAX_CACHED_INDEXES: usize = 8;

/// Sparse line index for one resolved file path, plus the identity used to detect
/// edits (so a changed file is re-indexed).
struct LineIndex {
    len: u64,
    mtime_ns: u128,
    line_count: u64,
    /// `offsets[k]` = byte offset of the first line of block `k`, i.e. line
    /// `k * INDEX_STRIDE + 1` (1-based). `offsets[0]` is always 0.
    offsets: Vec<u64>,
}

/// Managed LRU cache of line indexes, keyed by resolved path. Clones share the
/// same cache, so a handle can move into `run_blocking` closures.
#[derive(Default, Clone)]
pub struct SourceIndexCache {
    inner: Arc<Mutex<Vec<(String, Arc<LineIndex>)>>>,
}

impl SourceIndexCache {
    fn get(&self, path: &str, len: u64, mtime_ns: u128) -> Option<Arc<LineIndex>> {
        let mut cache = self.inner.lock().unwrap();
        if let Some(pos) = cache.iter().position(|(p, _)| p == path) {
            let (_, idx) = &cache[pos];
            if idx.len == len && idx.mtime_ns == mtime_ns {
                let entry = cache.remove(pos);
                let idx = entry.1.clone();
                cache.push(entry); // move-to-front (most-recently-used at the end)
                return Some(idx);
            }
            cache.remove(pos); // stale — drop it
        }
        None
    }

    fn put(&self, path: String, idx: Arc<LineIndex>) {
        let mut cache = self.inner.lock().unwrap();
        cache.retain(|(p, _)| p != &path);
        cache.push((path, idx));
        while cache.len() > MAX_CACHED_INDEXES {
            cache.remove(0);
        }
    }
}

/// Metadata returned by `open_source_file`.
#[derive(serde::Serialize)]
pub struct SourceFileMeta {
    /// The path actually opened (after source-map substitution).
    pub resolved_path: String,
    /// Total line count (a maximal run of non-newline chars, `\n`- or EOF-terminated).
    pub line_count: u64,
    /// Whether the on-disk file matches the PDB's recorded checksum. `None` when
    /// the PDB has no checksum (e.g. MASM) or the kind is unknown.
    pub checksum_matches: Option<bool>,
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

/// Incremental checksum over the streamed bytes, chosen by PDB checksum kind.
enum HashState {
    Md5(md5::Md5),
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
}

impl HashState {
    fn new(kind: &str) -> Option<Self> {
        match kind {
            "md5" => Some(HashState::Md5(md5::Md5::default())),
            "sha1" => Some(HashState::Sha1(sha1::Sha1::default())),
            "sha256" => Some(HashState::Sha256(sha2::Sha256::default())),
            _ => None,
        }
    }
    fn update(&mut self, data: &[u8]) {
        use md5::Digest;
        match self {
            HashState::Md5(h) => h.update(data),
            HashState::Sha1(h) => h.update(data),
            HashState::Sha256(h) => h.update(data),
        }
    }
    fn finalize_hex(self) -> String {
        use md5::Digest;
        let bytes: Vec<u8> = match self {
            HashState::Md5(h) => h.finalize().to_vec(),
            HashState::Sha1(h) => h.finalize().to_vec(),
            HashState::Sha256(h) => h.finalize().to_vec(),
        };
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Stream `path` once: build the sparse line index, count lines, and (when
/// `hasher` is set) compute the content checksum.
fn build_index(path: &Path, mut hasher: Option<HashState>) -> std::io::Result<(LineIndex, Option<String>)> {
    let file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    let len = meta.len();
    let mut reader = BufReader::with_capacity(SCAN_BUF, file);

    let mut offsets = vec![0u64];
    let mut total: u64 = 0; // bytes consumed so far (offset of buf[0])
    let mut line: u64 = 1; // running line number (incremented per '\n')
    let mut any = false;
    let mut last_byte = 0u8;
    let mut buf = vec![0u8; SCAN_BUF];

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        any = true;
        last_byte = buf[n - 1];
        if let Some(h) = hasher.as_mut() {
            h.update(&buf[..n]);
        }
        // Walk newline positions (vectorized) rather than every byte.
        let mut off = 0usize;
        while let Some(rel) = buf[off..n].iter().position(|&b| b == b'\n') {
            let next_line_start = total + (off + rel + 1) as u64;
            line += 1;
            if (line - 1) % INDEX_STRIDE == 0 {
                offsets.push(next_line_start);
            }
            off += rel + 1;
        }
        total += n as u64;
    }

    let newlines = line - 1;
    let line_count = if !any {
        0
    } else if last_byte == b'\n' {
        newlines // trailing newline → no line after it
    } else {
        newlines + 1
    };

    let checksum = hasher.map(|h| h.finalize_hex());
    Ok((
        LineIndex { len, mtime_ns: mtime_ns(&meta), line_count, offsets },
        checksum,
    ))
}

/// Open a source file for windowed reading: resolve the path, index it, verify
/// the checksum, and cache the index. Needs no debug session. The body runs on
/// the blocking pool (see `run_blocking`) — the indexing/checksum pass, or a
/// slow path probe like a dead UNC prefix from a PDB, would otherwise freeze
/// the UI (sync command) or stall the shared async workers (bare async).
#[tauri::command]
pub async fn open_source_file(
    file_path: String,
    checksum_kind: Option<String>,
    checksum: Option<String>,
    settings: State<'_, SettingsState>,
    index_cache: State<'_, SourceIndexCache>,
) -> Result<SourceFileMeta> {
    let source_map = settings.lock().unwrap().source_map.clone();
    let index_cache = index_cache.inner().clone();
    super::run_blocking(move || {
        open_source_file_impl(file_path, checksum_kind, checksum, source_map, index_cache)
    })
    .await
}

fn open_source_file_impl(
    file_path: String,
    checksum_kind: Option<String>,
    checksum: Option<String>,
    source_map: Vec<(String, String)>,
    index_cache: SourceIndexCache,
) -> Result<SourceFileMeta> {
    let resolved = resolve_source_path(&file_path, &source_map)
        .ok_or_else(|| Error::InvalidParameter(format!("Source file not found: {}", file_path)))?;
    let resolved_path = resolved.display().to_string();

    let meta = std::fs::metadata(&resolved)
        .map_err(|e| Error::InvalidParameter(format!("Cannot stat {}: {}", resolved_path, e)))?;
    if meta.len() > MAX_SOURCE_FILE_SIZE {
        return Err(Error::InvalidParameter(format!(
            "Source file too large ({} bytes): {}",
            meta.len(),
            resolved_path
        )));
    }

    // Verify only when the PDB recorded a usable checksum.
    let want = match (checksum_kind.as_deref(), checksum.as_deref()) {
        (Some(kind), Some(sum)) if kind != "none" && !sum.is_empty() => Some((kind.to_string(), sum.to_string())),
        _ => None,
    };
    let hasher = want.as_ref().and_then(|(k, _)| HashState::new(k));

    let (index, actual) = build_index(&resolved, hasher)
        .map_err(|e| Error::InvalidParameter(format!("Cannot index {}: {}", resolved_path, e)))?;
    let checksum_matches = match (&want, &actual) {
        (Some((_, sum)), Some(actual)) => Some(actual.eq_ignore_ascii_case(sum)),
        _ => None,
    };

    let line_count = index.line_count;
    index_cache.put(resolved_path.clone(), Arc::new(index));
    info!("Indexed source file {} ({} lines, checksum_matches={:?})", resolved_path, line_count, checksum_matches);

    Ok(SourceFileMeta { resolved_path, line_count, checksum_matches })
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
    let path = PathBuf::from(&resolved_path);
    let meta = std::fs::metadata(&path)
        .map_err(|e| Error::InvalidParameter(format!("Cannot stat {}: {}", resolved_path, e)))?;
    let len = meta.len();
    let mtime = mtime_ns(&meta);

    let index = match index_cache.get(&resolved_path, len, mtime) {
        Some(idx) => idx,
        None => {
            // Evicted or first window without an open — rebuild (no checksum pass).
            let (idx, _) = build_index(&path, None)
                .map_err(|e| Error::InvalidParameter(format!("Cannot index {}: {}", resolved_path, e)))?;
            let idx = Arc::new(idx);
            index_cache.put(resolved_path.clone(), idx.clone());
            idx
        }
    };

    let start_line = start_line.max(1);
    if start_line > index.line_count {
        return Ok(SourceWindow { start_line, lines: Vec::new() });
    }

    // Seek to the nearest indexed block, then scan forward to `start_line`.
    let block = ((start_line - 1) / INDEX_STRIDE) as usize;
    let base = index.offsets.get(block).copied().unwrap_or(0);
    let skip = (start_line - 1) - (block as u64) * INDEX_STRIDE;

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
