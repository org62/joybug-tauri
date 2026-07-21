//! Session-state cache of original on-disk module images (built by
//! `joybug2::pe_image`), used to detect in-memory code that differs from the
//! file it was loaded from (patches, hooks, self-modifying code).

use std::sync::{Arc, Mutex};

pub use joybug2::pe_image::OriginalModuleImage;

use crate::state::SessionStateUI;

/// Ensure the module containing `address` has an image entry (building it
/// off-lock on first touch) and return a snapshot of all cached entries for
/// comparison. Building lazily per-touched-module keeps the first disassembly
/// after a pause from reading every loaded DLL off disk at once — a function's
/// instructions live in one module, so its covering image is all a given
/// disassembly response needs.
///
/// Only runs for x64 sessions; `arch != X64` returns an empty vec (no diff).
/// The build I/O happens without the state lock held; a short re-lock commits
/// the result, guarding against a racing insert from a concurrent path.
pub fn ensure_and_snapshot_images(
    state_arc: &Arc<Mutex<SessionStateUI>>,
    arch: joybug2::interfaces::Architecture,
    address: u64,
) -> Vec<Arc<OriginalModuleImage>> {
    if arch != joybug2::interfaces::Architecture::X64 {
        return Vec::new();
    }

    // Find the module covering `address` that isn't cached yet.
    let missing: Option<(u64, String)> = {
        let state = state_arc.lock().unwrap();
        state
            .modules
            .iter()
            .find(|m| {
                let size = m.size.unwrap_or(0);
                address >= m.base
                    && (size == 0 || address < m.base + size)
                    && !state.original_images.contains_key(&m.base)
            })
            .map(|m| (m.base, m.name.clone()))
    };

    // Build off-lock (disk I/O + PE parse), then commit + snapshot under one lock.
    let built = missing.map(|(base, name)| (base, Arc::new(OriginalModuleImage::build(&name, base))));

    let mut state = state_arc.lock().unwrap();
    if let Some((base, image)) = built {
        state.original_images.entry(base).or_insert(image);
    }
    state.original_images.values().cloned().collect()
}
