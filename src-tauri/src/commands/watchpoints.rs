use crate::error::{Error, Result};
use crate::session::UICommand;
use crate::session::breakpoints::{process_start_watchpoint_trace, process_stop_watchpoint_trace};
use crate::session::helpers::format_symbol;
use crate::state::SessionStatesMap;
use serde::Serialize;
use std::collections::HashSet;
use tauri::State;
use tracing::info;

/// One distinct instruction that accessed the watched address, resolved for display.
#[derive(Serialize)]
pub struct WatchpointAccessRow {
    /// The accessing instruction, hex "0x..." (attributed server-side; on x86 the
    /// hardware traps *after* the access and the server back-steps).
    pub accessor: String,
    /// The raw trap instruction pointer, hex "0x..." (the instruction *after* the
    /// access on x86; equal to `accessor` on ARM64).
    pub raw_rip: String,
    /// None when `raw_rip` was passed in `known_rips` (the caller keeps its copy).
    pub symbol: Option<String>,
    /// None when `raw_rip` was passed in `known_rips` (the caller keeps its copy).
    pub disasm: Option<String>,
    pub hit_count: u64,
    /// 1-based first-access order across the trace run.
    pub first_seq: u64,
    pub thread_ids: Vec<u32>,
}

/// Arm a hardware watchpoint at `address` in silent "find what reads/writes this
/// address" mode. `hw_type` is "Write" or "ReadWrite"; `hw_size` is 1/2/4/8. A
/// breakpoint row (bp_kind "watchpoint") appears in the Breakpoints panel; accessors
/// are collected server-side and polled via `poll_watchpoint_accesses`.
#[tauri::command]
pub fn start_watchpoint_trace(
    session_id: String,
    address: String,
    hw_type: String,
    hw_size: u8,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let address = super::parse_hex_u64(&address, "address")?;
    super::paused_or_oob(
        &session_id,
        &session_states,
        &oob_pool,
        UICommand::StartWatchpointTrace { address, hw_type: hw_type.clone(), hw_size },
        |oob, pid| {
            process_start_watchpoint_trace(oob, &Some(app_handle), pid, address, &hw_type, hw_size);
        },
    )?;
    info!("Start watchpoint trace requested for session {} at 0x{:X}", session_id, address);
    Ok(())
}

/// Stop an access trace: tear down the hardware watchpoint but keep the breakpoint
/// row. The collected accessors stay in the frontend panel.
#[tauri::command]
pub fn stop_watchpoint_trace(
    session_id: String,
    breakpoint_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    super::paused_or_oob(
        &session_id,
        &session_states,
        &oob_pool,
        UICommand::StopWatchpointTrace { breakpoint_id: breakpoint_id.clone() },
        |oob, pid| {
            process_stop_watchpoint_trace(oob, &Some(app_handle), pid, &breakpoint_id);
        },
    )?;
    info!("Stop watchpoint trace requested for session {}, bp_id {}", session_id, breakpoint_id);
    Ok(())
}

/// Poll the accessors collected for the watchpoint at `address`. `known_rips`
/// lists raw trap RIPs the caller already holds enriched rows for; symbol and
/// disassembly (immutable per accessor) are resolved only for new ones, so a
/// steady-state poll is a single protocol round trip. Runs on the live OOB
/// connection because the target is typically running while the trace collects.
#[tauri::command]
pub fn poll_watchpoint_accesses(
    session_id: String,
    address: String,
    known_rips: Option<Vec<String>>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<WatchpointAccessRow>> {
    let address = super::parse_hex_u64(&address, "address")?;
    let known: HashSet<u64> = known_rips
        .unwrap_or_default()
        .iter()
        .filter_map(|s| super::parse_hex_u64(s, "known_rips").ok())
        .collect();
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let arch = super::get_session_arch(&session_arc);

    let rows = super::flatten_oob(super::with_oob_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| -> std::result::Result<Vec<WatchpointAccessRow>, String> {
            let accesses = oob.get_watchpoint_accesses(pid, address).map_err(|e| e.to_string())?;
            let mut rows = Vec::with_capacity(accesses.len());
            for a in accesses {
                let (symbol, disasm) = if known.contains(&a.accessor_raw_rip) {
                    (None, None)
                } else {
                    let symbol = match oob.resolve_address_to_symbol(pid, a.accessor) {
                        Ok((Some(m), Some(sym), Some(offset))) => Some(format_symbol(&m, &sym.name, offset)),
                        _ => None,
                    };
                    let disasm = oob
                        .disassemble_memory(pid, a.accessor, 1, arch)
                        .ok()
                        .and_then(|ins| ins.into_iter().next())
                        .map(|i| {
                            if i.op_str.is_empty() { i.mnemonic } else { format!("{} {}", i.mnemonic, i.op_str) }
                        });
                    (symbol, disasm)
                };
                rows.push(WatchpointAccessRow {
                    accessor: format!("0x{:X}", a.accessor),
                    raw_rip: format!("0x{:X}", a.accessor_raw_rip),
                    symbol,
                    disasm,
                    hit_count: a.hit_count,
                    first_seq: a.first_seq,
                    thread_ids: a.thread_ids,
                });
            }
            // Stable, useful order: earliest-seen accessor first.
            rows.sort_by_key(|r| r.first_seq);
            Ok(rows)
        },
    ))
    .map_err(Error::DebugLoop)?;

    Ok(rows)
}
