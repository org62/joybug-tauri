use crate::error::Result;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

/// Bookmark commands run inside the paused debug loop when the session is paused.
/// Otherwise (running without a pause, or a non-invasive `Open` session) they run
/// over the session's persistent *live* OOB pool connection, which shares the
/// session state Arc and stays alive for the session's lifetime — so server-side
/// value freezes (registered per-connection) survive, unlike a throwaway client.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_bookmark(
    session_id: String,
    kind: String,
    address: String,
    value_type: Option<String>,
    name: Option<String>,
    comment: Option<String>,
    pointer_offsets: Option<Vec<String>>,
    base_symbol: Option<String>,
    asm_text: Option<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;
    let pointer_offsets = match pointer_offsets {
        Some(offs) => Some(
            offs.iter()
                .map(|o| super::parse_hex_u64(o, "offset"))
                .collect::<Result<Vec<_>>>()?,
        ),
        None => None,
    };
    let cmd = UICommand::AddBookmark {
        kind: kind.clone(), address, value_type: value_type.clone(), name: name.clone(),
        comment: comment.clone(), pointer_offsets: pointer_offsets.clone(),
        base_symbol: base_symbol.clone(), asm_text: asm_text.clone(),
    };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_add_bookmark(client, &handle, pid, kind, address, value_type, name, comment, pointer_offsets, base_symbol, asm_text);
    })?;
    info!("Add bookmark processed for session {} at 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn remove_bookmark(
    session_id: String,
    id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let cmd = UICommand::RemoveBookmark { id: id.clone() };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_remove_bookmark(client, &handle, pid, &id);
    })
}

#[tauri::command]
pub fn remove_bookmarks(
    session_id: String,
    ids: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let cmd = UICommand::RemoveBookmarks { ids: ids.clone() };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_remove_bookmarks(client, &handle, pid, &ids);
    })
}

#[tauri::command]
pub fn update_bookmark(
    session_id: String,
    id: String,
    name: Option<String>,
    comment: Option<String>,
    group: Option<String>,
    value_type: Option<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let cmd = UICommand::UpdateBookmark {
        id: id.clone(), name: name.clone(), comment: comment.clone(),
        group: group.clone(), value_type: value_type.clone(),
    };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_update_bookmark(client, &handle, pid, &id, name, comment, group, value_type);
    })
}

#[tauri::command]
pub fn set_bookmark_value(
    session_id: String,
    id: String,
    value: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let cmd = UICommand::SetBookmarkValue { id: id.clone(), value: value.clone() };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_set_bookmark_value(client, &handle, pid, &id, &value);
    })
}

#[tauri::command]
pub fn toggle_bookmark_lock(
    session_id: String,
    id: String,
    locked: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let cmd = UICommand::ToggleBookmarkLock { id: id.clone(), locked };
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, cmd, |client, pid| {
        crate::session::bookmarks::process_toggle_bookmark_lock(client, &handle, pid, &id, locked);
    })
}

#[tauri::command]
pub fn refresh_bookmarks(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // When paused, route through the session channel (so the freeze stays on the
    // session's own connection). When running, read live values over a reused OOB
    // connection — same pattern as memory reads — so bookmark values keep updating
    // without a pause, and high-frequency polling doesn't churn TCP connections.
    // The OOB client shares the session's state Arc, so it resolves and reads
    // exactly as the in-session path does, then emits bookmarks-updated.
    let handle = Some(app_handle);
    super::paused_or_oob(&session_id, &session_states, &oob_pool, UICommand::RefreshBookmarks, |client, pid| {
        crate::session::bookmarks::emit_bookmarks_event(client, pid, &handle);
    })
}
