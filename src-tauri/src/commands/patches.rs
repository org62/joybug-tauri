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

    joybug2::assembler::assemble(arch, &assembly_text, address)
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
/// code). Requires a paused session (writes memory in the debug loop).
#[tauri::command]
pub fn restore_image_bytes(
    session_id: String,
    address: String,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;

    super::send_paused_command(
        &session_id,
        &session_states,
        UICommand::RestoreImageBytes { address },
    )?;

    info!("Restore image bytes request sent for session {} at 0x{:X}", session_id, address);
    Ok(())
}

#[tauri::command]
pub fn enable_patch(
    session_id: String,
    patch_id: String,
    enabled: bool,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
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
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    match super::try_send_paused_command(&session_arc, UICommand::UpdatePatch { patch_id: patch_id.clone(), group: group.clone() }) {
        Ok(()) => {
            info!("Update patch request sent for session {}, patch_id {}", session_id, patch_id);
        }
        Err(_) => {
            // Metadata-only, no server communication needed.
            super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, _pid| {
                crate::session::patches::process_update_patch(oob, &Some(app_handle), &patch_id, group);
            })?;
            info!("OOB update patch for session {}, patch_id {}", session_id, patch_id);
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
    match super::try_send_paused_command(&session_arc, UICommand::EnablePatchGroup { group: group.clone(), enabled }) {
        Ok(()) => {
            info!("Enable patch group request sent for session {}, group '{}', enabled={}", session_id, group, enabled);
        }
        Err(_) => {
            let event = {
                let state = session_arc.lock().unwrap();
                state.current_event.clone()
            };
            if let Some(ref event) = event {
                super::with_oob_client(&session_arc, &session_id, &oob_pool, |oob, _pid| {
                    crate::session::patches::process_enable_patch_group(oob, &Some(app_handle), event, &group, enabled);
                })?;
            }
            info!("OOB enable patch group for session {}, group '{}', enabled={}", session_id, group, enabled);
        }
    }
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
