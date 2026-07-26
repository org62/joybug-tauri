//! Annotates memory regions with what lives inside them: owning module and PE
//! sections, PEB, heaps, per-thread TEBs and stacks. All lookups are
//! best-effort — any client call failure simply leaves the corresponding
//! annotations absent; region enumeration itself must never be affected.

use tracing::debug;

use super::helpers::module_short_name;
use super::types::{DebugSession, RegionAnnotation};
use joybug_core::protocol::MemoryRegionInfo;
use std::collections::{HashMap, HashSet};

// 64-bit native structure offsets (identical on x64 and ARM64).
// NT_TIB at the top of the TEB:
const TEB_STACK_BASE_OFF: u64 = 0x08;
// PEB: ProcessHeap (+0x30), NumberOfHeaps (+0xE8, u32), ProcessHeaps (+0xF0) —
// one read from +0x30 covers all three.
const PEB_PROCESS_HEAP_OFF: u64 = 0x30;
const PEB_READ_LEN: usize = 0xC8;
const PEB_NUMBER_OF_HEAPS_REL: usize = 0xE8 - 0x30;
const PEB_PROCESS_HEAPS_REL: usize = 0xF0 - 0x30;
/// Fixed-address read-only page shared with the kernel (same VA in every process).
const KUSER_SHARED_DATA: u64 = 0x7FFE0000;
const MAX_ANNOTATED_THREADS: usize = 256;
const MAX_HEAPS: u32 = 256;
/// Cap on per-region section badges; beyond this a "+N more" entry is added.
const MAX_SECTIONS_PER_REGION: usize = 6;

const MEM_FREE: u32 = 0x10000;
const MEM_IMAGE: u32 = 0x100_0000;

/// Process-lifetime caches backing `annotate_regions`, stored in
/// `SessionStateUI::region_annotation_cache` and cleared on restart (addresses
/// change with ASLR). Every lookup here is otherwise a client round trip per
/// refresh — and refreshes happen on every pause — so steady-state annotation
/// must only cost the module/thread list calls plus the per-refresh heap reads.
#[derive(Default)]
pub struct RegionAnnotationCache {
    /// PE section ranges per module base. Pruned against the live module list
    /// on every refresh (handles unload and base reuse); an empty `sections`
    /// entry negative-caches modules whose headers failed to parse.
    pub sections: HashMap<u64, CachedModuleSections>,
    /// PEB address — constant for the process lifetime.
    pub peb: Option<u64>,
    /// TEB address and NT_TIB stack bounds per tid — constant for a thread's
    /// lifetime. Pruned against the live thread list on every refresh so a
    /// reused tid cannot serve a stale TEB.
    pub threads: HashMap<u32, CachedThreadInfo>,
}

/// Cached PE section ranges for one module.
#[derive(Clone)]
pub struct CachedModuleSections {
    pub name: String,
    /// (section name, va_start, va_end) — absolute VAs, end exclusive.
    pub sections: Vec<(String, u64, u64)>,
}

/// Cached TEB address and stack bounds for one thread.
#[derive(Clone, Copy)]
pub struct CachedThreadInfo {
    pub teb: u64,
    /// NT_TIB StackBase (exclusive top) / StackLimit; zero when unknown.
    pub stack_base: u64,
    pub stack_limit: u64,
}

fn ann(kind: &str, label: impl Into<String>, address: Option<u64>) -> RegionAnnotation {
    RegionAnnotation {
        kind: kind.to_string(),
        label: label.into(),
        address: address.map(fmt_addr),
    }
}

/// Returns one annotation list per region, parallel to `regions`.
pub(crate) fn annotate_regions(
    session: &mut DebugSession,
    pid: u32,
    regions: &[MemoryRegionInfo],
) -> Vec<Vec<RegionAnnotation>> {
    let mut out: Vec<Vec<RegionAnnotation>> = vec![Vec::new(); regions.len()];

    // Regions come back sorted by base address (VirtualQueryEx walk).
    let find_region = |addr: u64| -> Option<usize> {
        let idx = regions.partition_point(|r| r.base_address <= addr);
        if idx == 0 {
            return None;
        }
        let r = &regions[idx - 1];
        (addr < r.base_address.saturating_add(r.region_size)).then_some(idx - 1)
    };

    // Push an annotation onto every non-free region of the allocation
    // containing `addr` (regions of one allocation are contiguous).
    let annotate_allocation = |out: &mut Vec<Vec<RegionAnnotation>>,
                               addr: u64,
                               kind: &str,
                               label: &str,
                               address: Option<u64>| {
        let Some(ri) = find_region(addr) else { return };
        let alloc_base = regions[ri].allocation_base;
        let start = regions.partition_point(|r| r.base_address < alloc_base);
        for (i, r) in regions.iter().enumerate().skip(start) {
            if r.allocation_base != alloc_base {
                break;
            }
            if r.state != MEM_FREE {
                out[i].push(ann(kind, label, address));
            }
        }
    };

    // --- Modules + PE sections ------------------------------------------------
    if let Ok(modules) = session.list_modules(pid) {
        let module_bases: HashMap<u64, String> = modules
            .iter()
            .map(|m| (m.base, module_short_name(&m.name)))
            .collect();

        // Prune stale cache entries, collect misses (do not hold the state lock
        // across client round trips).
        let misses: Vec<u64> = {
            let mut state = session.state.lock().unwrap();
            let sections = &mut state.region_annotation_cache.sections;
            sections.retain(|base, cached| module_bases.get(base) == Some(&cached.name));
            module_bases
                .keys()
                .filter(|b| !sections.contains_key(b))
                .copied()
                .collect()
        };

        let mut fetched: Vec<(u64, CachedModuleSections)> = Vec::new();
        for base in misses {
            let name = module_bases[&base].clone();
            let sections = session
                .get_module_extra_info(pid, base)
                .map(|info| {
                    info.sections
                        .iter()
                        .map(|s| {
                            let start = base + s.VirtualAddress as u64;
                            (s.name_string(), start, start + s.VirtualSize.max(1) as u64)
                        })
                        .collect()
                })
                .unwrap_or_else(|e| {
                    debug!("No section info for module at 0x{:X}: {}", base, e);
                    Vec::new() // negative-cache: don't retry every refresh
                });
            fetched.push((base, CachedModuleSections { name, sections }));
        }

        // Annotate MEM_IMAGE regions from the now-complete cache (map work
        // only; no client calls while the lock is held).
        let mut state = session.state.lock().unwrap();
        let sections_cache = &mut state.region_annotation_cache.sections;
        sections_cache.extend(fetched);
        for (i, r) in regions.iter().enumerate() {
            if r.region_type != MEM_IMAGE {
                continue;
            }
            let Some(cached) = sections_cache.get(&r.allocation_base) else {
                continue;
            };
            out[i].push(ann("module", cached.name.clone(), Some(r.allocation_base)));
            let region_end = r.base_address.saturating_add(r.region_size);
            let overlapping: Vec<&(String, u64, u64)> = cached
                .sections
                .iter()
                .filter(|(_, start, end)| *start < region_end && *end > r.base_address)
                .collect();
            for (name, start, _) in overlapping.iter().take(MAX_SECTIONS_PER_REGION) {
                out[i].push(ann("section", name.clone(), Some(*start)));
            }
            if overlapping.len() > MAX_SECTIONS_PER_REGION {
                out[i].push(ann(
                    "section",
                    format!("+{} more", overlapping.len() - MAX_SECTIONS_PER_REGION),
                    None,
                ));
            }
        }
    }

    if let Some(i) = find_region(KUSER_SHARED_DATA) {
        out[i].push(ann("kuser", "KUSER_SHARED_DATA", Some(KUSER_SHARED_DATA)));
    }

    // --- PEB + heaps ----------------------------------------------------------
    // Offsets are the native 64-bit layouts. For WoW64 targets the native
    // structures still exist and are annotated correctly; the 32-bit
    // TEBs/heaps/stacks are simply not labeled.
    let peb = session.state.lock().unwrap().region_annotation_cache.peb;
    let peb = peb.or_else(|| {
        let peb = session.get_peb_address(pid).ok()?;
        session.state.lock().unwrap().region_annotation_cache.peb = Some(peb);
        Some(peb)
    });
    if let Some(peb) = peb {
        if let Some(i) = find_region(peb) {
            out[i].push(ann("peb", "PEB", Some(peb)));
        }

        if let Ok(bytes) = session.read_memory(pid, peb + PEB_PROCESS_HEAP_OFF, PEB_READ_LEN) {
            if bytes.len() == PEB_READ_LEN {
                let default_heap = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
                let num_heaps = u32::from_le_bytes(
                    bytes[PEB_NUMBER_OF_HEAPS_REL..PEB_NUMBER_OF_HEAPS_REL + 4]
                        .try_into()
                        .unwrap(),
                )
                .min(MAX_HEAPS);
                let heaps_ptr = u64::from_le_bytes(
                    bytes[PEB_PROCESS_HEAPS_REL..PEB_PROCESS_HEAPS_REL + 8]
                        .try_into()
                        .unwrap(),
                );
                if num_heaps > 0 && heaps_ptr != 0 {
                    if let Ok(arr) = session.read_memory(pid, heaps_ptr, num_heaps as usize * 8) {
                        for (idx, chunk) in arr.chunks_exact(8).enumerate() {
                            let heap = u64::from_le_bytes(chunk.try_into().unwrap());
                            let label = if heap == default_heap {
                                format!("Heap #{} (default)", idx)
                            } else {
                                format!("Heap #{}", idx)
                            };
                            annotate_allocation(&mut out, heap, "heap", &label, Some(heap));
                        }
                    }
                }
            }
        }
    }

    // --- TEBs + stacks --------------------------------------------------------
    if let Ok(threads) = session.list_threads(pid) {
        let cached_threads: HashMap<u32, CachedThreadInfo> = {
            let live: HashSet<u32> = threads.iter().map(|t| t.tid).collect();
            let mut state = session.state.lock().unwrap();
            let cache = &mut state.region_annotation_cache.threads;
            cache.retain(|tid, _| live.contains(tid));
            cache.clone()
        };

        let mut fetched: Vec<(u32, CachedThreadInfo)> = Vec::new();
        for t in threads.iter().take(MAX_ANNOTATED_THREADS) {
            let info = match cached_threads.get(&t.tid) {
                Some(info) => *info,
                None => {
                    let Ok(teb) = session.get_teb_address(pid, t.tid) else {
                        continue;
                    };
                    // NT_TIB: StackBase at +0x08, StackLimit at +0x10.
                    match session.read_memory(pid, teb + TEB_STACK_BASE_OFF, 16) {
                        Ok(bytes) if bytes.len() == 16 => {
                            let info = CachedThreadInfo {
                                teb,
                                stack_base: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
                                stack_limit: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
                            };
                            fetched.push((t.tid, info));
                            info
                        }
                        // Transient read failure: annotate the TEB now, retry
                        // the stack bounds next refresh (not cached).
                        _ => CachedThreadInfo { teb, stack_base: 0, stack_limit: 0 },
                    }
                }
            };
            if let Some(i) = find_region(info.teb) {
                out[i].push(ann("teb", format!("TEB (tid {})", t.tid), Some(info.teb)));
            }
            if info.stack_base != 0 && info.stack_limit != 0 && info.stack_limit < info.stack_base {
                // stack_base is the exclusive top; annotate the whole allocation
                // (committed + guard + reserved parts).
                annotate_allocation(
                    &mut out,
                    info.stack_base - 1,
                    "stack",
                    &format!("Stack (tid {})", t.tid),
                    Some(info.stack_limit),
                );
            }
        }
        if !fetched.is_empty() {
            session
                .state
                .lock()
                .unwrap()
                .region_annotation_cache
                .threads
                .extend(fetched);
        }
    }

    out
}

fn fmt_addr(addr: u64) -> String {
    format!("0x{:016X}", addr)
}
