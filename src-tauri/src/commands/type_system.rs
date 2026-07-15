//! Type-system commands: read PDB struct/enum layouts and manage user-defined types.
//!
//! PDB type queries are read-only and static, so — like `get_session_symbol_status`
//! — they run purely over the pooled OOB client and work while Running, Paused, or
//! non-invasively Open. Custom types are app-global definitions persisted to disk and
//! resolved into the same `TypeLayoutData` shape so both render through one UI path.

use crate::commands::types::{TypeLayoutData, TypeRefData, TypeSummaryData};
use crate::custom_types::{
    self, CustomTypeDef, ResolvedNamed,
};
use crate::error::{Error, Result};
use crate::session::types::DebugSession;
use crate::state::SessionStatesMap;
use std::collections::{HashMap, HashSet};
use tauri::State;
use tracing::warn;

// -------------------------------------------------------------------------
// PDB types
// -------------------------------------------------------------------------

/// List type summaries: user-defined types first, then UDT/enum summaries from
/// loaded module PDBs. `module_base = None` searches all loaded modules; `filter`
/// is a case-insensitive name substring. Custom types are app-global and listed
/// even when the session/PDB path is unavailable.
#[tauri::command]
pub fn list_session_types(
    session_id: String,
    module_base: Option<String>,
    filter: Option<String>,
    max_results: Option<usize>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Vec<TypeSummaryData>> {
    let filter_lc = filter.as_deref().unwrap_or("").to_lowercase();
    let customs = custom_types::load_custom_types();
    let custom_names: HashSet<String> = customs.iter().map(|c| c.name.clone()).collect();
    let mut out: Vec<TypeSummaryData> = customs
        .iter()
        .filter(|c| filter_lc.is_empty() || c.name.to_lowercase().contains(&filter_lc))
        .map(|c| TypeSummaryData {
            name: c.name.clone(),
            // Offline resolve: exact for primitive-only types, a lower bound when
            // the type references PDB types (sized 0 without a session).
            size: resolve_custom_offline(c, &custom_names).size,
            kind: if c.is_union { "union" } else { "struct" }.to_string(),
            index: 0,
            module_base: "0x0".to_string(),
            module_name: "(custom)".to_string(),
            source: "custom".to_string(),
        })
        .collect();

    let session_arc = match super::get_session_arc(&session_id, &session_states) {
        Ok(arc) => arc,
        Err(_) => return Ok(out),
    };
    let base = module_base
        .as_deref()
        .map(|s| super::parse_hex_u64(s, "module base"))
        .transpose()?;
    let max = max_results.unwrap_or(5000);
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, move |oob, pid| {
        oob.list_types(pid, base, filter.as_deref(), max)
    });
    match super::flatten_oob(result) {
        Ok(types) => out.extend(types.into_iter().map(Into::<TypeSummaryData>::into)),
        Err(e) => warn!("list_session_types failed for session {}: {}", session_id, e),
    }
    Ok(out)
}

/// Resolve a named type's layout. Checks user-defined types first, then module PDBs
/// (`module_base = None` searches all modules).
#[tauri::command]
pub fn get_session_type(
    session_id: String,
    name: String,
    module_base: Option<String>,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Option<TypeLayoutData>> {
    // User-defined types shadow PDB types of the same name.
    let customs = custom_types::load_custom_types();
    if let Some(def) = customs.iter().find(|c| c.name == name) {
        return Ok(Some(resolve_custom_def(
            def,
            &customs,
            &session_id,
            &session_states,
            &oob_pool,
        )));
    }

    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let base = module_base
        .as_deref()
        .map(|s| super::parse_hex_u64(s, "module base"))
        .transpose()?;
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, move |oob, pid| {
        oob.get_type(pid, base, &name)
    });
    match super::flatten_oob(result) {
        Ok(layout) => Ok(layout.map(Into::into)),
        Err(e) => Err(Error::InternalCommunication(e)),
    }
}

/// TEB/PEB base addresses (hex) for the session's current thread — anchors for the
/// `_TEB` / `_PEB` overlays.
#[derive(serde::Serialize)]
pub struct TebPebData {
    pub teb: Option<String>,
    pub peb: Option<String>,
}

#[tauri::command]
pub fn get_session_teb_peb(
    session_id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<TebPebData> {
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let tid_hint = {
        let state = session_arc.lock().unwrap();
        state.current_event.as_ref().map(|ev| ev.tid())
    };
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, move |client, pid| {
        let tid = match tid_hint {
            Some(t) => t,
            None => client
                .list_threads(pid)
                .ok()
                .and_then(|ts| ts.first().map(|t| t.tid))
                .unwrap_or(0),
        };
        client.get_teb_peb_addresses(pid, tid)
    });
    match super::flatten_oob(result) {
        Ok((teb, peb)) => Ok(TebPebData {
            teb: teb.map(|a| format!("0x{:X}", a)),
            peb: peb.map(|a| format!("0x{:X}", a)),
        }),
        Err(e) => Err(Error::InternalCommunication(e)),
    }
}

/// Resolve a type by its TPI index within a specific module (nested expansion).
#[tauri::command]
pub fn get_session_type_by_index(
    session_id: String,
    module_base: String,
    index: u32,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<Option<TypeLayoutData>> {
    let base = super::parse_hex_u64(&module_base, "module base")?;
    let session_arc = super::get_session_arc(&session_id, &session_states)?;
    let result = super::with_oob_client(&session_arc, &session_id, &oob_pool, move |oob, pid| {
        oob.get_type_by_index(pid, base, index)
    });
    match super::flatten_oob(result) {
        Ok(layout) => Ok(layout.map(Into::into)),
        Err(e) => Err(Error::InternalCommunication(e)),
    }
}

// -------------------------------------------------------------------------
// Custom types
// -------------------------------------------------------------------------

/// List all user-defined type definitions.
#[tauri::command]
pub fn list_custom_types() -> Result<Vec<CustomTypeDef>> {
    Ok(custom_types::load_custom_types())
}

/// Create or update a user-defined type (upsert by id; assigns an id when empty).
/// Returns the stored definition.
#[tauri::command]
pub fn save_custom_type(mut def: CustomTypeDef) -> Result<CustomTypeDef> {
    if def.name.trim().is_empty() {
        return Err(Error::InvalidParameter("Type name is required".to_string()));
    }
    let mut types = custom_types::load_custom_types();
    if def.id.trim().is_empty() {
        def.id = uuid::Uuid::new_v4().to_string();
    }
    match types.iter_mut().find(|t| t.id == def.id) {
        Some(existing) => *existing = def.clone(),
        None => types.push(def.clone()),
    }
    custom_types::save_custom_types(&types);
    Ok(def)
}

/// Delete a user-defined type by id.
#[tauri::command]
pub fn delete_custom_type(id: String) -> Result<()> {
    let mut types = custom_types::load_custom_types();
    types.retain(|t| t.id != id);
    custom_types::save_custom_types(&types);
    Ok(())
}

/// Parse a C-like struct/union declaration into a (not-yet-saved) definition.
#[tauri::command]
pub fn parse_custom_type_text(text: String) -> Result<CustomTypeDef> {
    custom_types::parse_c_struct(&text).map_err(Error::InvalidParameter)
}

/// Resolve a user-defined type (by id) into a full `TypeLayoutData`, using the session
/// to size any referenced PDB types. The UI resolves customs through the
/// `get_session_type` name-shadowing path; this id-keyed variant serves the e2e tests
/// (deterministic even when names collide).
#[tauri::command]
pub fn resolve_custom_type(
    session_id: String,
    id: String,
    session_states: State<'_, SessionStatesMap>,
    oob_pool: State<'_, super::OobPool>,
) -> Result<TypeLayoutData> {
    let customs = custom_types::load_custom_types();
    let def = customs
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| Error::InvalidParameter(format!("No custom type with id {}", id)))?
        .clone();
    Ok(resolve_custom_def(&def, &customs, &session_id, &session_states, &oob_pool))
}

// -------------------------------------------------------------------------
// Custom-type resolution helpers
// -------------------------------------------------------------------------

/// Build the `ResolvedNamed` for a reference to another custom type.
fn custom_ref(name: &str, size: u32) -> ResolvedNamed {
    ResolvedNamed {
        type_ref: TypeRefData {
            name: name.to_string(),
            size,
            class: crate::commands::types::TypeClassData::Udt { index: 0 },
        },
        module_base: None,
    }
}

/// Look up a non-primitive type name: custom types first (size from the precomputed
/// map), then a PDB type via the live OOB client. PDB layouts are static for a
/// loaded module set, so results — including misses, which cost a full all-module
/// search — are memoized in `pdb_cache` across the resolution passes.
fn lookup_named(
    name: &str,
    client: &mut DebugSession,
    pid: u32,
    custom_names: &HashSet<String>,
    sizes: &HashMap<String, u32>,
    pdb_cache: &mut HashMap<String, Option<ResolvedNamed>>,
) -> Option<ResolvedNamed> {
    if custom_names.contains(name) {
        return Some(custom_ref(name, sizes.get(name).copied().unwrap_or(0)));
    }
    if let Some(cached) = pdb_cache.get(name) {
        return cached.clone();
    }
    let resolved = match client.get_type(pid, None, name) {
        Ok(Some(layout)) => Some(ResolvedNamed {
            type_ref: TypeRefData {
                name: layout.name.clone(),
                size: layout.size,
                class: crate::commands::types::TypeClassData::Udt { index: layout.index },
            },
            module_base: Some(format!("0x{:X}", layout.module_base)),
        }),
        _ => None,
    };
    pdb_cache.insert(name.to_string(), resolved.clone());
    resolved
}

/// Resolve `def` into a layout. Uses the OOB client to size PDB references and a
/// fixpoint pass to size cross-custom references; falls back to a PDB-less resolve
/// (primitives + customs only) when no live session is available.
fn resolve_custom_def(
    def: &CustomTypeDef,
    customs: &[CustomTypeDef],
    session_id: &str,
    session_states: &SessionStatesMap,
    oob_pool: &super::OobPool,
) -> TypeLayoutData {
    let custom_names: HashSet<String> = customs.iter().map(|c| c.name.clone()).collect();

    let session_arc = match super::get_session_arc(session_id, session_states) {
        Ok(arc) => arc,
        Err(_) => return resolve_custom_offline(def, &custom_names),
    };

    let result = super::with_oob_client(&session_arc, session_id, oob_pool, |client, pid| {
        let mut pdb_cache: HashMap<String, Option<ResolvedNamed>> = HashMap::new();
        // Phase 1: fixpoint to size cross-custom references.
        let mut sizes: HashMap<String, u32> = HashMap::new();
        for _ in 0..8 {
            let mut changed = false;
            for c in customs {
                let layout = custom_types::resolve_custom_type(c, &mut |n| {
                    lookup_named(n, client, pid, &custom_names, &sizes, &mut pdb_cache)
                });
                if sizes.get(&c.name) != Some(&layout.size) {
                    sizes.insert(c.name.clone(), layout.size);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        // Phase 2: resolve the target with settled sizes.
        custom_types::resolve_custom_type(def, &mut |n| {
            lookup_named(n, client, pid, &custom_names, &sizes, &mut pdb_cache)
        })
    });

    match result {
        Ok(layout) => layout,
        Err(_) => resolve_custom_offline(def, &custom_names),
    }
}

/// Resolve using only primitives and other custom types (no PDB) — used when there
/// is no live session. Cross-custom references resolve with size 0; settling their
/// sizes needs the live fixpoint in `resolve_custom_def`.
fn resolve_custom_offline(def: &CustomTypeDef, custom_names: &HashSet<String>) -> TypeLayoutData {
    custom_types::resolve_custom_type(def, &mut |n| {
        custom_names.contains(n).then(|| custom_ref(n, 0))
    })
}
