//! Session-independent PE file viewer/modifier commands.
//!
//! Unlike the module-info commands (which require a live debug session and a
//! module mapped in the target), these operate on a PE file opened directly
//! from disk. The file bytes are held in memory (`PeFilesState`, keyed by path)
//! so the hex view can edit them and `pe_save` can write them back.
//!
//! Symbol resolution runs fully in-process via joybug-core's offline
//! `WindowsSymbolProvider` (no debug session, no dbghelp) — the PDB is loaded
//! from an explicit path, from next to the file, or from the symbol server.
//!
//! v2 supports 64-bit PE images only (the parser uses pelite `pe64`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use tauri::State;
use tracing::info;

use crate::error::{Error, Result};
use crate::session::types::{SerializableInstruction, SymbolData};
use joybug_core::interfaces::{
    Architecture, DisassemblerProvider, ModuleSymbol, SymbolConfig, SymbolInfo, SymbolProvider,
};
use joybug_core::pe_types::ModuleExtraInfo;
use joybug_core::protocol::{StringEncodingFilter, StringHit};
use joybug_core::windows_platform::disassembler::CapstoneDisassembler;
use joybug_core::windows_platform::{parse_module_extra_info_from_bytes, parse_pdb_matching_pe, WindowsSymbolProvider};

use joybug_core::pe_image::{rva_to_offset_loose, SectionMap};

const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64: u16 = 0xAA64;

/// The instruction set to disassemble an opened PE's code with. The underlying
/// parser is pelite `pe64`, so the constraint is PE32+ (64-bit), not x64
/// specifically — ARM64 images parse identically and only differ in the
/// exception directory, which `parse_module_extra_info_from_bytes` already
/// branches on.
fn arch_from_machine(machine: u16) -> Option<Architecture> {
    match machine {
        IMAGE_FILE_MACHINE_AMD64 => Some(Architecture::X64),
        IMAGE_FILE_MACHINE_ARM64 => Some(Architecture::Arm64),
        _ => None,
    }
}

/// An opened PE file held in memory. `bytes` is the editable buffer.
pub struct LoadedPeFile {
    path: String,
    bytes: Vec<u8>,
    /// Load base for VA computation — the user-chosen base or the file's ImageBase.
    base: u64,
    image_size: u64,
    sections: Vec<SectionMap>,
    /// Symbols sorted ascending by RVA (once a PDB is loaded).
    symbols: Option<Vec<ModuleSymbol>>,
    /// Instruction set of this image, from its PE machine field. Disassembling
    /// with the host's architecture instead would silently emit garbage for a
    /// cross-architecture image.
    arch: Architecture,
}

impl LoadedPeFile {
    /// Translate a virtual address to a file offset via section mappings.
    /// RVAs outside any section (e.g. the PE headers) map to themselves.
    fn va_to_offset(&self, va: u64) -> Option<usize> {
        let rva = va.checked_sub(self.base)? as u32;
        Some(rva_to_offset_loose(&self.sections, rva))
    }

    /// Nearest symbol at-or-below `rva`, bounded to within the image.
    fn resolve_rva(&self, rva: u32) -> Option<&ModuleSymbol> {
        if rva as u64 >= self.image_size {
            return None;
        }
        let syms = self.symbols.as_ref()?;
        // syms is sorted ascending by rva; take the last entry with rva <= target.
        let idx = syms.partition_point(|s| s.rva <= rva);
        if idx == 0 { None } else { Some(&syms[idx - 1]) }
    }

    fn module_name(&self) -> String {
        crate::session::helpers::module_short_name(&self.path)
    }
}

// Arc so async commands can move a handle into `spawn_blocking` — the heavy
// commands (file read/parse, PDB load, scans) must run off the async runtime:
// they block for long stretches, and the symbol provider owns its own tokio
// runtime, which cannot be dropped on an async worker thread.
pub type PeFilesState = Arc<RwLock<HashMap<String, LoadedPeFile>>>;

use super::run_blocking;

/// Run `f` with a shared borrow of the open file for `path`. Read-only commands
/// go through here so they don't serialize behind each other.
fn with_file<R>(
    pe_files: &PeFilesState,
    path: &str,
    f: impl FnOnce(&LoadedPeFile) -> Result<R>,
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
    f: impl FnOnce(&mut LoadedPeFile) -> Result<R>,
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

/// Result of a symbol-load attempt.
#[derive(Serialize)]
pub struct PeSymbolLoad {
    pub loaded: bool,
    pub count: usize,
    pub error: Option<String>,
}

/// Offset of the NT headers (the "PE\0\0" signature) via the DOS header, with
/// both magics validated.
fn nt_headers_offset(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 0x40 || bytes[0] != b'M' || bytes[1] != b'Z' {
        return None;
    }
    let e_lfanew = u32::from_le_bytes(bytes[0x3C..0x40].try_into().ok()?) as usize;
    if bytes.len() < e_lfanew + 6 || &bytes[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return None;
    }
    Some(e_lfanew)
}

/// Read the PE machine field directly from raw bytes to give a clean
/// "unsupported" message before attempting a pe64 parse.
fn machine_from_bytes(bytes: &[u8]) -> Option<u16> {
    let nt = nt_headers_offset(bytes)?;
    Some(u16::from_le_bytes(bytes[nt + 4..nt + 6].try_into().ok()?))
}

fn build_loaded(path: String, bytes: Vec<u8>, base: u64, info: &ModuleExtraInfo, arch: Architecture) -> LoadedPeFile {
    let sections = info.sections.iter().map(SectionMap::from).collect();
    LoadedPeFile {
        arch,
        path,
        bytes,
        base,
        image_size: info.nt_headers.OptionalHeader.SizeOfImage as u64,
        sections,
        symbols: None,
    }
}

/// Load symbols for a PE, either from an explicit PDB path (GUID/age validated)
/// or auto-discovered next to the file / via the symbol server. `offline`
/// disables server downloads (used on open for the fast local-only path).
/// Returns the load status plus the parsed symbols (sorted by RVA) on success.
fn load_symbols_impl(
    path: &str,
    base: u64,
    size: usize,
    pdb_path: Option<&str>,
    offline: bool,
) -> (PeSymbolLoad, Option<Vec<ModuleSymbol>>) {
    let parsed: std::result::Result<Vec<ModuleSymbol>, String> = match pdb_path {
        Some(pdb) => parse_pdb_matching_pe(Path::new(path), Path::new(pdb))
            .map_err(|e| format!("{}", e))
            .and_then(|r| {
                r.map_err(|m| {
                    format!(
                        "PDB GUID/age mismatch: PE {}:{} vs PDB {}:{}",
                        m.pe_guid, m.pe_age, m.pdb_guid, m.pdb_age
                    )
                })
            }),
        None => {
            let cfg = SymbolConfig { symbol_path: None, offline };
            WindowsSymbolProvider::with_config(&cfg)
                .and_then(|mut p| p.load_symbols_for_module(path, base, Some(size)).map(|_| p))
                .and_then(|p| p.list_symbols(path))
                .map_err(|e| format!("{}", e))
        }
    };

    match parsed {
        Ok(mut syms) => {
            syms.sort_by_key(|s| s.rva);
            let status = PeSymbolLoad { loaded: true, count: syms.len(), error: None };
            (status, Some(syms))
        }
        Err(e) => (
            PeSymbolLoad { loaded: false, count: 0, error: Some(e) },
            None,
        ),
    }
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
    let bytes = std::fs::read(&path)
        .map_err(|e| Error::InvalidParameter(format!("Failed to read '{}': {}", path, e)))?;

    let arch = match machine_from_bytes(&bytes) {
        Some(machine) => arch_from_machine(machine).ok_or_else(|| {
            Error::InvalidParameter(format!(
                "Unsupported PE machine 0x{:04X}. The PE viewer supports 64-bit (x64 and ARM64) images only.",
                machine
            ))
        })?,
        None => {
            return Err(Error::InvalidParameter(
                "Not a valid PE file (missing MZ/PE headers).".to_string(),
            ));
        }
    };

    let info = parse_module_extra_info_from_bytes(&bytes)
        .map_err(|e| Error::InvalidParameter(format!("Failed to parse PE: {:?}", e)))?;

    let base = match base {
        Some(s) => crate::commands::parse_hex_u64(&s, "base")?,
        None => info.nt_headers.OptionalHeader.ImageBase,
    };

    let size = bytes.len();
    let mut loaded = build_loaded(path.clone(), bytes, base, &info, arch);

    // Best-effort local symbol load (explicit PDB, or one next to the file).
    let (status, syms) = load_symbols_impl(&path, base, size, pdb_path.as_deref(), true);
    loaded.symbols = syms;

    pe_files.write().unwrap().insert(path.clone(), loaded);
    info!("Opened PE '{}' ({} bytes), symbols_loaded={} ({}){}",
        path, size, status.loaded, status.count,
        status.error.as_ref().map(|e| format!(" [{}]", e)).unwrap_or_default());

    Ok(PeFileSummary {
        path,
        size,
        base: format!("0x{:X}", base),
        info,
        symbols_loaded: status.loaded,
        symbol_count: status.count,
    })
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
        let (base, size) = with_file(&pe_files, &path, |file| Ok((file.base, file.bytes.len())))?;
        // Symbol load may block on a network download — do it without holding the lock.
        let (status, syms) = load_symbols_impl(&path, base, size, pdb_path.as_deref(), false);
        if let Some(syms) = syms {
            if let Some(file) = pe_files.write().unwrap().get_mut(&path) {
                file.symbols = Some(syms);
            }
        }
        Ok(status)
    })
    .await
}

/// Allocation-free ASCII-case-insensitive substring match (symbol names are ASCII).
fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    needle.is_empty()
        || haystack
            .as_bytes()
            .windows(needle.len())
            .any(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Search loaded symbols by substring for the Symbol Explorer / goto box.
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
        let Some(syms) = file.symbols.as_ref() else { return Ok(Vec::new()) };
        let module_name = file.module_name();
        let out = syms
            .iter()
            .filter(|s| contains_ignore_ascii_case(&s.name, &pattern))
            .take(limit.max(1))
            .map(|s| SymbolData {
                name: s.name.clone(),
                module_name: module_name.clone(),
                rva: s.rva,
                va: format!("0x{:X}", file.base + s.rva as u64),
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
        if offset >= file.bytes.len() {
            return Ok(tauri::ipc::Response::new(Vec::new()));
        }
        let end = offset.saturating_add(size).min(file.bytes.len());
        Ok(tauri::ipc::Response::new(file.bytes[offset..end].to_vec()))
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
    with_file_mut(&pe_files, &path, |file| {
        let end = offset.saturating_add(data.len());
        if end > file.bytes.len() {
            return Err(Error::InvalidParameter(format!(
                "Write out of range: offset {} + {} bytes exceeds file size {}",
                offset, data.len(), file.bytes.len()
            )));
        }
        file.bytes[offset..end].copy_from_slice(&data);
        Ok(())
    })
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
        let Some(offset) = file.va_to_offset(va) else { return Ok(Vec::new()) };
        if offset >= file.bytes.len() {
            return Ok(Vec::new());
        }
        let disassembler = CapstoneDisassembler::new()
            .map_err(|e| Error::InvalidParameter(format!("Disassembler init failed: {:?}", e)))?;
        let data = &file.bytes[offset..];

        let instructions = if file.symbols.is_some() {
            let module_name = file.module_name();
            let resolver = |addr: u64| -> Option<SymbolInfo> {
                let rva = addr.checked_sub(file.base)? as u32;
                let sym = file.resolve_rva(rva)?;
                Some(SymbolInfo {
                    module_name: module_name.clone(),
                    symbol_name: sym.name.clone(),
                    offset: (rva - sym.rva) as u64,
                })
            };
            disassembler.disassemble_with_symbols(file.arch, data, va, count, resolver)
        } else {
            disassembler.disassemble(file.arch, data, va, count)
        }
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
        let disassembler = CapstoneDisassembler::new()
            .map_err(|e| Error::InvalidParameter(format!("Disassembler init failed: {:?}", e)))?;
        let out = addresses
            .iter()
            .take(256)
            .map(|s| {
                let va = super::parse_hex_u64(s, "address").ok()?;
                let offset = file.va_to_offset(va)?;
                if offset >= file.bytes.len() {
                    return None;
                }
                // 16 bytes bound any single x64/ARM64 instruction.
                let end = (offset + 16).min(file.bytes.len());
                let instr = disassembler
                    .disassemble(file.arch, &file.bytes[offset..end], va, 1)
                    .ok()?
                    .into_iter()
                    .next()?;
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
        let mut hits = joybug_core::string_scanner::scan_bytes(
            &file.bytes,
            0,
            min_length.max(1),
            enc,
            &contains,
        );
        let capped = hits.len() > PE_STRING_SCAN_CAP;
        hits.truncate(PE_STRING_SCAN_CAP);
        Ok(PeStringScan { hits, capped })
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
        let (offset, byte_len) = field_offset(&file.bytes, &field)?;
        if byte_len > 8 {
            return Err(Error::InvalidParameter(format!("Field '{}' is not a writable scalar", field)));
        }
        if offset + byte_len > file.bytes.len() {
            return Err(Error::InvalidParameter("Field offset out of range".into()));
        }
        // Little-endian write of the low `byte_len` bytes.
        let le = value.to_le_bytes();
        file.bytes[offset..offset + byte_len].copy_from_slice(&le[..byte_len]);
        Ok(())
    })
}

/// (offset relative to the optional header, byte width) for an IMAGE_OPTIONAL_HEADER64 field.
fn opt_field(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "Magic" => (0, 2),
        "MajorLinkerVersion" => (2, 1),
        "MinorLinkerVersion" => (3, 1),
        "SizeOfCode" => (4, 4),
        "SizeOfInitializedData" => (8, 4),
        "SizeOfUninitializedData" => (12, 4),
        "AddressOfEntryPoint" => (16, 4),
        "BaseOfCode" => (20, 4),
        "ImageBase" => (24, 8),
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
        "SizeOfStackReserve" => (72, 8),
        "SizeOfStackCommit" => (80, 8),
        "SizeOfHeapReserve" => (88, 8),
        "SizeOfHeapCommit" => (96, 8),
        "LoaderFlags" => (104, 4),
        "NumberOfRvaAndSizes" => (108, 4),
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
        "opt" => opt_field(name).map(|(o, w)| (opt_hdr + o, w)).ok_or_else(unknown),
        // A data-directory slot (IMAGE_DATA_DIRECTORY: VirtualAddress + Size).
        "datadir" => {
            let i: usize = name.parse().map_err(|_| Error::InvalidParameter(format!("Bad directory index in '{}'", field)))?;
            if i >= 16 || 112 + (i + 1) * 8 > size_of_opt {
                return Err(Error::InvalidParameter(format!("Directory index {} out of range", i)));
            }
            Ok((opt_hdr + 112 + i * 8, 8))
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
    with_file(&pe_files, &path, |file| field_offset(&file.bytes, &field))
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
        let target = save_as.as_deref().unwrap_or(&file.path);
        std::fs::write(target, &file.bytes)
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
