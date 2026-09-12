//! Pseudo-symbols for the PE locations that have a name in the headers but
//! usually none in the symbols: a module's entry point and its TLS callbacks.
//!
//! Without symbols those addresses read as bare hex, which is exactly when they
//! matter least — a "Module Entry" / "TLS Callbacks" breakpoint fires, a thread
//! starts there, an exception unwinds through it, and every surface shows
//! `hello_c+0x2301`. A pseudo-symbol fills that gap and behaves like a real one
//! wherever symbols are displayed: `hello_c.EntryPoint`, or
//! `hello_c.EntryPoint+0x2b` for an address inside it. The dot separates it from
//! the `hello_c!main` a PDB produces (`SymbolInfo::format_symbol`), so a
//! synthesized name never passes for a resolved one.
//!
//! The addresses come from the same two `ModuleExtraInfo` fields
//! `module_auto_targets` reads when planting the auto breakpoints
//! (`session/breakpoints.rs`), so a label always lands on the address whose
//! breakpoint announced it.
//!
//! **Extent.** A pseudo-symbol only claims addresses it can prove belong to it:
//! the containing entry of the module's exception directory (`.pdata`), which
//! gives real function bounds on x64/ARM64. Where there is none — x86 images
//! have no exception directory at all, and linker thunks carry no unwind data —
//! the anchor names its own address and nothing else. Nearest-below over one or
//! two anchors would otherwise attribute a whole module to `EntryPoint+0x…`.

use std::collections::HashMap;

use tracing::debug;

use super::helpers::find_module_for_address;
use super::types::DebugSession;

/// One named location and the address range it speaks for. `end` is exclusive
/// and equals `start + 1` when the module's headers give no function bounds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Anchor {
    pub start: u64,
    pub end: u64,
    pub label: String,
}

impl Anchor {
    fn contains(&self, address: u64) -> bool {
        address >= self.start && address < self.end
    }
}

/// Cached anchors for one module base. `name` is the module stem the entry was
/// built from: a base can be reused by a different module after an unload, and
/// comparing the name catches that (same guard as the section cache in
/// `region_annotations.rs`). An empty `anchors` negative-caches a module whose
/// headers could not be read, so a failed parse isn't retried on every scroll.
pub(crate) struct ModuleAnchors {
    pub name: String,
    pub anchors: Vec<Anchor>,
}

/// Per-module-base anchor cache; see `ModuleAnchors`.
pub(crate) type PeAnchorCache = HashMap<u64, ModuleAnchors>;

/// The anchors described by a module's entry-point RVA and TLS callback RVAs.
///
/// An `entry_rva` of 0 means the module has no entry point (resource-only DLLs)
/// and yields no anchor — the same guard `module_auto_targets` applies before
/// planting an entry breakpoint. `function_end` maps an RVA to the exclusive end
/// RVA of the function containing it, or `None` when that is unknown.
fn anchors_at(
    stem: &str,
    base: u64,
    entry_rva: u32,
    tls_rvas: &[u32],
    function_end: impl Fn(u32) -> Option<u32>,
) -> Vec<Anchor> {
    let mut named: Vec<(u32, String)> = Vec::with_capacity(tls_rvas.len() + 1);
    if entry_rva != 0 {
        named.push((entry_rva, format!("{}.EntryPoint", stem)));
    }
    for (i, &rva) in tls_rvas.iter().enumerate() {
        named.push((rva, format!("{}.TlsCallback{}", stem, i)));
    }
    named
        .into_iter()
        .map(|(rva, label)| {
            // Claim to the end of the containing function when the headers say
            // where that is, otherwise just this address.
            let end_rva = function_end(rva).filter(|end| *end > rva).unwrap_or(rva + 1);
            Anchor { start: base + rva as u64, end: base + end_rva as u64, label }
        })
        .collect()
}

/// The anchors a parsed `ModuleExtraInfo` describes. Shared by the live session
/// and the offline PE viewer so the labels are spelled in exactly one place.
pub(crate) fn anchors_from_info(
    stem: &str,
    base: u64,
    info: &joybug_core::pe_types::ModuleExtraInfo,
) -> Vec<Anchor> {
    anchors_at(
        stem,
        base,
        info.nt_headers.OptionalHeader.AddressOfEntryPoint,
        &info.tls_callbacks,
        |rva| info.runtime_function_bounds(rva).map(|(_, end)| end),
    )
}

/// The pseudo-symbol for `address`, formatted like a real one: `mod.Name` at the
/// anchor itself, `mod.Name+0x2b` inside it. When anchors overlap, the closest
/// one at or below `address` wins, exactly as nearest-below symbol resolution
/// would pick.
pub(crate) fn pseudo_symbol_in(anchors: &[Anchor], address: u64) -> Option<String> {
    let anchor = anchors
        .iter()
        .filter(|a| a.contains(address))
        .max_by_key(|a| a.start)?;
    Some(match address - anchor.start {
        0 => anchor.label.clone(),
        offset => format!("{}+0x{:x}", anchor.label, offset),
    })
}

/// Anchors of the module containing `address`, cached per module base for the
/// run. A miss costs one `get_module_extra_info` round trip; every later lookup
/// inside that module is served from the cache.
///
/// Returns an empty slice's worth when `address` is outside every loaded module
/// or the module's headers can't be read.
pub(crate) fn anchors_for_address(session: &mut DebugSession, pid: u32, address: u64) -> Vec<Anchor> {
    let (base, stem) = {
        let state = session.state.lock().unwrap();
        let Some((stem, offset)) = find_module_for_address(&state.modules, address) else {
            return Vec::new();
        };
        let base = address - offset;
        if let Some(cached) = state.pe_anchor_cache.get(&base).filter(|c| c.name == stem) {
            return cached.anchors.clone();
        }
        (base, stem)
    };

    // No lock held across the round trip.
    let anchors = match session.get_module_extra_info(pid, base) {
        Ok(info) => anchors_from_info(&stem, base, &info),
        Err(e) => {
            debug!("No PE anchors for module at 0x{:X}: {}", base, e);
            Vec::new() // negative-cache: don't re-ask on every lookup
        }
    };

    session
        .state
        .lock()
        .unwrap()
        .pe_anchor_cache
        .insert(base, ModuleAnchors { name: stem, anchors: anchors.clone() });
    anchors
}

/// The pseudo-symbol for `address` in a live session, or `None` when no anchor
/// speaks for it. The fallback every symbolizing surface reaches for after the
/// real symbols come back empty.
pub(crate) fn resolve_pseudo_symbol(session: &mut DebugSession, pid: u32, address: u64) -> Option<String> {
    pseudo_symbol_in(&anchors_for_address(session, pid, address), address)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: u64 = 0x7FF6_0000_0000;

    /// No exception directory (an x86 image, or an anchor in a linker thunk):
    /// each anchor names its own address and nothing beyond it.
    fn unbounded(stem: &str, entry: u32, tls: &[u32]) -> Vec<Anchor> {
        anchors_at(stem, BASE, entry, tls, |_| None)
    }

    #[test]
    fn entry_and_tls_callbacks_get_labels_at_absolute_vas() {
        let anchors = unbounded("hello_c", 0x1500, &[0x2000, 0x2040]);
        let labels: Vec<_> = anchors.iter().map(|a| (a.start, a.label.as_str())).collect();
        assert_eq!(
            labels,
            vec![
                (BASE + 0x1500, "hello_c.EntryPoint"),
                (BASE + 0x2000, "hello_c.TlsCallback0"),
                (BASE + 0x2040, "hello_c.TlsCallback1"),
            ]
        );
    }

    /// A resource-only DLL has no entry point; labelling its base would put
    /// `EntryPoint` on the DOS header.
    #[test]
    fn entry_rva_zero_yields_no_entry_label() {
        assert_eq!(unbounded("res", 0, &[]), vec![]);
        assert_eq!(
            unbounded("res", 0, &[0x30]),
            vec![Anchor { start: BASE + 0x30, end: BASE + 0x31, label: "res.TlsCallback0".into() }]
        );
    }

    #[test]
    fn without_function_bounds_only_the_anchor_itself_is_named() {
        let anchors = unbounded("hello_c", 0x1500, &[]);
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1500).as_deref(), Some("hello_c.EntryPoint"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1501), None);
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x14FF), None);
    }

    /// With `.pdata` bounds the pseudo-symbol takes an offset like a real one —
    /// which is what a callstack frame (a return address *inside* the function)
    /// needs — but still stops at the function's end.
    #[test]
    fn function_bounds_give_the_anchor_an_offset_range() {
        let anchors = anchors_at("hello_c", BASE, 0x1500, &[], |rva| (rva == 0x1500).then_some(0x1600));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1500).as_deref(), Some("hello_c.EntryPoint"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x152b).as_deref(), Some("hello_c.EntryPoint+0x2b"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1600), None); // end is exclusive
    }

    /// An `EndAddress` that doesn't exceed `BeginAddress` (ARM64 stores an
    /// unknown end as 0) speaks for nothing and must not swallow the module.
    #[test]
    fn degenerate_function_bounds_fall_back_to_the_anchor_itself() {
        let anchors = anchors_at("m", BASE, 0x1500, &[], |_| Some(0));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1500).as_deref(), Some("m.EntryPoint"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1501), None);
    }

    /// Overlapping anchors resolve nearest-below, like real symbol resolution.
    #[test]
    fn closest_anchor_at_or_below_wins() {
        let anchors = anchors_at("m", BASE, 0x1000, &[0x1010], |_| Some(0x1100));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1008).as_deref(), Some("m.EntryPoint+0x8"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1010).as_deref(), Some("m.TlsCallback0"));
        assert_eq!(pseudo_symbol_in(&anchors, BASE + 0x1020).as_deref(), Some("m.TlsCallback0+0x10"));
    }
}
