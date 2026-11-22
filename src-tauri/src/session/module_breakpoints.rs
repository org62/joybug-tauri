//! Persistent selector/RVA intent and short, instance-guarded trap commits.
//! Lookups may outlive a mapping, row or symbol override. Only a current plan
//! may arm a trap, and the server rechecks the mapping under its own lock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use joybug_core::protocol::ModuleBreakpointSymbolResolution as Symbol;
use joybug_core::protocol_io::ModuleInfo;
use tauri::AppHandle;

use super::breakpoints::{apply_auto_module_breakpoints, arm_bp_of_kind, emit_breakpoints_event_from_state, module_file_fingerprint, persist_breakpoints};
use super::types::DebugSession;
use crate::commands::{Cancel, CoalescedJobs};
use crate::error::{Error, Result};
use crate::state::{BreakpointInfo, ModuleBreakpointTarget as Target, SessionStateUI, SessionStatusUI};

type State = Arc<Mutex<SessionStateUI>>;
const LOADING: &str = "Waiting for module symbols";
const AMBIGUOUS_MODULE: &str = "Ambiguous module — enter a full path";
const NO_DEBUG_LOOP: &str = "Requires an invasive debug session";

pub(crate) fn gate(state: &State) -> Arc<Mutex<()>> {
    state.lock().unwrap().breakpoint_gate.clone()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Instance {
    pub(crate) pid: u32,
    pub(crate) base: u64,
    run: u64,
    load: u64,
}

struct Mapping {
    instance: Instance,
    server: Option<(ModuleInfo, u64)>,
    symbol_revision: u64,
    manual_loads: usize,
    auto_pending: bool,
    jobs: Option<Arc<CoalescedJobs>>,
}

#[derive(Default)]
pub(crate) struct Mappings {
    by_base: HashMap<u64, Mapping>,
    run: u64,
    next_load: u64,
    windows_paths: Option<bool>,
    /// Already mapped when attaching but not yet announced by a loader event.
    pub(crate) attach_inventory: Vec<ModuleInfo>,
    /// Saved adds which may be overtaken by a resume in the paused queue.
    pending_adds: Vec<String>,
    ready_auto: Vec<Instance>,
}

impl Mappings {
    pub(crate) fn clear(&mut self) {
        self.by_base.clear();
        self.pending_adds.clear();
        self.attach_inventory.clear();
        self.ready_auto.clear();
        self.run += 1;
    }

    /// Called with the mutation gate and state lock held, before binding.
    pub(crate) fn loaded(&mut self, pid: u32, base: u64, path: Option<&str>, manual: bool, server: Option<(ModuleInfo, u64, bool)>) -> Instance {
        let server = server.map(|(module, id, windows)| {
            self.windows_paths = Some(windows);
            (module, id)
        });
        if server.is_none() {
            if let Some(windows) = path.and_then(path_platform) {
                self.windows_paths = Some(windows);
            }
        }
        self.attach_inventory.retain(|module| module.base != base);
        self.next_load += 1;
        let instance = Instance { pid, base, run: self.run, load: self.next_load };
        self.by_base.insert(base, Mapping {
            instance, server, symbol_revision: 0, manual_loads: usize::from(manual),
            auto_pending: false, jobs: None,
        });
        instance
    }

    pub(crate) fn unloaded(&mut self, base: u64) {
        self.by_base.remove(&base);
        self.attach_inventory.retain(|module| module.base != base);
        self.ready_auto.retain(|instance| instance.base != base);
    }

    fn get(&self, instance: Instance) -> Option<&Mapping> {
        self.by_base.get(&instance.base).filter(|mapping| mapping.instance == instance)
    }

    fn get_mut(&mut self, instance: Instance) -> Option<&mut Mapping> {
        self.by_base.get_mut(&instance.base).filter(|mapping| mapping.instance == instance)
    }

    fn windows(&self) -> bool {
        self.windows_paths.unwrap_or(cfg!(windows))
    }
}

pub(crate) fn is_current(state: &State, instance: Instance) -> bool {
    let state = state.lock().unwrap();
    state.breakpoint_modules.get(instance).is_some()
}

pub(crate) fn server_token(state: &State, instance: Instance) -> Option<u64> {
    let state = state.lock().unwrap();
    state.breakpoint_modules.get(instance)?.server.as_ref().map(|(_, token)| *token)
}

pub(crate) fn target_windows(state: &SessionStateUI) -> Option<bool> {
    state.breakpoint_modules.windows_paths
        .or_else(|| (state.is_local_run || state.sandbox.is_some()).then_some(cfg!(windows)))
}

fn drive_path(path: &str) -> bool {
    let b = path.as_bytes();
    b.first().is_some_and(u8::is_ascii_alphabetic) && b.get(1) == Some(&b':')
}

fn path_platform(path: &str) -> Option<bool> {
    if drive_path(path) || path.starts_with('\\') || path.starts_with("//") {
        Some(true)
    } else if path.starts_with('/') {
        Some(false)
    } else {
        None
    }
}

fn basename(path: &str, windows: bool) -> &str {
    path.rsplit(|c| c == '/' || (windows && c == '\\')).next().unwrap_or(path)
}

pub(super) fn equal_selector(left: &str, right: &str, windows: bool) -> bool {
    if windows {
        let normalize = |c: char| if c == '\\' { '/' } else { c };
        left.chars().map(normalize).flat_map(char::to_lowercase)
            .eq(right.chars().map(normalize).flat_map(char::to_lowercase))
    } else {
        left == right
    }
}

fn matches_module(selector: &str, path: &str, windows: bool) -> bool {
    let filename = basename(selector, windows);
    if filename.len() == selector.len() {
        equal_selector(selector, basename(path, windows), windows)
    } else {
        equal_selector(selector, path, windows)
    }
}

fn parse_rva(hex: &str) -> Option<u64> {
    let digits = hex.strip_prefix("0x").or_else(|| hex.strip_prefix("0X")).unwrap_or(hex);
    if digits.is_empty() || !digits.bytes().all(|digit| digit.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(digits, 16).ok()
}

pub(crate) fn validate_request(module: &str, target: Target, target_os: Option<bool>) -> Result<(String, Target)> {
    let module = module.trim();
    let windows = target_os.or_else(|| path_platform(module)).unwrap_or(false);
    let filename = basename(module, windows);
    let drive = windows && drive_path(module);
    let absolute = module.starts_with('/') || (windows && module.starts_with('\\'))
        || (drive && module.as_bytes().get(2).is_some_and(|c| *c == b'/' || *c == b'\\'));
    if matches!(filename, "" | "." | "..") || module.contains('\0') || (drive && !absolute) {
        return Err(Error::InvalidParameter("Enter a module filename or full target path".into()));
    }
    if filename.len() != module.len() && !absolute {
        return Err(Error::InvalidParameter("Enter a full target path or just the module filename".into()));
    }
    let target = match target {
        Target::Symbol { name } => {
            let name = name.trim();
            if name.is_empty() {
                return Err(Error::InvalidParameter("Enter an exact symbol name".into()));
            }
            Target::Symbol { name: name.into() }
        }
        Target::Rva { hex } => {
            let rva = parse_rva(hex.trim()).ok_or_else(|| Error::InvalidParameter("Enter a hexadecimal RVA (0–0xffffffffffffffff)".into()))?;
            Target::Rva { hex: format!("0x{rva:x}") }
        }
    };
    Ok((module.into(), target))
}

/// The caller holds the gate through persistence/publication.
fn insert(state: &mut SessionStateUI, module: &str, target: &Target) -> Option<String> {
    let windows = target_windows(state).or_else(|| path_platform(module)).unwrap_or(false);
    if state.breakpoints.iter().any(|bp| bp.module_target.as_ref() == Some(target)
        && equal_selector(&bp.module_name, module, windows))
    {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    state.breakpoints.push(BreakpointInfo {
        id: id.clone(),
        address: 0,
        module_name: module.into(),
        module_offset: 0,
        name: None,
        group: None,
        symbol: None,
        enabled: true,
        is_active: false,
        bp_kind: "software".into(),
        hw_type: None,
        hw_size: None,
        source_file: None,
        source_line: None,
        auto: false,
        single_shot: false,
        module_fingerprint: None,
        module_target: Some(target.clone()),
        binding_error: state.non_invasive.then(|| NO_DEBUG_LOOP.into()),
        trap_mapping: None,
    });
    Some(id)
}

pub(crate) fn add_saved(state: &State, handle: &AppHandle, module: &str, target: &Target) -> bool {
    let gate = gate(state);
    let _guard = gate.lock().unwrap();
    {
        let mut state = state.lock().unwrap();
        let Some(id) = insert(&mut state, module, target) else { return false };
        if matches!(state.status, SessionStatusUI::Running | SessionStatusUI::Paused) {
            state.breakpoint_modules.pending_adds.push(id);
        }
    }
    persist_breakpoints(state);
    emit_breakpoints_event_from_state(state, handle);
    true
}

pub(crate) fn reconcile_saved(client: &mut DebugSession, handle: &Option<AppHandle>, pid: u32, module: &str, target: &Target) {
    let id = {
        let mut state = client.state.lock().unwrap();
        let Some(row) = state.breakpoints.iter().find(|row| row.module_name == module && row.module_target.as_ref() == Some(target)) else { return };
        let Some(index) = state.breakpoint_modules.pending_adds.iter().position(|id| *id == row.id) else { return };
        state.breakpoint_modules.pending_adds.remove(index)
    };
    reconcile_enabled(client, handle, pid, &[id], false);
}

/// Resume discards remaining commands in the paused batch. Claim any saved
/// adds it overtook so that an already loaded image is still considered.
pub(crate) fn reconcile_adds_before_resume(client: &mut DebugSession, handle: &Option<AppHandle>, pid: u32) {
    let ids = std::mem::take(&mut client.state.lock().unwrap().breakpoint_modules.pending_adds);
    if !ids.is_empty() {
        reconcile_enabled(client, handle, pid, &ids, false);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Selection {
    Absent,
    Unique(u64),
    Ambiguous,
}

fn select<'a>(modules: impl IntoIterator<Item = &'a ModuleInfo>, selector: &str, windows: bool) -> Selection {
    let mut matching = modules.into_iter().filter(|m| matches_module(selector, &m.name, windows));
    match (matching.next(), matching.next()) {
        (None, _) => Selection::Absent,
        (Some(module), None) => Selection::Unique(module.base),
        (Some(_), Some(_)) => Selection::Ambiguous,
    }
}

fn select_row(state: &SessionStateUI, bp: &BreakpointInfo) -> Selection {
    if let Some((base, _)) = bp.trap_mapping {
        // Disabled rows retain their resolved instance until that image unloads.
        if state.breakpoint_modules.by_base.contains_key(&base) {
            return Selection::Unique(base);
        }
    }
    select(state.modules.iter().chain(&state.breakpoint_modules.attach_inventory), &bp.module_name, state.breakpoint_modules.windows())
}

fn set_reason(bp: &mut BreakpointInfo, reason: Option<&str>) -> bool {
    if bp.binding_error.as_deref() == reason {
        return false;
    }
    bp.binding_error = reason.map(str::to_owned);
    true
}

/// As a mapping departs, clear diagnostics that belonged to it. When an
/// ambiguous selector now has one candidate, try that candidate immediately.
pub(crate) fn unloaded_diagnostics(state: &mut SessionStateUI, path: &str) -> (bool, Option<(Instance, Vec<String>)>) {
    let windows = state.breakpoint_modules.windows();
    let mut changed = false;
    let mut unambiguous: Option<(Instance, Vec<String>)> = None;
    for bp in &mut state.breakpoints {
        if bp.module_target.is_none() || !bp.enabled || bp.address != 0
            || !matches_module(&bp.module_name, path, windows)
        {
            continue;
        }
        match select(state.modules.iter().chain(&state.breakpoint_modules.attach_inventory), &bp.module_name, windows) {
            Selection::Ambiguous => {}
            Selection::Absent => changed |= set_reason(bp, None),
            Selection::Unique(base) if bp.binding_error.as_deref() == Some(AMBIGUOUS_MODULE) => {
                changed |= set_reason(bp, None);
                if let Some(mapping) = state.breakpoint_modules.by_base.get(&base) {
                    // Any newly unique selector must share the departing image's
                    // filename, so all such rows point at at most one survivor.
                    unambiguous.get_or_insert_with(|| (mapping.instance, Vec::new())).1.push(bp.id.clone());
                }
            }
            Selection::Unique(_) => {}
        }
    }
    (changed, unambiguous)
}

/// Reconcile newly saved/explicitly enabled rows against the live image list.
/// Ambiguous selectors have no chosen instance. Already active rows stay put.
pub(crate) fn reconcile_enabled(client: &mut DebugSession, handle: &Option<AppHandle>, pid: u32, ids: &[String], accept_file: bool) {
    let gate = gate(&client.state);
    let bases = {
        let _guard = gate.lock().unwrap();
        let mut state = client.state.lock().unwrap();
        let mut by_base: HashMap<u64, (Instance, Vec<String>)> = HashMap::new();
        let mut changed = false;
        for id in ids {
            let Some(i) = state.breakpoints.iter().position(|bp| &bp.id == id && bp.module_target.is_some()
                && bp.enabled && !bp.is_active) else { continue };
            let selection = select_row(&state, &state.breakpoints[i]);
            let reason = if state.non_invasive {
                Some(NO_DEBUG_LOOP)
            } else {
                match selection {
                    Selection::Unique(base) => {
                        if let Some(mapping) = state.breakpoint_modules.by_base.get(&base).filter(|m| m.instance.pid == pid) {
                            by_base.entry(mapping.instance.base).or_insert_with(|| (mapping.instance, Vec::new())).1.push(id.clone());
                        }
                        continue;
                    }
                    Selection::Absent => None,
                    Selection::Ambiguous => Some(AMBIGUOUS_MODULE),
                }
            };
            changed |= set_reason(&mut state.breakpoints[i], reason);
        }
        drop(state);
        if changed {
            if let Some(handle) = handle {
                emit_breakpoints_event_from_state(&client.state, handle);
            }
        }
        by_base
    };
    for (_, (instance, ids)) in bases {
        let pass = reconcile(client, handle.as_ref(), instance, Options { ids: Some(&ids), accept_file, ..Options::default() });
        if pass.loading {
            schedule(&client.state, handle.as_ref(), instance, true);
        }
    }
}

#[derive(Default)]
struct Options<'a> {
    ids: Option<&'a [String]>,
    accept_file: bool,
    module_event: bool,
    wait: bool,
    loading_only: bool,
    cancel: Option<&'a Cancel>,
}

#[derive(Default)]
pub(crate) struct Pass {
    pub(crate) changed: bool,
    pub(crate) unresolved_enabled_name: Option<String>,
    pub(crate) loading: bool,
}

#[derive(Clone, Copy)]
enum Candidate {
    Ambiguous,
    Rva(Option<u64>),
    Name(usize),
}

struct PlannedRow {
    id: String,
    candidate: Candidate,
}

struct Lookup {
    rows: Vec<PlannedRow>,
    names: Vec<String>,
    symbol_revision: u64,
    manual_pending: bool,
    path: String,
    server: Option<(ModuleInfo, u64)>,
}

fn plan(state: &SessionStateUI, instance: Instance, options: &Options<'_>) -> Option<Lookup> {
    let mapping = state.breakpoint_modules.get(instance)?;
    if !matches!(state.status, SessionStatusUI::Running | SessionStatusUI::Paused) {
        return None;
    }
    let module = state.modules.iter().find(|module| module.base == instance.base)?;
    let windows = state.breakpoint_modules.windows();
    let mut rows = Vec::new();
    let mut names = Vec::new();
    let mut indices = HashMap::new();
    for bp in &state.breakpoints {
        let Some(target) = &bp.module_target else { continue };
        if !bp.enabled || bp.is_active
            || options.ids.is_some_and(|ids| !ids.contains(&bp.id))
            || (options.wait && !matches!(target, Target::Symbol { .. }))
            || (options.loading_only && bp.binding_error.as_deref() != Some(LOADING))
            || !matches_module(&bp.module_name, &module.name, windows)
        {
            continue;
        }
        let selection = select_row(state, bp);
        if matches!(selection, Selection::Unique(base) if base != instance.base) {
            continue;
        }
        let candidate = if selection == Selection::Ambiguous {
            Candidate::Ambiguous
        } else {
            match target {
                Target::Rva { hex } => Candidate::Rva(parse_rva(hex)),
                Target::Symbol { name } => Candidate::Name(*indices.entry(name).or_insert_with(|| {
                    let index = names.len();
                    names.push(name.clone());
                    index
                })),
            }
        };
        rows.push(PlannedRow { id: bp.id.clone(), candidate });
    }
    (!rows.is_empty()).then(|| Lookup {
        rows, names, symbol_revision: mapping.symbol_revision,
        manual_pending: mapping.manual_loads != 0,
        path: module.name.clone(),
        server: mapping.server.clone(),
    })
}

fn address_for(module: &ModuleInfo, rva: u64) -> std::result::Result<u64, &'static str> {
    if module.size.is_some_and(|size| rva >= size) {
        return Err("RVA is outside the mapped module");
    }
    module.base.checked_add(rva).filter(|address| *address != 0).ok_or("RVA is outside the mapped module")
}

fn eligible_row<'a>(state: &'a SessionStateUI, instance: Instance, revision: u64, row: &PlannedRow) -> Option<&'a BreakpointInfo> {
    let mapping = state.breakpoint_modules.get(instance)?;
    if !matches!(state.status, SessionStatusUI::Running | SessionStatusUI::Paused)
        || (matches!(row.candidate, Candidate::Name(_)) && mapping.symbol_revision != revision)
    {
        return None;
    }
    let bp = state.breakpoints.iter().find(|bp| bp.id == row.id && bp.enabled && !bp.is_active)?;
    match select_row(state, bp) {
        Selection::Unique(base) if base == instance.base && !matches!(row.candidate, Candidate::Ambiguous) => Some(bp),
        Selection::Ambiguous if matches!(row.candidate, Candidate::Ambiguous) => Some(bp),
        _ => None,
    }
}

fn reconcile(client: &mut DebugSession, handle: Option<&AppHandle>, instance: Instance, options: Options<'_>) -> Pass {
    let Some(lookup) = plan(&client.state.lock().unwrap(), instance, &options) else { return Pass::default() };
    let pid = instance.pid;
    let base = instance.base;
    let answers = if lookup.names.is_empty() || lookup.manual_pending || lookup.server.is_none() {
        Ok(Vec::new())
    } else {
        client.resolve_module_breakpoint_symbols(pid, base, lookup.names, options.wait)
    };
    let fingerprint = if lookup.rows.iter().any(|row| matches!(row.candidate, Candidate::Rva(_))) {
        module_file_fingerprint(&lookup.path)
    } else {
        None
    };

    let gate = gate(&client.state);
    let _guard = gate.lock().unwrap();
    let mut pass = Pass::default();
    let mut durable_changed = false;
    for row in lookup.rows {
        if options.cancel.is_some_and(Cancel::is_cancelled) {
            break;
        }
        let (was_stale, expected_name) = {
            let state = client.state.lock().unwrap();
            let Some(bp) = eligible_row(&state, instance, lookup.symbol_revision, &row) else { continue };
            let stale = matches!(row.candidate, Candidate::Rva(_)) && !options.accept_file
                && matches!((&bp.module_fingerprint, &fingerprint), (Some(old), Some(now)) if old != now);
            let name = if options.module_event && matches!(bp.module_target, Some(Target::Symbol { .. })) {
                Some(format!("{}!{}", bp.module_name, bp.module_target.as_ref().unwrap()))
            } else {
                None
            };
            (stale, name)
        };
        let result = (|| -> std::result::Result<_, String> {
            if matches!(row.candidate, Candidate::Ambiguous) {
                return Err(AMBIGUOUS_MODULE.into());
            }
            if was_stale {
                return Err("Module file changed — enable again to accept the new image".into());
            }
            let (module, token) = lookup.server.as_ref().ok_or("Could not identify the live module mapping")?;
            let rva = match row.candidate {
                Candidate::Rva(Some(rva)) => rva,
                Candidate::Rva(None) => return Err("Invalid saved RVA".into()),
                Candidate::Name(_) if lookup.manual_pending => return Err(LOADING.into()),
                Candidate::Name(index) => match &answers {
                    Ok(answers) => match answers.get(index) {
                        Some(Symbol::Found { rva }) => u64::from(*rva),
                        Some(Symbol::Loading) => {
                            pass.loading = true;
                            return Err(LOADING.into());
                        }
                        Some(Symbol::Missing) => return Err("Exact symbol not found — load matching debug symbols or add a different target".into()),
                        Some(Symbol::Ambiguous) => return Err("Multiple addresses match this exact symbol — use an RVA".into()),
                        None => return Err("No result for the requested symbol".into()),
                    },
                    Err(error) => return Err(format!("Symbol lookup failed: {error}")),
                },
                Candidate::Ambiguous => unreachable!(),
            };
            let address = address_for(module, rva)?;
            if client.state.lock().unwrap().breakpoints.iter().any(|bp| bp.id != row.id && bp.address == address) {
                return Err("Address already has a breakpoint".into());
            }
            arm_bp_of_kind(client, pid, address, "software", None, None, false, Some((base, *token)))?;
            Ok((address, rva, *token))
        })();
        let mut state = client.state.lock().unwrap();
        let Some(bp) = state.breakpoints.iter_mut().find(|bp| bp.id == row.id) else { continue };
        match result {
            Ok((address, rva, token)) => {
                bp.address = address;
                bp.module_offset = rva;
                bp.is_active = true;
                bp.trap_mapping = Some((base, token));
                bp.binding_error = None;
                pass.changed = true;
                if matches!(row.candidate, Candidate::Rva(_)) && fingerprint.is_some() && bp.module_fingerprint != fingerprint {
                    bp.module_fingerprint = fingerprint.clone();
                    durable_changed = true;
                }
            }
            Err(reason) => {
                pass.changed |= set_reason(bp, Some(&reason));
                if was_stale {
                    bp.enabled = false;
                    bp.module_fingerprint = fingerprint.clone();
                    durable_changed = true;
                }
                if let Some(name) = expected_name {
                    pass.unresolved_enabled_name.get_or_insert_with(|| format!("Paused for module breakpoint {name}: {reason}"));
                }
            }
        }
    }
    if durable_changed {
        persist_breakpoints(&client.state);
    }
    if pass.changed && !options.module_event {
        if let Some(handle) = handle {
            emit_breakpoints_event_from_state(&client.state, handle);
        }
    }
    pass
}

pub(crate) fn on_load(client: &mut DebugSession, handle: Option<&AppHandle>, instance: Instance) -> Pass {
    reconcile(client, handle, instance, Options { module_event: true, ..Options::default() })
}

pub(crate) fn on_unique_after_unload(client: &mut DebugSession, handle: Option<&AppHandle>, instance: Instance, ids: &[String]) -> Pass {
    let mut pass = reconcile(client, handle, instance, Options { ids: Some(ids), module_event: true, ..Options::default() });
    pass.unresolved_enabled_name = None; // An unload never forces a pause.
    pass
}

/// Async names win over settings-driven entry/TLS traps at the same address.
pub(crate) fn defer_auto(state: &State, instance: Instance) {
    if let Some(mapping) = state.lock().unwrap().breakpoint_modules.get_mut(instance) {
        mapping.auto_pending = true;
    }
}

impl Mappings {
    pub(super) fn auto_is_deferred(&self, base: u64) -> bool {
        self.by_base.get(&base).is_some_and(|mapping| mapping.auto_pending)
            || self.ready_auto.iter().any(|instance| instance.base == base)
    }
}

fn finish_auto(client: &mut DebugSession, handle: &Option<AppHandle>, instance: Instance, cancel: &Cancel) {
    let gate = gate(&client.state);
    let _guard = gate.lock().unwrap();
    if cancel.is_cancelled() {
        return;
    }
    let ready = {
        let mut state = client.state.lock().unwrap();
        let paused = matches!(state.status, SessionStatusUI::Paused);
        let Some(mapping) = state.breakpoint_modules.get_mut(instance) else { return };
        if mapping.manual_loads != 0 || !std::mem::take(&mut mapping.auto_pending) {
            return;
        }
        if !paused {
            // The loader event no longer holds the target. Don't use an
            // unguarded auto one-shot until a real pause holds this mapping.
            state.breakpoint_modules.ready_auto.push(instance);
        }
        paused
    };
    if let Some(app) = handle {
        if ready && apply_auto_module_breakpoints(client, handle, instance.pid, instance.base) {
            emit_breakpoints_event_from_state(&client.state, app);
        }
    }
}

/// Called with the mutation gate held just before publishing a real pause.
pub(crate) fn apply_ready_auto(client: &mut DebugSession, handle: &Option<AppHandle>, pid: u32) {
    let ready = std::mem::take(&mut client.state.lock().unwrap().breakpoint_modules.ready_auto);
    for instance in ready {
        if instance.pid == pid && is_current(&client.state, instance) {
            apply_auto_module_breakpoints(client, handle, pid, instance.base);
        }
    }
}

/// One waiting client per mapping. Never reconnect it for a later process.
pub(crate) fn schedule(state: &State, handle: Option<&AppHandle>, instance: Instance, loading_only: bool) {
    let jobs = {
        let mut state = state.lock().unwrap();
        let options = Options { wait: true, loading_only, ..Options::default() };
        if plan(&state, instance, &options).is_none()
            && !state.breakpoint_modules.get(instance).is_some_and(|mapping| mapping.auto_pending)
        {
            return;
        }
        let Some(mapping) = state.breakpoint_modules.get_mut(instance) else { return };
        mapping.jobs.get_or_insert_with(Default::default).clone()
    };
    let state = state.clone();
    let handle = handle.cloned();
    jobs.request("symbols", move |cancel| {
        let options = Options { wait: true, loading_only, cancel: Some(cancel), ..Options::default() };
        if cancel.is_cancelled() || !is_current(&state, instance) {
            return;
        }
        let (mut client, pid) = match crate::commands::create_oob_client(&state) {
            Ok(connection) => connection,
            Err(error) => {
                let gate = gate(&state);
                let _guard = gate.lock().unwrap();
                let mut current = state.lock().unwrap();
                if cancel.is_cancelled() {
                    return;
                }
                let Some(lookup) = plan(&current, instance, &options) else { return };
                let reason = format!("Symbol lookup connection failed: {error}");
                let mut changed = false;
                for row in lookup.rows {
                    if !matches!(row.candidate, Candidate::Name(_)) { continue; }
                    if let Some(bp) = current.breakpoints.iter_mut().find(|bp| bp.id == row.id) {
                        changed |= set_reason(bp, Some(&reason));
                    }
                }
                drop(current);
                if changed {
                    if let Some(handle) = &handle {
                        emit_breakpoints_event_from_state(&state, handle);
                    }
                }
                return;
            }
        };
        if pid != instance.pid {
            return;
        }
        let mut loading_only = loading_only;
        loop {
            let pass = reconcile(&mut client, handle.as_ref(), instance, Options { loading_only, ..options });
            if !pass.loading || cancel.is_cancelled() {
                finish_auto(&mut client, &handle, instance, cancel);
                return;
            }
            loading_only = true;
        }
    });
}

/// Mark an override before the RPC starts, not after its background thread gets
/// scheduled. A lookup based on the old table cannot commit across either edge.
pub(crate) fn begin_manual_symbols(state: &State, base: u64, pid: u32) -> Option<Instance> {
    let gate = gate(state);
    let _guard = gate.lock().unwrap();
    let mut state = state.lock().unwrap();
    let mapping = state.breakpoint_modules.by_base.get_mut(&base)?;
    if mapping.instance.pid != pid {
        return None;
    }
    mapping.symbol_revision += 1;
    mapping.manual_loads += 1;
    Some(mapping.instance)
}

pub(crate) fn finish_manual_symbols(state: &State, handle: Option<&AppHandle>, instance: Instance) {
    let complete = {
        let gate = gate(state);
        let _guard = gate.lock().unwrap();
        let mut state = state.lock().unwrap();
        let Some(mapping) = state.breakpoint_modules.get_mut(instance) else { return };
        mapping.symbol_revision += 1;
        mapping.manual_loads -= 1;
        mapping.manual_loads == 0
    };
    if complete {
        schedule(state, handle, instance, false);
    }
}

pub(crate) fn retry_symbols(state: &State, handle: &AppHandle, base: u64) {
    let instance = state.lock().unwrap().breakpoint_modules.by_base.get(&base).map(|m| m.instance);
    if let Some(instance) = instance {
        schedule(state, Some(handle), instance, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SessionInit;

    fn rva(hex: &str) -> Target {
        Target::Rva { hex: hex.into() }
    }

    fn named(name: &str) -> Target {
        Target::Symbol { name: name.into() }
    }

    fn module(name: &str, base: u64) -> ModuleInfo {
        ModuleInfo { name: name.into(), base, size: Some(0x1000) }
    }

    fn session() -> SessionStateUI {
        SessionStateUI::new(SessionInit {
            id: "deferred-breakpoint-test".into(), name: String::new(), server_url: String::new(),
            launch_command: String::new(), working_directory: None, environment: None,
            is_local_run: true, attach_pid: None, non_invasive: false, jit_event_handle: None,
            sandbox: None, etw: None,
        })
    }

    #[test]
    fn rejects_bad_hex_and_module_syntax_without_losing_wide_valid_rvas() {
        for hex in ["", "0x", "0x0x1", "+0", "-1", "0x10000000000000000", "12 34", "1_000"] {
            assert!(validate_request("fixture.dll", rva(hex), Some(true)).is_err(), "{hex}");
        }
        for path in [" ", "/", r"C:\test\", "./fixture.dll", "C:", "C:fixture.dll", "/path/to/.."] {
            assert!(validate_request(path, rva("0"), Some(true)).is_err(), "{path}");
        }
        assert!(validate_request(r"name\part.so", rva("0"), Some(false)).is_ok());
        assert!(validate_request("fixture.dll", named(" "), Some(true)).is_err());
        assert_eq!(validate_request(" fixture.dll ", rva(" 0X0000 "), Some(true)).unwrap(), ("fixture.dll".into(), rva("0x0")));
        assert_eq!(validate_request("fixture.dll", rva("FFFFFFFFFFFFFFFF"), Some(true)).unwrap().1, rva("0xffffffffffffffff"));
        assert_eq!(validate_request("fixture.dll", named(" A::B(int)+0x2* "), Some(true)).unwrap().1, named("A::B(int)+0x2*"));
    }

    #[test]
    fn rva_at_image_end_or_wrapping_address_is_not_a_candidate() {
        let first = module("/tmp/example.so", 0x1000);
        assert_eq!(address_for(&first, 0xfff), Ok(0x1fff));
        assert!(address_for(&first, 0x1000).is_err());
        assert!(address_for(&module("/tmp/example.so", u64::MAX - 4), 5).is_err());
    }

    #[test]
    fn equivalent_selector_is_idempotent_without_reenabling_the_saved_row() {
        let mut state = session();
        state.breakpoint_modules.windows_paths = Some(true);
        let original = insert(&mut state, r"C:\Path\Library.dll", &named("Exact")).unwrap();
        state.breakpoints[0].enabled = false;
        assert!(insert(&mut state, "c:/path/library.DLL", &named("Exact")).is_none());
        assert_eq!(state.breakpoints[0].id, original);
        assert!(!state.breakpoints[0].enabled);
        assert!(insert(&mut state, "c:/path/library.DLL", &named("exact")).is_some());
        assert!(insert(&mut state, "c:/path/library.DLL", &rva("0x0")).is_some());
    }

    #[test]
    fn basename_ambiguity_requires_a_complete_target_path() {
        let windows = [module(r"C:\A\library.dll", 0x1000), module(r"C:\B\Library.dll", 0x2000)];
        assert_eq!(select(&windows, "LIBRARY.dll", true), Selection::Ambiguous);
        assert_eq!(select(&windows, "c:/b/library.DLL", true), Selection::Unique(0x2000));
        assert_eq!(select(&windows, "rary.dll", true), Selection::Absent);
        let linux = [module("/a/library.so", 0x1000), module("/b/Library.so", 0x2000)];
        assert_eq!(select(&linux, "Library.so", false), Selection::Unique(0x2000));
        assert_eq!(select(&linux, "/A/library.so", false), Selection::Absent);
    }

    #[test]
    fn waiting_result_cannot_commit_after_delete_override_or_same_base_remap() {
        let mut state = session();
        let path = "/tmp/library.so";
        state.status = SessionStatusUI::Running;
        state.modules.push(module(path, 0x1000));
        let first = state.breakpoint_modules.loaded(42, 0x1000, Some(path), false, None);
        let id = insert(&mut state, path, &named("Exact")).unwrap();
        let lookup = plan(&state, first, &Options::default()).unwrap();
        let [row] = lookup.rows.as_slice() else { panic!("expected one candidate") };
        assert!(eligible_row(&state, first, lookup.symbol_revision, row).is_some());
        state.breakpoint_modules.get_mut(first).unwrap().symbol_revision += 1;
        assert!(eligible_row(&state, first, lookup.symbol_revision, row).is_none());

        let lookup = plan(&state, first, &Options::default()).unwrap();
        let row = &lookup.rows[0];
        state.breakpoints.retain(|bp| bp.id != id);
        insert(&mut state, path, &named("Exact")).unwrap();
        assert!(eligible_row(&state, first, lookup.symbol_revision, row).is_none());

        let lookup = plan(&state, first, &Options::default()).unwrap();
        let row = &lookup.rows[0];
        state.breakpoint_modules.unloaded(first.base);
        let remapped = state.breakpoint_modules.loaded(first.pid, first.base, Some(path), false, None);
        assert_ne!(first, remapped);
        assert!(eligible_row(&state, first, lookup.symbol_revision, row).is_none());
        assert!(eligible_row(&state, remapped, 0, row).is_some());
    }

    #[test]
    fn legacy_row_without_target_retains_its_rva_and_fingerprint() {
        let row: BreakpointInfo = serde_json::from_str(r#"{
            "id":"saved", "address":0, "module_name":"old.dll", "module_offset":4096,
            "enabled":true, "is_active":false, "module_fingerprint":"2000:10000"
        }"#).unwrap();
        assert!(row.module_target.is_none());
        assert_eq!(row.module_offset, 4096);
        assert_eq!(row.module_fingerprint.as_deref(), Some("2000:10000"));
        assert_eq!(row.bp_kind, "software");
    }
}
