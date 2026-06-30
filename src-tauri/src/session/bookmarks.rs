use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

use super::helpers::extract_module_name;
use super::types::DebugSession;
use crate::state::{BookmarkInfo, ResolvedBookmark, SessionStateUI};

// ----- value type helpers (U8..F64, matching the memory scanner) -----

fn value_type_size(vt: &str) -> usize {
    match vt {
        "U8" => 1,
        "U16" => 2,
        "U32" | "F32" => 4,
        "U64" | "F64" => 8,
        _ => 4,
    }
}

/// Format raw bytes as a display string for the given type (matches the scanner).
fn format_value(vt: &str, bytes: &[u8]) -> String {
    match vt {
        "U8" if !bytes.is_empty() => format!("{} (0x{:02X})", bytes[0], bytes[0]),
        "U16" if bytes.len() >= 2 => {
            let v = u16::from_le_bytes([bytes[0], bytes[1]]);
            format!("{} (0x{:04X})", v, v)
        }
        "U32" if bytes.len() >= 4 => {
            let v = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            format!("{} (0x{:08X})", v, v)
        }
        "U64" if bytes.len() >= 8 => {
            let v = u64::from_le_bytes(bytes[..8].try_into().unwrap());
            format!("{} (0x{:016X})", v, v)
        }
        "F32" if bytes.len() >= 4 => {
            format!("{}", f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        }
        "F64" if bytes.len() >= 8 => {
            format!("{}", f64::from_le_bytes(bytes[..8].try_into().unwrap()))
        }
        _ => "?".to_string(),
    }
}

/// Encode a user-entered value string (decimal, 0x hex, or float) to LE bytes.
fn encode_value(vt: &str, s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let is_hex = s.starts_with("0x") || s.starts_with("0X");
    let hex = &s.get(2..).unwrap_or("");
    match vt {
        "U8" => {
            let v: u8 = if is_hex { u8::from_str_radix(hex, 16).ok()? } else { s.parse().ok()? };
            Some(v.to_le_bytes().to_vec())
        }
        "U16" => {
            let v: u16 = if is_hex { u16::from_str_radix(hex, 16).ok()? } else { s.parse().ok()? };
            Some(v.to_le_bytes().to_vec())
        }
        "U32" => {
            let v: u32 = if is_hex { u32::from_str_radix(hex, 16).ok()? } else { s.parse().ok()? };
            Some(v.to_le_bytes().to_vec())
        }
        "U64" => {
            let v: u64 = if is_hex { u64::from_str_radix(hex, 16).ok()? } else { s.parse().ok()? };
            Some(v.to_le_bytes().to_vec())
        }
        "F32" => Some(s.parse::<f32>().ok()?.to_le_bytes().to_vec()),
        "F64" => Some(s.parse::<f64>().ok()?.to_le_bytes().to_vec()),
        _ => None,
    }
}

/// A plain, re-parseable string for raw bytes (used to persist a locked value).
fn value_to_plain(vt: &str, bytes: &[u8]) -> String {
    match vt {
        "U8" if !bytes.is_empty() => bytes[0].to_string(),
        "U16" if bytes.len() >= 2 => u16::from_le_bytes([bytes[0], bytes[1]]).to_string(),
        "U32" if bytes.len() >= 4 => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).to_string(),
        "U64" if bytes.len() >= 8 => u64::from_le_bytes(bytes[..8].try_into().unwrap()).to_string(),
        "F32" if bytes.len() >= 4 => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).to_string(),
        "F64" if bytes.len() >= 8 => f64::from_le_bytes(bytes[..8].try_into().unwrap()).to_string(),
        _ => String::new(),
    }
}

// ----- address resolution -----

use crate::state::bookmark_static_address as static_base;

/// Resolve the absolute address a bookmark points at, following the pointer chain
/// for "pointer" bookmarks (joybug2 convention:
/// `addr = base; for off in offsets { addr = read_u64(addr) + off }`).
fn resolve_address(
    session: &mut DebugSession,
    pid: u32,
    modules: &[joybug2::protocol_io::ModuleInfo],
    bm: &BookmarkInfo,
) -> Option<u64> {
    let base = static_base(bm, modules)?;
    if bm.kind == "pointer" {
        let mut addr = base;
        if let Some(offsets) = &bm.pointer_offsets {
            for off in offsets {
                let buf = session.read_memory(pid, addr, 8).ok()?;
                if buf.len() < 8 {
                    return None;
                }
                let ptr = u64::from_le_bytes(buf[..8].try_into().unwrap());
                addr = ptr.wrapping_add(*off);
            }
        }
        Some(addr)
    } else {
        Some(base)
    }
}

/// The (base, offsets) to register a server-side freeze with. For pointer
/// bookmarks this is the static base + pointer chain, so the freeze re-resolves
/// the (moving) target each tick. For other kinds it's the fixed resolved address
/// with no chain. Falls back to the fixed `addr` if the base can't be resolved.
fn freeze_target(
    modules: &[joybug2::protocol_io::ModuleInfo],
    bm: &BookmarkInfo,
    addr: u64,
) -> (u64, Vec<u64>) {
    if bm.kind == "pointer" {
        if let Some(base) = static_base(bm, modules) {
            return (base, bm.pointer_offsets.clone().unwrap_or_default());
        }
    }
    (addr, Vec::new())
}

// ----- persist + emit -----

pub(crate) fn persist_bookmarks(session_state: &Arc<Mutex<SessionStateUI>>) {
    let state = session_state.lock().unwrap();
    crate::bookmark_store::save_bookmarks(&state.launch_command, &state.bookmarks);
}

/// Resolve + read live values for all bookmarks and emit `bookmarks-updated`.
pub(crate) fn emit_bookmarks_event(
    session: &mut DebugSession,
    pid: u32,
    app_handle_clone: &Option<AppHandle>,
) {
    let Some(handle) = app_handle_clone.as_ref() else { return };

    let (session_id, bookmarks, modules) = {
        let s = session.state.lock().unwrap();
        (s.id.clone(), s.bookmarks.clone(), s.modules.clone())
    };

    let mut resolved = Vec::with_capacity(bookmarks.len());
    for bm in &bookmarks {
        let addr = resolve_address(session, pid, &modules, bm);
        let current_value = match (addr, &bm.value_type) {
            (Some(a), Some(vt)) if bm.kind != "code" => session
                .read_memory(pid, a, value_type_size(vt))
                .ok()
                .map(|b| format_value(vt, &b)),
            _ => None,
        };
        resolved.push(ResolvedBookmark::build(bm, addr, current_value));
    }

    #[derive(serde::Serialize)]
    struct BookmarksUpdatedEvent {
        session_id: String,
        bookmarks: Vec<ResolvedBookmark>,
    }
    let payload = BookmarksUpdatedEvent { session_id, bookmarks: resolved };
    if let Err(e) = handle.emit("bookmarks-updated", &payload) {
        warn!("Failed to emit bookmarks-updated event: {}", e);
    }
}

// ----- command processing -----

#[allow(clippy::too_many_arguments)]
pub(crate) fn process_add_bookmark(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    kind: String,
    address: u64,
    value_type: Option<String>,
    name: Option<String>,
    comment: Option<String>,
    pointer_offsets: Option<Vec<u64>>,
    base_symbol: Option<String>,
    asm_text: Option<String>,
) {
    let modules = session.state.lock().unwrap().modules.clone();
    let (module_name, module_offset, raw_address) =
        match super::helpers::find_module_for_address(&modules, address) {
            Some((short, off)) => (Some(short.to_lowercase()), Some(off), None),
            None => (None, None, Some(format!("0x{:X}", address))),
        };

    let bookmark = BookmarkInfo {
        id: uuid::Uuid::new_v4().to_string(),
        kind,
        module_name,
        module_offset,
        raw_address,
        name,
        comment,
        group: None,
        value_type,
        pointer_offsets,
        base_symbol,
        asm_text,
        locked: false,
        locked_value: None,
        freeze_id: None,
    };

    {
        let mut state = session.state.lock().unwrap();
        state.bookmarks.push(bookmark);
    }
    info!("Added bookmark at 0x{:X}", address);
    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

pub(crate) fn process_remove_bookmark(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    id: &str,
) {
    unfreeze_if_locked(session, id);
    {
        let mut state = session.state.lock().unwrap();
        state.bookmarks.retain(|b| b.id != id);
    }
    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

pub(crate) fn process_remove_bookmarks(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    ids: &[String],
) {
    for id in ids {
        unfreeze_if_locked(session, id);
    }
    {
        let mut state = session.state.lock().unwrap();
        state.bookmarks.retain(|b| !ids.contains(&b.id));
    }
    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

pub(crate) fn process_update_bookmark(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    id: &str,
    name: Option<String>,
    comment: Option<String>,
    group: Option<String>,
    value_type: Option<String>,
) {
    {
        let mut state = session.state.lock().unwrap();
        if let Some(bm) = state.bookmarks.iter_mut().find(|b| b.id == id) {
            bm.name = name;
            bm.comment = comment;
            bm.group = group;
            if value_type.is_some() {
                bm.value_type = value_type;
            }
        }
    }
    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

/// Write a new value to the bookmark's cell once (and update the freeze if locked).
pub(crate) fn process_set_bookmark_value(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    id: &str,
    value: &str,
) {
    let (bm, modules) = {
        let s = session.state.lock().unwrap();
        (s.bookmarks.iter().find(|b| b.id == id).cloned(), s.modules.clone())
    };
    let Some(bm) = bm else { return };
    let Some(vt) = bm.value_type.clone() else { return };
    let Some(bytes) = encode_value(&vt, value) else {
        warn!("Could not parse bookmark value '{}' as {}", value, vt);
        return;
    };
    if let Some(addr) = resolve_address(session, pid, &modules, &bm) {
        if let Err(e) = session.write_memory(pid, addr, bytes.clone()) {
            warn!("Failed to write bookmark value at 0x{:X}: {}", addr, e);
        }
        // If locked, keep the frozen value in sync.
        let freeze_id = session.state.lock().unwrap().bookmarks.iter().find(|b| b.id == id).and_then(|b| b.freeze_id);
        if let Some(fid) = freeze_id {
            let _ = session.update_freeze_value(fid, bytes);
            let mut state = session.state.lock().unwrap();
            if let Some(b) = state.bookmarks.iter_mut().find(|b| b.id == id) {
                b.locked_value = Some(value.to_string());
            }
        }
    }
    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

/// Lock (server-side freeze) or unlock a bookmark's value.
pub(crate) fn process_toggle_bookmark_lock(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
    id: &str,
    locked: bool,
) {
    let (bm, modules) = {
        let s = session.state.lock().unwrap();
        (s.bookmarks.iter().find(|b| b.id == id).cloned(), s.modules.clone())
    };
    let Some(bm) = bm else { return };

    if locked {
        let Some(vt) = bm.value_type.clone() else { return };
        if let Some(addr) = resolve_address(session, pid, &modules, &bm) {
            // Freeze the value currently at the cell.
            if let Ok(bytes) = session.read_memory(pid, addr, value_type_size(&vt)) {
                // For pointer bookmarks, freeze the chain (static base + offsets) so
                // the server re-resolves the target each tick and the lock keeps
                // following the value when the chain repoints (e.g. a level reload).
                // Other kinds freeze the fixed resolved address.
                let (freeze_base, freeze_offsets) = freeze_target(&modules, &bm, addr);
                match session.freeze_value(pid, freeze_base, bytes.clone(), None, freeze_offsets) {
                    Ok(fid) => {
                        let plain = value_to_plain(&vt, &bytes);
                        let mut state = session.state.lock().unwrap();
                        if let Some(b) = state.bookmarks.iter_mut().find(|b| b.id == id) {
                            b.locked = true;
                            b.freeze_id = Some(fid);
                            b.locked_value = Some(plain);
                        }
                        info!("Locked bookmark {} (freeze id {}) at 0x{:X}", id, fid, addr);
                    }
                    Err(e) => warn!("Failed to freeze bookmark {}: {}", id, e),
                }
            }
        }
    } else {
        unfreeze_if_locked(session, id);
        let mut state = session.state.lock().unwrap();
        if let Some(b) = state.bookmarks.iter_mut().find(|b| b.id == id) {
            b.locked = false;
        }
    }

    emit_bookmarks_event(session, pid, app_handle_clone);
    persist_bookmarks(&session.state);
}

/// Re-read live values and emit (called on each pause/step from the frontend).
pub(crate) fn process_refresh_bookmarks(
    session: &mut DebugSession,
    app_handle_clone: &Option<AppHandle>,
    pid: u32,
) {
    emit_bookmarks_event(session, pid, app_handle_clone);
}

/// Stop the server-side freeze for a bookmark (if any). Leaves `locked`/state to
/// the caller; only clears the runtime handle.
fn unfreeze_if_locked(session: &mut DebugSession, id: &str) {
    let freeze_id = session
        .state
        .lock()
        .unwrap()
        .bookmarks
        .iter()
        .find(|b| b.id == id)
        .and_then(|b| b.freeze_id);
    if let Some(fid) = freeze_id {
        let _ = session.unfreeze_value(fid);
        let mut state = session.state.lock().unwrap();
        if let Some(b) = state.bookmarks.iter_mut().find(|b| b.id == id) {
            b.freeze_id = None;
        }
    }
}

/// On module load, re-establish server-side freezes for locked bookmarks rooted in
/// that module (addresses change with ASLR across runs). The display refreshes on
/// the next pause via `emit_bookmarks_event`.
pub(crate) fn reapply_bookmarks_for_module(
    session: &mut DebugSession,
    pid: u32,
    module_name: &str,
) {
    // Bookmarks store the module stem (no extension); normalize the loaded name.
    let want = extract_module_name(module_name).to_lowercase();
    let to_refreeze: Vec<(String, String)> = {
        let s = session.state.lock().unwrap();
        s.bookmarks
            .iter()
            .filter(|b| {
                b.locked
                    && b.freeze_id.is_none()
                    && b.module_name.as_deref().map(|n| n.to_lowercase()) == Some(want.clone())
            })
            .filter_map(|b| b.locked_value.clone().map(|v| (b.id.clone(), v)))
            .collect()
    };

    if to_refreeze.is_empty() {
        return;
    }

    let modules = session.state.lock().unwrap().modules.clone();
    for (id, plain) in to_refreeze {
        let bm = session.state.lock().unwrap().bookmarks.iter().find(|b| b.id == id).cloned();
        let Some(bm) = bm else { continue };
        let Some(vt) = bm.value_type.clone() else { continue };
        let Some(bytes) = encode_value(&vt, &plain) else { continue };
        // Re-establish the freeze as soon as the static base is known (the module
        // just loaded). For pointer bookmarks the server follows the chain each
        // tick and tolerates it being temporarily unresolvable — which it almost
        // always is this early after a restart, before the target object exists.
        // So gate on the static base resolving, NOT on the full chain: otherwise
        // the freeze is never registered and the bookmark shows locked but isn't.
        let Some(base) = static_base(&bm, &modules) else { continue };
        let (freeze_base, freeze_offsets) = freeze_target(&modules, &bm, base);
        if let Ok(fid) = session.freeze_value(pid, freeze_base, bytes, None, freeze_offsets) {
            let mut state = session.state.lock().unwrap();
            if let Some(b) = state.bookmarks.iter_mut().find(|b| b.id == id) {
                b.freeze_id = Some(fid);
            }
            info!("Re-froze locked bookmark {} (freeze id {}) at base 0x{:X}", id, fid, freeze_base);
        }
    }
}
