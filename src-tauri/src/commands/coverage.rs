use crate::error::{Error, Result};
use crate::session::helpers::{find_module_by_name, module_short_name};
use crate::state::SessionStatesMap;
use joybug_core::protocol::CoverageTargetSource;
use serde::Serialize;
use tauri::State;
use tracing::info;

/// One armed coverage function, returned to the frontend at scan start. The
/// frontend holds this table and joins live hit counts (from `get_code_coverage`)
/// by `address`.
#[derive(Serialize)]
pub struct CoverageFn {
    pub address: String, // hex "0x..."
    pub symbol: String,
    pub rva: u32,
    /// Where the address came from: `"pdata"` (exception directory), `"symbol"`
    /// (PDB says function), `"validated"` (a symbol not marked as a function that
    /// passed the code-sanity check), or `"custom"` (named explicitly by the
    /// user). Lets the UI show why a nameless row is in the table.
    pub source: &'static str,
}

/// Result of starting a scan: the armed table, plus any custom-list entries that
/// named nothing so the user can see what was dropped instead of silently
/// getting a shorter table.
#[derive(Serialize)]
pub struct CoverageStartResult {
    pub functions: Vec<CoverageFn>,
    pub unresolved: Vec<String>,
}

/// Map the frontend's source names onto the protocol enum. An empty list means
/// "every source", which is what the server already treats as unrestricted.
fn parse_sources(sources: &[String]) -> Result<Vec<CoverageTargetSource>> {
    sources
        .iter()
        .map(|s| match s.as_str() {
            "pdata" => Ok(CoverageTargetSource::Pdata),
            "symbol" => Ok(CoverageTargetSource::FunctionSymbol),
            "validated" => Ok(CoverageTargetSource::ValidatedSymbol),
            other => Err(Error::InvalidParameter(format!(
                "Unknown coverage target source: {}",
                other
            ))),
        })
        .collect()
}

/// A live hit count for one covered address.
#[derive(Serialize)]
pub struct CoverageHit {
    pub address: String, // hex "0x..."
    pub hit_count: u64,
    /// 1-based first-execution order across the coverage run (always >= 1 —
    /// only addresses hit at least once are reported).
    pub first_hit_seq: u64,
    /// Microseconds from the start of the coverage run to this address' first
    /// hit. Only the first hit is timed, so this is a point on the execution
    /// timeline, not a duration — differences between rows are what's meaningful.
    pub first_hit_us: u64,
    /// Distinct thread ids that hit this address, in first-hit order.
    pub thread_ids: Vec<u32>,
}

/// Enumerate every function in `module_name`, arm silent server-side coverage
/// breakpoints on them, and return the armed function table (address/symbol/rva).
/// `hit_limit` is the hit count after which each breakpoint auto-removes
/// (1 = remove on first hit = pure coverage; >1 = heat map; 0 = never remove).
///
/// The target set is the server-side union of the module's `.pdata`
/// RUNTIME_FUNCTION starts and its symbols (see
/// `PlatformAPI::enumerate_coverage_targets`), so a module whose PDB marks
/// nothing as a function — obfuscated builds, stripped binaries — still gets
/// its real functions armed.
///
/// Runs on the scan OOB connection: symbol enumeration + arming thousands of
/// breakpoints can take seconds and must not head-of-line-block the live
/// connection's high-frequency polling.
/// `sources` names the enumeration tiers to draw from (`"pdata"`, `"symbol"`,
/// `"validated"`). Omitting a tier is how a user opts out of it — `["pdata"]`
/// arms only what the exception directory vouches for, and an empty list
/// enumerates nothing at all.
///
/// `custom_entries` are *added* to whatever enumeration produced, so an explicit
/// list composes with the other sources instead of replacing them. Each line is
/// a hex address or a symbol name in this module; lines naming nothing come back
/// in `unresolved`. At least one of the two must yield an address.
#[tauri::command]
pub fn start_code_coverage(
    session_id: String,
    module_name: String,
    hit_limit: u64,
    sources: Vec<String>,
    custom_entries: Vec<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<CoverageStartResult> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let (module_path, base) = {
        let state = session_arc.lock().unwrap();
        find_module_by_name(&state.modules, &module_name)
            .map(|m| (m.name.clone(), m.base))
            .ok_or_else(|| Error::InvalidParameter(format!("Module not loaded: {}", module_name)))?
    };
    let short = module_short_name(&module_path);
    let sources = parse_sources(&sources)?;

    let result = super::flatten_oob(super::with_oob_scan_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| -> std::result::Result<CoverageStartResult, String> {
            let mut functions: Vec<CoverageFn> = Vec::new();
            let mut addrs: Vec<u64> = Vec::new();
            let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();

            if !sources.is_empty() {
                // The server deduplicates by address and guarantees every target
                // is in committed executable memory, so this is a straight mapping.
                let targets = oob
                    .enumerate_coverage_targets(pid, &module_path, sources.clone())
                    .map_err(|e| e.to_string())?;
                for t in targets {
                    if !seen.insert(t.address) {
                        continue;
                    }
                    addrs.push(t.address);
                    functions.push(CoverageFn {
                        address: format!("0x{:X}", t.address),
                        // A `.pdata` function no symbol covers still needs a label.
                        symbol: t.symbol.unwrap_or_else(|| format!("sub_{:X}", t.address)),
                        rva: t.rva,
                        source: match t.source {
                            CoverageTargetSource::Pdata => "pdata",
                            CoverageTargetSource::FunctionSymbol => "symbol",
                            CoverageTargetSource::ValidatedSymbol => "validated",
                        },
                    });
                }
            }

            // The list is additive, and an address enumeration already found
            // keeps that richer label rather than being relabelled "custom".
            let mut unresolved = Vec::new();
            if !custom_entries.is_empty() {
                let symbols = oob.list_symbols(&module_path).map_err(|e| e.to_string())?;
                let (custom, missing) = resolve_custom_entries(&custom_entries, &symbols, base);
                unresolved = missing;
                for (address, f) in custom {
                    if seen.insert(address) {
                        addrs.push(address);
                        functions.push(f);
                    }
                }
            }

            // Arming nothing looks exactly like "this module was never executed"
            // in the table, so say why instead.
            if functions.is_empty() {
                return Err(if sources.is_empty() {
                    format!(
                        "None of the {} listed entries resolved to an address in {}",
                        custom_entries.len(),
                        module_path
                    )
                } else {
                    format!(
                        "Nothing to arm coverage on in {} — the selected sources yielded no \
                         executable addresses",
                        module_path
                    )
                });
            }

            oob.start_coverage(pid, addrs, hit_limit).map_err(|e| e.to_string())?;
            Ok(CoverageStartResult { functions, unresolved })
        },
    ))
    .map_err(Error::DebugLoop)?;

    info!(
        "Started code coverage for session {} on {} ({} functions, {} unresolved, limit {})",
        session_id,
        short,
        result.functions.len(),
        result.unresolved.len(),
        hit_limit
    );
    Ok(result)
}

/// Turn a user-supplied list into armable targets. Each entry is a hex address
/// (`0x...`, or bare hex) or a symbol name in this module; `module!name` is
/// accepted so a line copied from the symbol panel works unchanged. Blank lines
/// and `#`/`;` comments are ignored so a pasted report needs no cleaning up.
///
/// Names are matched case-insensitively and may resolve to several addresses
/// (overloads, ICF-folded aliases); every one is armed. Deliberately skips the
/// code-sanity check — an explicit list is the user overriding the heuristic,
/// which is the entire point of the feature.
///
/// Returns `(address, row)` pairs so the caller arms and dedupes off the `u64`
/// directly rather than round-tripping it back through the hex string.
fn resolve_custom_entries(
    entries: &[String],
    symbols: &[joybug_core::interfaces::ModuleSymbol],
    base: u64,
) -> (Vec<(u64, CoverageFn)>, Vec<String>) {
    use std::collections::{HashMap, HashSet};

    // Blank lines and `#`/`;` comments drop out so a pasted report needs no
    // cleanup; `line` keeps the `module!` prefix for the unresolved report.
    let lines: Vec<&str> = entries
        .iter()
        .map(|e| e.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with(';'))
        .collect();
    // `module!symbol` → the symbol part; the panel is module-scoped.
    let symbol_of = |line: &str| line.rsplit('!').next().unwrap_or(line).trim().to_string();

    // Index only the names actually looked up — a list of pure hex addresses
    // (the common paste) builds no map at all, instead of lowercasing every
    // symbol of an ntdll-sized table to match a handful of names.
    let wanted: HashSet<String> = lines
        .iter()
        .map(|l| symbol_of(l))
        .filter(|name| prefixed_hex(name).is_none())
        .map(|name| name.to_lowercase())
        .collect();
    let mut by_name: HashMap<String, Vec<&joybug_core::interfaces::ModuleSymbol>> = HashMap::new();
    if !wanted.is_empty() {
        for symbol in symbols {
            let key = symbol.name.to_lowercase();
            if wanted.contains(&key) {
                by_name.entry(key).or_default().push(symbol);
            }
        }
    }

    let mut resolved: Vec<(u64, CoverageFn)> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut push = |address: u64, symbol: String| {
        resolved.push((
            address,
            CoverageFn {
                address: format!("0x{:X}", address),
                symbol,
                // Meaningless for an address outside the module, but the column
                // is only ever read alongside the address it was derived from.
                rva: address.wrapping_sub(base) as u32,
                source: "custom",
            },
        ));
    };

    for line in &lines {
        let name = symbol_of(line);
        if let Some(address) = prefixed_hex(&name) {
            push(address, format!("sub_{:X}", address));
            continue;
        }
        match by_name.get(&name.to_lowercase()) {
            Some(matches) => {
                for symbol in matches {
                    push(base + symbol.rva as u64, symbol.name.clone());
                }
            }
            // Bare hex only after the name lookup fails: a symbol legitimately
            // named `abc` must not be hijacked as the address 0xABC.
            None => match u64::from_str_radix(&name, 16) {
                Ok(address) => push(address, format!("sub_{:X}", address)),
                Err(_) => unresolved.push(line.to_string()),
            },
        }
    }
    (resolved, unresolved)
}

/// A `0x`/`0X`-prefixed hex literal as a value, or `None` when the prefix is
/// absent — a bare hex string is treated as an address only after a symbol-name
/// lookup misses, so it must not match here.
fn prefixed_hex(s: &str) -> Option<u64> {
    let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    u64::from_str_radix(hex, 16).ok()
}

/// Poll live hit counts. The server returns only addresses hit at least once;
/// the frontend fills zeros for the rest from the table returned by
/// `start_code_coverage`.
#[tauri::command]
pub fn get_code_coverage(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<CoverageHit>> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let hits = super::flatten_oob(super::with_oob_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| oob.get_coverage(pid),
    ))
    .map_err(Error::DebugLoop)?;

    Ok(hits
        .into_iter()
        .map(|h| CoverageHit {
            address: format!("0x{:X}", h.address),
            hit_count: h.hit_count,
            first_hit_seq: h.first_hit_seq,
            first_hit_us: h.first_hit_us,
            thread_ids: h.thread_ids,
        })
        .collect())
}

/// Remove all coverage breakpoints and clear coverage state. On the scan
/// connection like `start_code_coverage` (unwriting thousands of breakpoint
/// bytes is slow).
#[tauri::command]
pub fn stop_code_coverage(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<()> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    super::flatten_oob(super::with_oob_scan_client(
        &session_arc,
        &session_id,
        &oob_pool,
        |oob, pid| oob.stop_coverage(pid),
    ))
    .map_err(Error::DebugLoop)?;

    info!("Stopped code coverage for session {}", session_id);
    Ok(())
}
