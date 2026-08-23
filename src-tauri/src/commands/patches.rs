use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::{PatchInfo, SessionStatesMap};
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn assemble_patch(
    session_id: String,
    address: String,
    assembly_text: String,
    nop_pad: Option<bool>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let arch = super::get_session_arch(&session_arc);

    joybug_core::assembler::assemble(arch, &assembly_text, address)
        .map_err(|e| Error::InvalidParameter(format!("Assembly failed: {}", e)))?;

    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::AssemblePatch { address, assembly_text: assembly_text.clone(), arch, nop_pad: nop_pad.unwrap_or(false) },
    )?;

    info!("Assemble patch request sent for session {} at 0x{:X}: {}", session_id, address, assembly_text);
    Ok(())
}

#[tauri::command]
pub fn undo_patch(
    session_id: String,
    patch_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::UndoPatch { patch_id: patch_id.clone() },
    )?;

    info!("Undo patch request sent for session {}, patch_id {}", session_id, patch_id);
    Ok(())
}

#[tauri::command]
pub fn undo_patches(
    session_id: String,
    patch_ids: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::UndoPatches { patch_ids: patch_ids.clone() },
    )?;

    info!("Undo patches request sent for session {}, {} patches", session_id, patch_ids.len());
    Ok(())
}

/// Restore the original on-disk image bytes at `address` for an in-memory
/// modification that has no tracked UI patch (external hook, self-modifying
/// code). Runs in the debug loop when paused, otherwise over OOB — a
/// non-invasive `Open` handle carries `PROCESS_VM_WRITE`, so no attach is needed.
#[tauri::command]
pub fn restore_image_bytes(
    session_id: String,
    address: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::RestoreImageBytes { address },
        |client, pid| crate::session::patches::process_restore_image_bytes(client, &handle, pid, address),
    )?;

    info!("Restore image bytes request sent for session {} at 0x{:X}", session_id, address);
    Ok(())
}

/// Diff all loaded modules' executable sections against their on-disk images
/// and emit the modified runs on `image-patches-updated` (the Image Patches
/// window). Runs in the debug loop when paused, otherwise over OOB so a running
/// or non-invasive `Open` session can scan without an attach.
#[tauri::command]
pub fn scan_image_patches(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let handle = Some(app_handle);
    super::paused_or_oob(
        &session_id, &session_states, &oob_pool,
        UICommand::ScanImagePatches,
        |client, pid| crate::session::image_patches::process_scan_image_patches(client, &handle, pid),
    )?;
    info!("Image patch scan request sent for session {}", session_id);
    Ok(())
}

#[tauri::command]
pub fn enable_patch(
    session_id: String,
    patch_id: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    // Applying/undoing bytes needs a paused target; with no process at all the
    // flag is flipped offline and takes effect on the next module load.
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    if super::is_stopped(&session_arc) {
        crate::session::patches::set_patch_enabled_offline(&session_arc, &app_handle, |p| p.id == patch_id, enabled);
        info!("Offline enable patch for session {}, patch_id {}, enabled={}", session_id, patch_id, enabled);
        return Ok(());
    }
    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::EnablePatch { patch_id: patch_id.clone(), enabled },
    )?;

    info!("Enable patch request sent for session {}, patch_id {}, enabled={}", session_id, patch_id, enabled);
    Ok(())
}

#[tauri::command]
pub fn update_patch(
    session_id: String,
    patch_id: String,
    group: Option<String>,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    // Metadata-only: nothing to say to the server on any path, so when the
    // paused channel isn't available the state edit is the whole operation —
    // no OOB connection needed (and none to fail) whether running or stopped.
    match super::try_send_paused_command(&session_arc, UICommand::UpdatePatch { patch_id: patch_id.clone(), group: group.clone() }) {
        Ok(()) => {
            info!("Update patch request sent for session {}, patch_id {}", session_id, patch_id);
        }
        Err(_) => {
            crate::session::patches::update_patch_offline(&session_arc, &app_handle, &patch_id, group);
            info!("Update patch applied to state for session {}, patch_id {}", session_id, patch_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn enable_patch_group(
    session_id: String,
    group: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let event = {
        let state = session_arc.lock().unwrap();
        state.current_event.clone()
    };
    let handle = app_handle.clone();
    let route = super::paused_or_offline_or_oob(
        &session_arc, &session_id, &oob_pool,
        UICommand::EnablePatchGroup { group: group.clone(), enabled },
        || crate::session::patches::set_patch_enabled_offline(&session_arc, &handle, |p| p.group.as_deref() == Some(group.as_str()), enabled),
        |oob, _pid| {
            if let Some(ref event) = event {
                crate::session::patches::process_enable_patch_group(oob, &Some(app_handle), event, &group, enabled);
            }
        },
    )?;
    info!("Enable patch group for session {}, group '{}', enabled={} ({:?})", session_id, group, enabled, route);
    Ok(())
}

#[tauri::command]
pub fn get_patches(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<Vec<PatchInfo>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let state = session_arc.lock().unwrap();
    Ok(state.patches.clone())
}
