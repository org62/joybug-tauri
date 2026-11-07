//! Pseudocode for the function at an address (`joybug_core::decompiler`).
//!
//! The engine decompiles a module's **file on disk** on its own thread, and
//! one request can take seconds (the first for a module loads it), so nothing
//! here goes near the session thread: the commands are async, wait for the
//! engine on the blocking pool and return the result directly. What they ask
//! of the target — which module, where the function starts — is a couple of
//! short requests on the live OOB connection; a module's symbols, listed once
//! per symbol state, come over the snapshot connection.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use joybug_core::decompiler::{self, DecompileClient, DecompileError, DecompileRequest, Decompiled, SymbolSet};
use joybug_core::protocol::ModuleSymbolStatus;
use serde::Serialize;
use tauri::{Manager, State};

use super::{get_session_arc, parse_hex_u64, run_blocking, with_oob_client, with_oob_snapshot_client, OobPool};
use crate::error::Result;
use crate::session::disassembly::build_image_diff_context;
use crate::session::helpers::{module_containing, modules_or_enumerate};
use crate::state::SessionStatesMap;

/// The instructions of the function fetched to compare its memory with the
/// file. A longer function is compared over this much.
const MAX_COMPARED_INSTRUCTIONS: usize = 4000;

/// Symbol sets kept for reuse; the oldest goes first.
const MAX_SYMBOL_SETS: usize = 8;

#[derive(Serialize)]
pub struct DecompiledLine {
    /// 1-based line of `code`.
    pub line: u32,
    /// The instructions the line came from, as hex addresses.
    pub addresses: Vec<String>,
}

#[derive(Serialize)]
pub struct DecompiledFunction {
    pub name: String,
    pub start: String,
    /// Exclusive end of the function, hex.
    pub end: String,
    pub code: String,
    pub lines: Vec<DecompiledLine>,
    /// The function's code in the target's memory is not what the file holds
    /// (a patch, a hook), so the pseudocode — made from the file — is not what runs.
    pub differs_from_image: bool,
}

/// What a decompile request came to. The expected ways of not getting
/// pseudocode are outcomes, not errors: the view shows each as a state of its own.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DecompileOutcome {
    Ok(DecompiledFunction),
    /// No function (or no module) at the address.
    NoFunction,
    /// A newer request of the same view replaced this one before it ran.
    Superseded,
    Failed { message: String },
}

/// `DecompileOutcome::code` of `NoFunction`.
const OUTCOME_NO_FUNCTION: u64 = 1;

impl DecompileOutcome {
    /// The outcome as the `outcome` attribute of a telemetry span: 0 ok,
    /// 1 no function, 2 superseded, 3 failed.
    pub(crate) fn code(&self) -> u64 {
        match self {
            DecompileOutcome::Ok(_) => 0,
            DecompileOutcome::NoFunction => OUTCOME_NO_FUNCTION,
            DecompileOutcome::Superseded => 2,
            DecompileOutcome::Failed { .. } => 3,
        }
    }
}

/// Turn the engine's answer (RVAs) into the view's (addresses at `base`).
pub(crate) fn outcome(
    result: std::result::Result<Decompiled, DecompileError>,
    base: u64,
    differs_from_image: bool,
) -> DecompileOutcome {
    let hex = |address: u64| format!("0x{address:X}");
    match result {
        Ok(function) => {
            let start = base + function.start_rva;
            DecompileOutcome::Ok(DecompiledFunction {
                name: function.name,
                start: hex(start),
                end: hex(start + function.size.max(1)),
                code: function.code,
                lines: function
                    .lines
                    .into_iter()
                    .map(|l| DecompiledLine { line: l.line, addresses: l.rvas.into_iter().map(|rva| hex(base + rva)).collect() })
                    .collect(),
                differs_from_image,
            })
        }
        Err(DecompileError::NoFunction) => DecompileOutcome::NoFunction,
        Err(DecompileError::Superseded) => DecompileOutcome::Superseded,
        Err(e) => DecompileOutcome::Failed { message: e.to_string() },
    }
}

/// The function names of the modules decompiled lately, so that stepping
/// through a module does not list its symbols again for every function. An
/// entry is good for as long as the module's file and its symbol state are
/// what they were.
#[derive(Default)]
pub struct DecompilerSymbols(Mutex<VecDeque<(String, Arc<SymbolSet>)>>);

impl DecompilerSymbols {
    fn get_or_load(&self, key: String, load: impl FnOnce() -> Option<Arc<SymbolSet>>) -> Option<Arc<SymbolSet>> {
        if let Some((_, symbols)) = self.0.lock().unwrap().iter().find(|(k, _)| *k == key) {
            return Some(Arc::clone(symbols));
        }
        let symbols = load()?;
        let mut sets = self.0.lock().unwrap();
        sets.retain(|(k, _)| *k != key);
        if sets.len() >= MAX_SYMBOL_SETS {
            sets.pop_front();
        }
        sets.push_back((key, Arc::clone(&symbols)));
        Some(symbols)
    }
}

/// What identifies a module's symbols: its file as it is now, and how far the
/// debugger has got with loading its debug info.
fn symbols_key(module_path: &str, status: Option<&ModuleSymbolStatus>) -> String {
    let file = crate::session::breakpoints::module_file_fingerprint(module_path).unwrap_or_default();
    let status = status.map(|s| format!("{:?}|{:?}", s.state, s.pdb_path)).unwrap_or_default();
    format!("{module_path}|{file}|{status}")
}

/// Decompile the function containing `address` in a session's target.
#[tauri::command]
pub async fn decompile_function(
    session_id: String,
    address: String,
    client: DecompileClient,
    session_states: State<'_, SessionStatesMap>,
    app_handle: tauri::AppHandle,
) -> Result<DecompileOutcome> {
    let address = parse_hex_u64(&address, "address")?;
    let session_arc = get_session_arc(&session_id, &session_states)?;
    run_blocking(move || {
        let mut span = joybug_core::perf::span("app.decompile");
        // A decompile that never answers records no span: this says one started.
        joybug_core::perf::record("app.decompile.begin", joybug_core::perf::now_us(), 0, &[]);
        let phase = std::time::Instant::now();
        let pool = app_handle.state::<OobPool>();
        let symbol_sets = app_handle.state::<DecompilerSymbols>();
        let arch = super::get_session_arch(&session_arc);
        let image_diff = build_image_diff_context(&session_arc, arch, address);
        let asked = with_oob_client(&session_arc, &session_id, &pool, |client, pid| {
            let modules = modules_or_enumerate(client, pid);
            let module = module_containing(&modules, address)?.clone();
            let (instructions, start, end, _) =
                client.disassemble_function(pid, address, MAX_COMPARED_INSTRUCTIONS, arch).unwrap_or_default();
            let status = client.get_symbol_status(pid).ok().and_then(|all| all.into_iter().find(|s| s.module_base == module.base));
            // Without bounds the listing is a window of whatever follows, not this function.
            let differs = start.is_some() && image_diff.as_ref().is_some_and(|diff| diff.any_differs(&instructions));
            let key = symbols_key(&module.name, status.as_ref());
            Some((module, start.map(|start| (start, end.unwrap_or(start))), key, differs))
        })?;
        span.attr_elapsed("target_us", phase);
        let Some((module, bounds, key, differs)) = asked else {
            span.attr("outcome", OUTCOME_NO_FUNCTION);
            return Ok(DecompileOutcome::NoFunction);
        };
        span.attr("has_bounds", bounds.is_some() as u64);
        // Names are a refinement: a module without symbols decompiles without.
        // Listing them can take a while for a large debug file, so it is kept
        // off the live connection.
        let phase = std::time::Instant::now();
        let symbols = symbol_sets.get_or_load(key, || {
            with_oob_snapshot_client(&session_arc, &session_id, &pool, |client, _| client.list_symbols(&module.name).ok())
                .ok()
                .flatten()
                .map(|symbols| SymbolSet::from_module_symbols(&symbols))
        });
        span.attr_elapsed("symbols_us", phase);
        span.attr("symbols", symbols.as_ref().map_or(0, |s| s.names().len() as u64));
        let rva = |address: u64| address.checked_sub(module.base);
        let phase = std::time::Instant::now();
        let result = decompiler::global().decompile(DecompileRequest {
            rva: address - module.base,
            function: bounds.and_then(|(start, end)| rva(start).zip(rva(end))),
            image_path: module.name,
            symbols,
            client: Some(client),
        });
        span.attr_elapsed("engine_us", phase);
        let outcome = outcome(result, module.base, differs);
        span.attr("outcome", outcome.code());
        Ok(outcome)
    })
    .await
}
