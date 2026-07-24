//! Whole-image patch scan for the Image Patches window: diff every loaded
//! module's executable sections against its original on-disk image and report
//! the modified runs (user patches, external hooks, self-modifying code).

use std::collections::{HashMap, HashSet};

use joybug2::windows_platform::disassembler::CapstoneDisassembler;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, warn};

use super::disassembly::{applied_patch_ranges, disasm_covering};
use super::helpers::{format_symbol, hex_join, module_short_name};
use super::image_cache::ensure_all_and_snapshot_images;
use super::patches::MAX_RESTORE_BYTES;
use super::types::{DebugSession, ImagePatchEntry, ImagePatchesResult};

/// Bytes read per memory request while diffing a section.
const CHUNK_SIZE: usize = 0x10000;
/// A longer contiguous modified region splits into runs of the restore
/// command's bound, so one entry maps to one restorable run.
const MAX_RUN_BYTES: usize = MAX_RESTORE_BYTES;
/// Scan stops (and the result is flagged `capped`) past this many entries — a
/// repacked/JIT-patched module would otherwise produce thousands of rows.
const MAX_ENTRIES: usize = 512;
/// Extra bytes appended to a run's buffer before disassembly so an instruction
/// straddling the run's end decodes fully (longest x64 instruction is 15).
const DECODE_TAIL: usize = 15;

struct DiffRun {
    address: u64,
    original: Vec<u8>,
    current: Vec<u8>,
}

/// Diff every loaded module's executable sections against its on-disk image
/// and emit the modified runs on `image-patches-updated`. Active software
/// breakpoints (0xCC written by the debugger itself) are excluded from the
/// diff; tracked user patches are included and flagged `tracked`.
pub(crate) fn process_scan_image_patches(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    event: &joybug2::protocol_io::DebugEvent,
) {
    let pid = event.pid();
    let arch = crate::commands::get_session_arch(&session.state);

    let (session_id, module_names, bp_addrs, patch_ranges) = {
        let state = session.state.lock().unwrap();
        let names: HashMap<u64, String> = state
            .modules
            .iter()
            .map(|m| (m.base, module_short_name(&m.name)))
            .collect();
        let bps: HashSet<u64> = state
            .breakpoints
            .iter()
            .filter(|bp| bp.is_active && bp.bp_kind == "software" && bp.address != 0)
            .map(|bp| bp.address)
            .collect();
        (state.id.clone(), names, bps, applied_patch_ranges(&state))
    };

    // Ensure every loaded module has an image entry, then take one snapshot.
    let module_bases: Vec<u64> = module_names.keys().copied().collect();
    let images = ensure_all_and_snapshot_images(&session.state, &module_bases);

    let disasm = match CapstoneDisassembler::new() {
        Ok(d) => Some(d),
        Err(e) => {
            error!("Image patch scan: disassembler init failed: {:?}", e);
            None
        }
    };

    let mut runs: Vec<DiffRun> = Vec::new();
    let mut capped = false;

    'scan: for image in images.iter().filter(|im| !im.unavailable) {
        for (start_rva, end_rva) in image.comparable_code_ranges() {
            let mut va = image.base() + start_rva as u64;
            let range_end = image.base() + end_rva as u64;
            while va < range_end {
                let len = CHUNK_SIZE.min((range_end - va) as usize);
                let live = match session.read_memory(pid, va, len) {
                    Ok(b) => b,
                    Err(e) => {
                        warn!("Image patch scan: read failed at 0x{:X}: {}", va, e);
                        va += len as u64;
                        continue;
                    }
                };
                // A short read still gets compared; the loop then resumes at the
                // first unread byte instead of skipping the chunk's remainder.
                let cmp_len = live.len().min(len);
                let advance = if cmp_len > 0 { cmp_len } else { len };
                let Some(orig) = image.bytes_at(va, cmp_len) else {
                    va += advance as u64;
                    continue;
                };

                for i in 0..cmp_len {
                    let addr = va + i as u64;
                    if live[i] == orig[i] || bp_addrs.contains(&addr) {
                        continue;
                    }
                    // Extend the previous run when contiguous and under the cap;
                    // otherwise start a new one (also merges across chunk seams).
                    match runs.last_mut() {
                        Some(run)
                            if run.address + run.current.len() as u64 == addr
                                && run.current.len() < MAX_RUN_BYTES =>
                        {
                            run.original.push(orig[i]);
                            run.current.push(live[i]);
                        }
                        _ => {
                            if runs.len() >= MAX_ENTRIES {
                                capped = true;
                                break 'scan;
                            }
                            runs.push(DiffRun {
                                address: addr,
                                original: vec![orig[i]],
                                current: vec![live[i]],
                            });
                        }
                    }
                }
                va += advance as u64;
            }
        }
    }

    debug!("Image patch scan: {} modified runs (capped={})", runs.len(), capped);

    let entries: Vec<ImagePatchEntry> = runs
        .iter()
        .enumerate()
        .map(|(idx, run)| {
            let run_len = run.current.len();
            let run_end = run.address + run_len as u64;
            let image = images
                .iter()
                .find(|im| !im.unavailable && im.contains(run.address));
            let (module, rva) = image
                .map(|im| {
                    let name = module_names
                        .get(&im.base())
                        .cloned()
                        .unwrap_or_else(|| "unknown".to_string());
                    (name, run.address - im.base())
                })
                .unwrap_or_else(|| ("unknown".to_string(), 0));

            let symbol = match session.resolve_address_to_symbol(pid, run.address) {
                Ok((Some(m), Some(s), Some(o))) => Some(format_symbol(&m, &s.name, o)),
                _ => None,
            };

            let disasm_at = |buf: &[u8]| {
                disasm
                    .as_ref()
                    .and_then(|d| disasm_covering(d, arch, buf, run.address, run_len))
                    .unwrap_or_default()
            };

            let orig_buf = image
                .and_then(|im| {
                    im.bytes_at(run.address, run_len + DECODE_TAIL)
                        .or_else(|| im.bytes_at(run.address, run_len))
                })
                .unwrap_or(&run.original);
            let original_disasm = disasm_at(orig_buf);

            // The live bytes were captured during the scan; only the decode tail
            // needs sourcing. Past the run's end memory matches the image again
            // (that's what ended the run), except when the run was split at
            // MAX_RUN_BYTES — then the adjacent run holds the live bytes. A
            // debugger breakpoint's 0xCC in the tail decodes as the original
            // instruction instead, consistent with the scan excluding it.
            let mut live_buf = run.current.clone();
            if let Some(next) = runs.get(idx + 1) {
                if next.address == run_end {
                    live_buf.extend(next.current.iter().take(DECODE_TAIL));
                }
            }
            if live_buf.len() < run_len + DECODE_TAIL {
                let need = run_len + DECODE_TAIL - live_buf.len();
                let from = run.address + live_buf.len() as u64;
                if let Some(tail) = image.and_then(|im| im.bytes_at(from, need)) {
                    live_buf.extend_from_slice(tail);
                }
            }
            let current_disasm = disasm_at(&live_buf);

            let tracked = patch_ranges
                .iter()
                .any(|&(start, end)| run.address < end && run_end > start);

            ImagePatchEntry {
                address: format!("{:#X}", run.address),
                module,
                rva: format!("{:#X}", rva),
                symbol,
                original_bytes: hex_join(&run.original),
                current_bytes: hex_join(&run.current),
                original_disasm,
                current_disasm,
                tracked,
            }
        })
        .collect();

    if let Some(ref handle) = app_handle_clone {
        let payload = ImagePatchesResult { session_id, patches: entries, capped };
        if let Err(e) = handle.emit("image-patches-updated", &payload) {
            error!("Failed to emit image-patches-updated event: {}", e);
        }
    }
}
