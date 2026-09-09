//! Session-independent PE file viewer/modifier commands.
//!
//! Unlike the module-info commands (which require a live debug session and a
//! module mapped in the target), these operate on a PE file opened directly
//! from disk through joybug-core's `static_pe::PeImage`, which owns the file
//! bytes (editable by the hex view, written back by `pe_save`), the parsed
//! structures, optional PDB symbols, the loader-style mapped image, the xref
//! index and process-less emulation. Images are held in `PeFilesState`, keyed
//! by path.
//!
//! PE32 (x86) and PE32+ (x64, ARM64) images are both supported; the parser is
//! the format-agnostic pelite wrap and the header-field offset table below
//! branches on the optional header's `Magic`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use tauri::State;
use tracing::info;

use crate::error::{Error, Result};
use crate::session::helpers::effective_op_str;
use crate::session::types::{EmulationResultPayload, SerializableInstruction, SymbolData};
use crate::session::{instruction_info, EmulationOutcome};
use joybug_core::pe_types::ModuleExtraInfo;
use joybug_core::protocol::{EmulationMode, StringEncodingFilter, StringHit};
use joybug_core::static_pe::{discover_symbols, nt_headers_offset, EmulateSpec, PeImage, PeSymbolLoad};

// Arc so async commands can move a handle into `spawn_blocking` — the heavy
// commands (file read/parse, PDB load, scans, xref sweeps, emulation) must run
// off the async runtime: they block for long stretches, and the symbol provider
// owns its own tokio runtime, which cannot be dropped on an async worker thread.
pub type PeFilesState = Arc<RwLock<HashMap<String, PeImage>>>;

use super::run_blocking;

/// Run `f` with a shared borrow of the open file for `path`. Read-only commands
/// go through here so they don't serialize behind each other.
fn with_file<R>(
    pe_files: &PeFilesState,
    path: &str,
    f: impl FnOnce(&PeImage) -> Result<R>,
) -> Result<R> {
    let files = pe_files.read().unwrap();
    let file = files
        .get(path)
        .ok_or_else(|| Error::InvalidParameter(format!("PE file not open: {}", path)))?;
    f(file)
}

/// Run `f` with a mutable borrow of the open file for `path`.
fn with_file_mut<R>(
    pe_files: &PeFilesState,
    path: &str,
    f: impl FnOnce(&mut PeImage) -> Result<R>,
) -> Result<R> {
    let mut files = pe_files.write().unwrap();
    let file = files
        .get_mut(path)
        .ok_or_else(|| Error::InvalidParameter(format!("PE file not open: {}", path)))?;
    f(file)
}

/// Summary returned when a PE file is opened. `info` mirrors the session-based
/// `module-extra-info` payload so the frontend can reuse the structure views.
#[derive(Serialize)]
pub struct PeFileSummary {
    pub path: String,
    pub size: usize,
    /// Load base as a hex string (JS bigint-safe).
    pub base: String,
    pub info: ModuleExtraInfo,
    pub symbols_loaded: bool,
    pub symbol_count: usize,
}

/// Open a PE file from disk, parse its structures, and hold its bytes in memory.
/// `base` overrides the load base (defaults to the file's ImageBase). If a PDB
/// is given, or one sits next to the file, symbols load automatically (local
/// only — no server download; use `pe_load_symbols` for that).
#[tauri::command]
pub async fn pe_open(
    path: String,
    base: Option<String>,
    pdb_path: Option<String>,
    pe_files: State<'_, PeFilesState>,
) -> Result<PeFileSummary> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || pe_open_impl(path, base, pdb_path, &pe_files)).await
}

fn pe_open_impl(
    path: String,
    base: Option<String>,
    pdb_path: Option<String>,
    pe_files: &PeFilesState,
) -> Result<PeFileSummary> {
    let base = base.map(|s| crate::commands::parse_hex_u64(&s, "base")).transpose()?;
    let image = PeImage::open(&path, base, pdb_path.as_deref().map(Path::new))
        .map_err(Error::InvalidParameter)?;
    let status = image.symbol_load().clone();
    let summary = PeFileSummary {
        path: path.clone(),
        size: image.file_size(),
        base: format!("0x{:X}", image.base()),
        info: image.info().clone(),
        symbols_loaded: status.loaded,
        symbol_count: status.count,
    };
    info!("Opened PE '{}' ({} bytes), symbols_loaded={} ({}){}",
        path, summary.size, status.loaded, status.count,
        status.error.as_ref().map(|e| format!(" [{}]", e)).unwrap_or_default());
    pe_files.write().unwrap().insert(path, image);
    Ok(summary)
}

/// Load (or reload) symbols for an already-open PE, allowing a symbol-server
/// download. Pass an explicit `pdb_path` to load a specific PDB.
#[tauri::command]
pub async fn pe_load_symbols(
    path: String,
    pdb_path: Option<String>,
    pe_files: State<'_, PeFilesState>,
) -> Result<PeSymbolLoad> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || {
        let (base, size) = with_file(&pe_files, &path, |file| Ok((file.base(), file.file_size())))?;
        // Symbol load may block on a network download — do it without holding the lock.
        let parsed = discover_symbols(&path, base, size, pdb_path.as_deref().map(Path::new), false);
        with_file_mut(&pe_files, &path, |file| Ok(file.set_symbols(parsed)))
    })
    .await
}

/// Search loaded symbols for the Symbol Explorer / goto box: whitespace-separated
/// tokens, ANDed, matched against the module and symbol names.
/// Async + blocking pool: the scan walks the whole symbol list (10^5+ entries
/// for big PDBs) and must not run on the main thread per keystroke.
#[tauri::command]
pub async fn pe_search_symbols(
    path: String,
    pattern: String,
    limit: usize,
    pe_files: State<'_, PeFilesState>,
) -> Result<Vec<SymbolData>> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let module_name = file.module_name();
        let out = file
            .find_symbols(&pattern, limit)
            .into_iter()
            .map(|s| SymbolData {
                name: s.name.clone(),
                module_name: module_name.to_string(),
                rva: s.rva,
                va: format!("0x{:X}", file.base() + s.rva as u64),
                display_name: format!("{}!{}", module_name, s.name),
                is_function: s.is_function,
            })
            .collect();
        Ok(out)
    }))
    .await
}

/// Read `size` bytes at `offset` from an opened PE file's in-memory buffer.
/// Returned as a raw IPC payload (JS receives an ArrayBuffer) — this is the hex
/// view's scroll path, so avoid JSON-encoding each chunk as a number array.
#[tauri::command]
pub fn pe_read_bytes(
    path: String,
    offset: usize,
    size: usize,
    pe_files: State<'_, PeFilesState>,
) -> Result<tauri::ipc::Response> {
    with_file(&pe_files, &path, |file| {
        let bytes = file.bytes();
        if offset >= bytes.len() {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
        let end = offset.saturating_add(size).min(bytes.len());
        Ok(tauri::ipc::Response::new(bytes[offset..end].to_vec()))
    })
}

/// Splice `data` into an opened PE file's in-memory buffer at `offset`. Does not
/// touch disk until `pe_save`.
#[tauri::command]
pub fn pe_write_bytes(
    path: String,
    offset: usize,
    data: Vec<u8>,
    pe_files: State<'_, PeFilesState>,
) -> Result<()> {
    with_file_mut(&pe_files, &path, |file| file.write_bytes(offset, &data).map_err(Error::InvalidParameter))
}

/// Disassemble `count` instructions starting at virtual address `va`. Symbolized
/// when a PDB is loaded. Instructions are labeled by VA (base + RVA) so operands
/// and branch targets resolve correctly.
#[tauri::command]
pub async fn pe_disassemble(
    path: String,
    va: u64,
    count: usize,
    pe_files: State<'_, PeFilesState>,
) -> Result<Vec<SerializableInstruction>> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let instructions = file
            .disassemble(va, count)
            .map_err(|e| Error::InvalidParameter(format!("Disassembly failed: {:?}", e)))?;
        Ok(crate::session::disassembly::serialize_instructions(&instructions, &[], None))
    }))
    .await
}

/// Disassemble the first instruction at each VA of an opened PE file — the PE
/// viewer's analogue of the session-side `disassemble_preview_batch`, feeding
/// the Symbols panel's per-row bytes/disasm preview. None per address outside
/// the image or undecodable.
#[tauri::command]
pub async fn pe_disassemble_preview_batch(
    path: String,
    addresses: Vec<String>,
    pe_files: State<'_, PeFilesState>,
) -> Result<Vec<Option<super::symbols::SymbolPreviewData>>> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let out = addresses
            .iter()
            .take(256)
            .map(|s| {
                let va = super::parse_hex_u64(s, "address").ok()?;
                let instr = file.disassemble(va, 1).ok()?.into_iter().next()?;
                Some(super::symbols::SymbolPreviewData::from_instruction(&instr))
            })
            .collect();
        Ok(out)
    }))
    .await
}

/// String-scan hits plus whether `PE_STRING_SCAN_CAP` truncated them.
#[derive(Serialize)]
pub struct PeStringScan {
    pub hits: Vec<StringHit>,
    pub capped: bool,
}

/// Cap on hits returned per scan — the whole set travels over IPC in one JSON
/// payload, so an uncapped broad scan of a large binary would stall the UI.
/// The `contains` prefilter runs server-side, so capped results are rare.
const PE_STRING_SCAN_CAP: usize = 100_000;

/// Scan the whole file buffer for ASCII/UTF-16 strings. Only strings containing
/// `contains` are returned (empty = all), capped at `PE_STRING_SCAN_CAP` hits;
/// the client filters, sorts, and pages. Each hit's address is its file offset.
#[tauri::command]
pub async fn pe_string_scan(
    path: String,
    min_length: usize,
    encodings: String,
    contains: String,
    pe_files: State<'_, PeFilesState>,
) -> Result<PeStringScan> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let enc: StringEncodingFilter = encodings.parse().unwrap_or_default();
        let mut hits = file.strings_in_file(min_length.max(1), enc, &contains);
        let capped = hits.len() > PE_STRING_SCAN_CAP;
        hits.truncate(PE_STRING_SCAN_CAP);
        Ok(PeStringScan { hits, capped })
    }))
    .await
}

/// One cross-reference to the queried address, with the referencing instruction.
#[derive(Serialize)]
pub struct PeXref {
    pub from: String,
    /// `call` | `jump` | `data` | `imm`.
    pub kind: String,
    /// "mnemonic operands" of the referencing instruction (symbolized when a
    /// PDB is loaded).
    pub text: String,
    /// `module!symbol+off` containing `from`, when symbols are loaded.
    pub symbol: Option<String>,
}

/// Every reference to `va` in the image's code sections: calls, jumps (direct
/// targets, or `call/jmp [slot]` when `va` is an IAT slot), static memory
/// operands and in-image immediates. The xref index is built on first use
/// (a linear sweep of the code sections) and reused until the bytes change.
#[tauri::command]
pub async fn pe_xrefs_to(
    path: String,
    va: String,
    pe_files: State<'_, PeFilesState>,
) -> Result<Vec<PeXref>> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let va = super::parse_hex_u64(&va, "va")?;
        let out = file
            .xrefs_to(va)
            .into_iter()
            .map(|x| {
                let text = file
                    .disassemble(x.from, 1)
                    .ok()
                    .and_then(|v| v.into_iter().next())
                    .map(|i| format!("{} {}", i.mnemonic, effective_op_str(&i)).trim_end().to_string())
                    .unwrap_or_default();
                PeXref {
                    from: format!("0x{:X}", x.from),
                    kind: x.kind.as_str().to_string(),
                    text,
                    symbol: file.resolve_va(x.from).map(|s| s.format_symbol()),
                }
            })
            .collect();
        Ok(out)
    }))
    .await
}

/// Emulate code from the opened file with no process behind it (see
/// `joybug_core::static_pe::emulate`): the image is mapped at its base with a
/// synthetic stack and import stubs, and the run stops at the first import
/// call, naming it. Returns the same payload the session emulation emits,
/// enriched with per-address instruction info for trace/block modes, so the
/// frontend footer renders unchanged.
#[tauri::command]
pub async fn pe_emulate(
    path: String,
    va: String,
    max_instructions: usize,
    mode: String,
    request_id: Option<String>,
    pe_files: State<'_, PeFilesState>,
) -> Result<EmulationResultPayload> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let mode: EmulationMode = mode.parse().map_err(Error::InvalidParameter)?;
        let mut spec = EmulateSpec::at(super::parse_hex_u64(&va, "va")?);
        spec.max_instructions = max_instructions.max(1);
        spec.mode = mode;

        let result = file
            .emulate(&spec)
            .map_err(|e| Error::InvalidParameter(format!("Emulation failed: {}", e)))?;

        let outcome = EmulationOutcome {
            final_pc: Some(result.final_pc),
            instructions_executed: result.instructions_executed,
            stop_reason: result.stop_reason.to_string(),
            time_us: result.emulation_time_us,
            pages_loaded: Some(result.pages_loaded),
            basic_blocks: result.basic_blocks,
            trace_text: (mode == EmulationMode::InstructionTrace)
                .then(|| joybug_core::tenet_format::traces_to_tenet(&result.register_trace, &result.memory_trace)),
            stats_text: result.stats_text,
            memory_snapshots: result.memory_snapshots,
        };
        // Per-address enrichment for the footer's trace/block rows.
        let info = instruction_info(&outcome.enrichment_addresses(mode), |addr| {
            let inst = file.disassemble(addr, 1).ok()?.into_iter().next()?;
            let symbol = file.resolve_va(inst.address).map(|s| s.format_symbol());
            Some((inst, symbol))
        });
        Ok(outcome.into_payload(String::new(), request_id, mode, info))
    }))
    .await
}

/// Write a scalar header field by symbolic name (`dos.*`, `file.*`, `opt.*`,
/// `section.<i>.*`) — the low `width` bytes of `value` are written little-endian.
/// The frontend mirrors the edit into its own parsed copy, so nothing is returned.
#[tauri::command]
pub fn pe_set_field(
    path: String,
    field: String,
    value: u64,
    pe_files: State<'_, PeFilesState>,
) -> Result<()> {
    with_file_mut(&pe_files, &path, |file| {
        let (offset, byte_len) = field_offset(file.bytes(), &field)?;
        if byte_len > 8 {
            return Err(Error::InvalidParameter(format!("Field '{}' is not a writable scalar", field)));
        }
        if offset + byte_len > file.file_size() {
            return Err(Error::InvalidParameter("Field offset out of range".into()));
        }
        // Refuse rather than silently truncate: a 64-bit value typed into a
        // PE32 `ImageBase` (4 bytes) would otherwise lose its top half.
        if byte_len < 8 && value >> (byte_len * 8) != 0 {
            return Err(Error::InvalidParameter(format!(
                "Value 0x{:X} does not fit the {}-byte field '{}'", value, byte_len, field
            )));
        }
        // Little-endian write of the low `byte_len` bytes.
        let le = value.to_le_bytes();
        file.write_bytes(offset, &le[..byte_len]).map_err(Error::InvalidParameter)
    })
}

/// Offset of the data-directory array within the optional header: right
/// after `NumberOfRvaAndSizes` (96 for PE32, 112 for PE32+).
fn datadir_base(pe32: bool) -> usize {
    80 + 4 * if pe32 { 4 } else { 8 }
}

/// (offset relative to the optional header, byte width) for an
/// IMAGE_OPTIONAL_HEADER32 / IMAGE_OPTIONAL_HEADER64 field. The two layouts
/// agree up to `BaseOfCode`; PE32 then has a 4-byte `BaseOfData` where PE32+
/// widens `ImageBase` to 8 bytes, and the four SizeOf{Stack,Heap}* fields are
/// pointer-sized, which shifts everything after them.
fn opt_field(name: &str, pe32: bool) -> Option<(usize, usize)> {
    let ptr = if pe32 { 4 } else { 8 };
    Some(match name {
        "Magic" => (0, 2),
        "MajorLinkerVersion" => (2, 1),
        "MinorLinkerVersion" => (3, 1),
        "SizeOfCode" => (4, 4),
        "SizeOfInitializedData" => (8, 4),
        "SizeOfUninitializedData" => (12, 4),
        "AddressOfEntryPoint" => (16, 4),
        "BaseOfCode" => (20, 4),
        "BaseOfData" if pe32 => (24, 4),
        "ImageBase" => (if pe32 { 28 } else { 24 }, ptr),
        "SectionAlignment" => (32, 4),
        "FileAlignment" => (36, 4),
        "MajorOperatingSystemVersion" => (40, 2),
        "MinorOperatingSystemVersion" => (42, 2),
        "MajorImageVersion" => (44, 2),
        "MinorImageVersion" => (46, 2),
        "MajorSubsystemVersion" => (48, 2),
        "MinorSubsystemVersion" => (50, 2),
        "Win32VersionValue" => (52, 4),
        "SizeOfImage" => (56, 4),
        "SizeOfHeaders" => (60, 4),
        "CheckSum" => (64, 4),
        "Subsystem" => (68, 2),
        "DllCharacteristics" => (70, 2),
        "SizeOfStackReserve" => (72, ptr),
        "SizeOfStackCommit" => (72 + ptr, ptr),
        "SizeOfHeapReserve" => (72 + 2 * ptr, ptr),
        "SizeOfHeapCommit" => (72 + 3 * ptr, ptr),
        "LoaderFlags" => (72 + 4 * ptr, 4),
        "NumberOfRvaAndSizes" => (76 + 4 * ptr, 4),
        _ => return None,
    })
}

/// (offset relative to the file header, byte width) for an IMAGE_FILE_HEADER field.
fn file_field(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "Machine" => (0, 2),
        "NumberOfSections" => (2, 2),
        "TimeDateStamp" => (4, 4),
        "PointerToSymbolTable" => (8, 4),
        "NumberOfSymbols" => (12, 4),
        "SizeOfOptionalHeader" => (16, 2),
        "Characteristics" => (18, 2),
        _ => return None,
    })
}

/// (offset relative to a section header, byte width) for an IMAGE_SECTION_HEADER field.
fn section_field(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "VirtualSize" => (8, 4),
        "VirtualAddress" => (12, 4),
        "SizeOfRawData" => (16, 4),
        "PointerToRawData" => (20, 4),
        "Characteristics" => (36, 4),
        _ => return None,
    })
}

/// Compute the (file offset, byte width) of a symbolic header field.
fn field_offset(bytes: &[u8], field: &str) -> Result<(usize, usize)> {
    let nt = nt_headers_offset(bytes)
        .ok_or_else(|| Error::InvalidParameter("Not a valid PE file".into()))?;
    let file_hdr = nt + 4; // after "PE\0\0"
    let read_u16 = |off: usize| -> Result<usize> {
        bytes.get(off..off + 2)
            .and_then(|s| s.try_into().ok())
            .map(|a| u16::from_le_bytes(a) as usize)
            .ok_or_else(|| Error::InvalidParameter("Truncated file header".into()))
    };
    let num_sections = read_u16(file_hdr + 2)?;
    let size_of_opt = read_u16(file_hdr + 16)?;
    let opt_hdr = file_hdr + 20;
    let sections = opt_hdr + size_of_opt;
    let pe32 = read_u16(opt_hdr)? == joybug_core::pe_types::IMAGE_NT_OPTIONAL_HDR32_MAGIC as usize;

    let unknown = || Error::InvalidParameter(format!("Unknown field '{}'", field));
    let (scope, name) = field.split_once('.').ok_or_else(unknown)?;
    match scope {
        "dos" => match name {
            "e_magic" => Ok((0, 2)),
            "e_lfanew" => Ok((0x3C, 4)),
            _ => Err(unknown()),
        },
        "nt" => match name {
            "Signature" => Ok((nt, 4)),
            _ => Err(unknown()),
        },
        "file" => file_field(name).map(|(o, w)| (file_hdr + o, w)).ok_or_else(unknown),
        "opt" => opt_field(name, pe32).map(|(o, w)| (opt_hdr + o, w)).ok_or_else(unknown),
        // A data-directory slot (IMAGE_DATA_DIRECTORY: VirtualAddress + Size).
        "datadir" => {
            let i: usize = name.parse().map_err(|_| Error::InvalidParameter(format!("Bad directory index in '{}'", field)))?;
            let dd = datadir_base(pe32);
            if i >= 16 || dd + (i + 1) * 8 > size_of_opt {
                return Err(Error::InvalidParameter(format!("Directory index {} out of range", i)));
            }
            Ok((opt_hdr + dd + i * 8, 8))
        }
        "section" => {
            let (idx, sec_field) = name.split_once('.').ok_or_else(unknown)?;
            let i: usize = idx.parse().map_err(|_| Error::InvalidParameter(format!("Bad section index in '{}'", field)))?;
            if i >= num_sections {
                return Err(Error::InvalidParameter(format!("Section index {} out of range", i)));
            }
            section_field(sec_field).map(|(o, w)| (sections + i * 40 + o, w)).ok_or_else(unknown)
        }
        _ => Err(unknown()),
    }
}

/// (file offset, byte length) of a symbolic header field, for selecting the
/// field's raw bytes in the hex view. Same field names as `pe_set_field`, plus
/// read-only spans (`nt.Signature`, `datadir.<i>`).
#[tauri::command]
pub fn pe_field_span(
    path: String,
    field: String,
    pe_files: State<'_, PeFilesState>,
) -> Result<(usize, usize)> {
    with_file(&pe_files, &path, |file| field_offset(file.bytes(), &field))
}

/// Write an opened PE file's in-memory buffer to disk. Saves to `save_as` when
/// provided, otherwise overwrites the original path.
#[tauri::command]
pub async fn pe_save(
    path: String,
    save_as: Option<String>,
    pe_files: State<'_, PeFilesState>,
) -> Result<()> {
    let pe_files = pe_files.inner().clone();
    run_blocking(move || with_file(&pe_files, &path, |file| {
        let target = save_as.as_deref().unwrap_or(file.path());
        std::fs::write(target, file.bytes())
            .map_err(|e| Error::InvalidParameter(format!("Failed to write '{}': {}", target, e)))?;
        info!("Saved PE file to '{}'", target);
        Ok(())
    }))
    .await
}

/// Drop an opened PE file from memory.
#[tauri::command]
pub fn pe_close(path: String, pe_files: State<'_, PeFilesState>) -> Result<()> {
    pe_files.write().unwrap().remove(&path);
    Ok(())
}
