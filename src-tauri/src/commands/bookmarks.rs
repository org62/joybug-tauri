use crate::error::Result;
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

/// Bookmark commands route through the paused session channel so the server-side
/// value freeze (lock) is registered on the session's own connection — an OOB
/// client's freezes would die when its connection closes.

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
    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::AddBookmark { kind, address, value_type, name, comment, pointer_offsets, base_symbol, asm_text },
    )?;
    info!("Add bookmark request sent for session {} at 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn remove_bookmark(
    session_id: String,
    id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::RemoveBookmark { id })?;
    Ok(())
}

#[tauri::command]
pub fn remove_bookmarks(
    session_id: String,
    ids: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::RemoveBookmarks { ids })?;
    Ok(())
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
) -> Result<()> {
    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::UpdateBookmark { id, name, comment, group, value_type },
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_bookmark_value(
    session_id: String,
    id: String,
    value: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::SetBookmarkValue { id, value })?;
    Ok(())
}

#[tauri::command]
pub fn toggle_bookmark_lock(
    session_id: String,
    id: String,
    locked: bool,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(&session_id, &session_states, UICommand::ToggleBookmarkLock { id, locked })?;
    Ok(())
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
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::RefreshBookmarks) {
        Ok(()) => {}
        Err(_) => {
            // The OOB client shares the session's state Arc, so this resolves and
            // reads exactly as the in-session path does, then emits bookmarks-updated.
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |client, pid| {
                crate::session::bookmarks::emit_bookmarks_event(client, pid, &Some(app_handle.clone()));
            })?;
        }
    }
    Ok(())
}
