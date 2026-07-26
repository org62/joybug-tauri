use tauri::{AppHandle, Emitter};
use tracing::{debug, error};

use super::types::DebugSession;

// Payloads are shared with the OOB fallback path in commands/source.rs so both
// paths emit byte-identical events. Addresses travel as hex strings (JS precision).

#[derive(serde::Serialize)]
pub(crate) struct SourceLineInfoPayload {
    pub module_path: String,
    pub module_base: String,
    pub file_path: String,
    pub line: u32,
    pub checksum_kind: String,
    pub checksum: String,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceLineResolvedPayload {
    pub session_id: String,
    pub address: String,
    pub info: Option<SourceLineInfoPayload>,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceLineMapEntry {
    pub address: String,
    pub rva: u32,
    pub length: u32,
    pub line: u32,
    pub line_end: u32,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceFileLineMapPayload {
    pub session_id: String,
    pub module_base: String,
    pub file_path: String,
    pub checksum_kind: Option<String>,
    pub checksum: Option<String>,
    pub entries: Vec<SourceLineMapEntry>,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceFilePayload {
    pub path: String,
    pub checksum_kind: String,
    pub checksum: String,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceFilesListedPayload {
    pub session_id: String,
    pub module_base: String,
    pub files: Vec<SourceFilePayload>,
}

#[derive(serde::Serialize)]
pub(crate) struct SourceErrorPayload {
    pub session_id: String,
    pub error: String,
}

pub(crate) fn emit_source_line_resolved(
    handle: &AppHandle,
    session_id: String,
    address: u64,
    info: Option<joybug_core::protocol_io::AddressLineInfo>,
) {
    let payload = SourceLineResolvedPayload {
        session_id,
        address: format!("{:#X}", address),
        info: info.map(|i| SourceLineInfoPayload {
            module_path: i.module_path,
            module_base: format!("{:#X}", i.module_base),
            file_path: i.file.path,
            line: i.line_entry.line_start,
            checksum_kind: i.file.checksum_kind,
            checksum: i.file.checksum,
        }),
    };
    if let Err(e) = handle.emit("source-line-resolved", &payload) {
        error!("Failed to emit source-line-resolved event: {}", e);
    }
}

pub(crate) fn emit_source_file_line_map(
    handle: &AppHandle,
    session_id: String,
    module_base: u64,
    file_path: String,
    file: Option<joybug_core::interfaces::SourceFileEntry>,
    entries: Vec<joybug_core::interfaces::LineEntry>,
) {
    let payload = SourceFileLineMapPayload {
        session_id,
        module_base: format!("{:#X}", module_base),
        file_path,
        checksum_kind: file.as_ref().map(|f| f.checksum_kind.clone()),
        checksum: file.as_ref().map(|f| f.checksum.clone()),
        entries: entries
            .iter()
            .map(|e| SourceLineMapEntry {
                address: format!("{:#X}", module_base + e.rva as u64),
                rva: e.rva,
                length: e.length,
                line: e.line_start,
                line_end: e.line_end,
            })
            .collect(),
    };
    if let Err(e) = handle.emit("source-file-line-map", &payload) {
        error!("Failed to emit source-file-line-map event: {}", e);
    }
}

pub(crate) fn emit_source_files_listed(
    handle: &AppHandle,
    session_id: String,
    module_base: u64,
    files: Vec<joybug_core::interfaces::SourceFileEntry>,
) {
    let payload = SourceFilesListedPayload {
        session_id,
        module_base: format!("{:#X}", module_base),
        files: files
            .into_iter()
            .map(|f| SourceFilePayload {
                path: f.path,
                checksum_kind: f.checksum_kind,
                checksum: f.checksum,
            })
            .collect(),
    };
    if let Err(e) = handle.emit("source-files-listed", &payload) {
        error!("Failed to emit source-files-listed event: {}", e);
    }
}

pub(crate) fn emit_source_error(handle: &AppHandle, event: &str, session_id: String, error_msg: String) {
    error!("Source request failed ({}): {}", event, error_msg);
    let _ = handle.emit(event, &SourceErrorPayload { session_id, error: error_msg });
}

fn session_id_of(session: &DebugSession) -> String {
    session.state.lock().unwrap().id.clone()
}

/// Resolve an address to its `(source file path, line)` pair, best-effort.
/// Both a resolve error and missing line info collapse to `None`.
pub(crate) fn resolve_file_line(session: &mut DebugSession, pid: u32, address: u64) -> Option<(String, u32)> {
    session
        .resolve_address_to_line(pid, address)
        .ok()
        .flatten()
        .map(|i| (i.file.path, i.line_entry.line_start))
}

/// Resolve an address to file:line and emit `source-line-resolved`.
pub(crate) fn process_resolve_address_to_line(
    session: &mut DebugSession,
    app_handle: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    address: u64,
) {
    let pid = event.pid();
    debug!("📤 Processing resolve-address-to-line: pid={}, address=0x{:X}", pid, address);
    let Some(handle) = app_handle.as_ref() else { return };
    let session_id = session_id_of(session);
    match session.resolve_address_to_line(pid, address) {
        Ok(info) => emit_source_line_resolved(handle, session_id, address, info),
        Err(e) => emit_source_error(handle, "source-line-error", session_id, e.to_string()),
    }
}

/// Fetch the line map for one source file (bounded to `start_line..=end_line`
/// when given) and emit `source-file-line-map`.
pub(crate) fn process_get_source_file_line_map(
    session: &mut DebugSession,
    app_handle: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    module_base: u64,
    file_path: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
) {
    let pid = event.pid();
    debug!("📤 Processing source-file-line-map: pid={}, module_base=0x{:X}, file={}, range={:?}..{:?}", pid, module_base, file_path, start_line, end_line);
    let Some(handle) = app_handle.as_ref() else { return };
    let session_id = session_id_of(session);
    match session.get_source_file_line_map(pid, module_base, file_path, start_line, end_line) {
        Ok((file, entries)) => {
            emit_source_file_line_map(handle, session_id, module_base, file_path.to_string(), file, entries)
        }
        Err(e) => emit_source_error(handle, "source-file-line-map-error", session_id, e.to_string()),
    }
}

/// List a module's source files and emit `source-files-listed`.
pub(crate) fn process_list_source_files(
    session: &mut DebugSession,
    app_handle: &Option<AppHandle>,
    event: &joybug_core::protocol_io::DebugEvent,
    module_base: u64,
) {
    let pid = event.pid();
    debug!("📤 Processing list-source-files: pid={}, module_base=0x{:X}", pid, module_base);
    let Some(handle) = app_handle.as_ref() else { return };
    let session_id = session_id_of(session);
    match session.list_source_files(pid, module_base) {
        Ok(files) => emit_source_files_listed(handle, session_id, module_base, files),
        Err(e) => emit_source_error(handle, "source-files-error", session_id, e.to_string()),
    }
}
