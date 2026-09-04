//! Annotates memory regions with what lives inside them: owning module and PE
//! sections, PEB, heaps, per-thread TEBs and stacks. All lookups are
//! best-effort — any client call failure simply leaves the corresponding
//! annotations absent; region enumeration itself must never be affected.

use tracing::debug;

use super::helpers::module_short_name;
use super::types::{DebugSession, RegionAnnotation};
use joybug_core::protocol::MemoryRegionInfo;
use std::collections::{HashMap, HashSet};

/// TEB/PEB field offsets for one pointer width. The core hands an x86 (WOW64)
/// session its 32-bit TEBs and PEB, which use the 32-bit layouts; x64 and
/// ARM64 share the 64-bit ones.
struct NtLayout {
    ptr: usize,
    /// PEB.ProcessHeap; one read from here covers NumberOfHeaps and ProcessHeaps.
    peb_process_heap_off: u64,
    peb_number_of_heaps_rel: usize,
    peb_process_heaps_rel: usize,
}

const LAYOUT64: NtLayout = NtLayout {
    ptr: 8,
    peb_process_heap_off: 0x30,
    peb_number_of_heaps_rel: 0xE8 - 0x30,
    peb_process_heaps_rel: 0xF0 - 0x30,
};

const LAYOUT32: NtLayout = NtLayout {
    ptr: 4,
    peb_process_heap_off: 0x18,
    peb_number_of_heaps_rel: 0x88 - 0x18,
    peb_process_heaps_rel: 0x90 - 0x18,
};

impl NtLayout {
    fn for_arch(arch: joybug_core::interfaces::Architecture) -> &'static NtLayout {
        if arch == joybug_core::interfaces::Architecture::X86 { &LAYOUT32 } else { &LAYOUT64 }
    }

    /// NT_TIB.StackBase: the second pointer of the TEB (StackLimit follows it).
    fn teb_stack_base_off(&self) -> u64 {
        self.ptr as u64
    }

    /// Bytes to read from `peb_process_heap_off` to cover ProcessHeaps too.
    fn peb_read_len(&self) -> usize {
        self.peb_process_heaps_rel + self.ptr
    }

    /// The pointer-sized little-endian value at `off`.
    fn read_ptr(&self, bytes: &[u8], off: usize) -> u64 {
        if self.ptr == 4 {
            u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as u64
        } else {
            u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap())
        }
    }
}

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
    let layout = NtLayout::for_arch(session.state.lock().unwrap().target_arch());

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
    // For a WOW64 target the core reports the 32-bit PEB/TEBs, which the
    // 32-bit layout below decodes; the native 64-bit copies are not labeled.
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

        if let Ok(bytes) = session.read_memory(pid, peb + layout.peb_process_heap_off, layout.peb_read_len()) {
            if bytes.len() == layout.peb_read_len() {
                let default_heap = layout.read_ptr(&bytes, 0);
                let num_heaps = u32::from_le_bytes(
                    bytes[layout.peb_number_of_heaps_rel..layout.peb_number_of_heaps_rel + 4]
                        .try_into()
                        .unwrap(),
                )
                .min(MAX_HEAPS);
                let heaps_ptr = layout.read_ptr(&bytes, layout.peb_process_heaps_rel);
                if num_heaps > 0 && heaps_ptr != 0 {
                    if let Ok(arr) = session.read_memory(pid, heaps_ptr, num_heaps as usize * layout.ptr) {
                        for (idx, chunk) in arr.chunks_exact(layout.ptr).enumerate() {
                            let heap = layout.read_ptr(chunk, 0);
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
                    // NT_TIB: StackBase then StackLimit, pointer-sized.
                    let want = layout.ptr * 2;
                    match session.read_memory(pid, teb + layout.teb_stack_base_off(), want) {
                        Ok(bytes) if bytes.len() == want => {
                            let info = CachedThreadInfo {
                                teb,
                                stack_base: layout.read_ptr(&bytes, 0),
                                stack_limit: layout.read_ptr(&bytes, layout.ptr),
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
