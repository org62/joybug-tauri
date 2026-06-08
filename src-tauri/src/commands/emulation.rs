use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::state::SessionStatesMap;
use tauri::State;
use tracing::info;

#[tauri::command]
pub fn request_emulation(
    session_id: String,
    max_instructions: usize,
    mode: String,
    exit_address: Option<u64>,
    request_id: Option<String>,
    memory_reads: Option<Vec<(u64, usize)>>,
    session_states: State<'_, SessionStatesMap>,
) -> Result<()> {
    let emulation_mode = match mode.as_str() {
        "Basic" => joybug2::protocol_io::EmulationMode::Basic,
        "InstructionTrace" => joybug2::protocol_io::EmulationMode::InstructionTrace,
        "BasicBlock" => joybug2::protocol_io::EmulationMode::BasicBlock,
        "ModuleTransition" => joybug2::protocol_io::EmulationMode::ModuleTransition,
        "Syscall" => joybug2::protocol_io::EmulationMode::Syscall,
        _ => return Err(Error::InvalidParameter(format!("Unknown emulation mode: {}", mode))),
    };

    let exit_condition = exit_address.map(joybug2::protocol_io::TraceExitCondition::ReachAddress);

    super::send_paused_command(&session_id, &session_states, UICommand::Emulate {
        max_instructions,
        mode: emulation_mode,
        exit_condition,
        request_id,
        memory_reads: memory_reads.unwrap_or_default(),
    })?;

    info!("Emulation request sent for session {} with mode {}", session_id, mode);
    Ok(())
}
