//! Decoding of `DebugEvent::Exception` into the structured `ExceptionDetail`
//! shown in the log, the toast and the session header badge.
//!
//! An `EXCEPTION_RECORD` carries more than the code and the faulting address:
//! for an access violation / in-page error `ExceptionInformation[0]` is the
//! access kind (0 read, 1 write, 8 DEP execute) and `[1]` the referenced
//! address (in-page errors add the NTSTATUS in `[2]`). The core forwards that
//! array verbatim as `parameters`; this module turns it into text, symbolizes
//! both addresses and captures the callstack through the per-pause cache so
//! the Stack panel's own request on the same pause never walks twice.

use super::callstack::cached_or_walk_call_stack;
use super::helpers::{get_modules_snapshot, symbolize_address};
use super::types::DebugSession;
use crate::settings::DebugSettings;
use crate::state::ExceptionDetail;

const EXCEPTION_ACCESS_VIOLATION: u32 = 0xC000_0005;
const EXCEPTION_IN_PAGE_ERROR: u32 = 0xC000_0006;

/// Symbolic name for a Windows exception code. This is the only table: the
/// name rides on `ExceptionDetail` so the frontend never needs its own.
fn exception_code_name(code: u32) -> Option<&'static str> {
    Some(match code {
        0x8000_0001 => "EXCEPTION_GUARD_PAGE",
        0x8000_0002 => "EXCEPTION_DATATYPE_MISALIGNMENT",
        0x8000_0003 => "EXCEPTION_BREAKPOINT",
        0x8000_0004 => "EXCEPTION_SINGLE_STEP",
        EXCEPTION_ACCESS_VIOLATION => "EXCEPTION_ACCESS_VIOLATION",
        EXCEPTION_IN_PAGE_ERROR => "EXCEPTION_IN_PAGE_ERROR",
        0xC000_001D => "EXCEPTION_ILLEGAL_INSTRUCTION",
        0xC000_0025 => "EXCEPTION_NONCONTINUABLE_EXCEPTION",
        0xC000_0026 => "EXCEPTION_INVALID_DISPOSITION",
        0xC000_008C => "EXCEPTION_ARRAY_BOUNDS_EXCEEDED",
        0xC000_008D => "EXCEPTION_FLT_DENORMAL_OPERAND",
        0xC000_008E => "EXCEPTION_FLT_DIVIDE_BY_ZERO",
        0xC000_008F => "EXCEPTION_FLT_INEXACT_RESULT",
        0xC000_0090 => "EXCEPTION_FLT_INVALID_OPERATION",
        0xC000_0091 => "EXCEPTION_FLT_OVERFLOW",
        0xC000_0092 => "EXCEPTION_FLT_STACK_CHECK",
        0xC000_0093 => "EXCEPTION_FLT_UNDERFLOW",
        0xC000_0094 => "EXCEPTION_INT_DIVIDE_BY_ZERO",
        0xC000_0095 => "EXCEPTION_INT_OVERFLOW",
        0xC000_0096 => "EXCEPTION_PRIV_INSTRUCTION",
        0xC000_00FD => "EXCEPTION_STACK_OVERFLOW",
        0xE06D_7363 => "EXCEPTION_MSVC_CPP",
        _ => return None,
    })
}

/// The user's configured action for a code on this chance — `"stop"`,
/// `"pass"` or `"handled"`. No rule for the code means `"stop"` (the default).
/// Single lookup shared by the pause decision and the continue-status decision
/// in `runner.rs`, so the two can never disagree.
pub(crate) fn exception_rule_action(settings: &DebugSettings, code: u32, first_chance: bool) -> &str {
    settings
        .exception_rules
        .iter()
        .find(|r| r.code == code)
        .map(|rule| if first_chance { rule.first_chance.as_str() } else { rule.second_chance.as_str() })
        .unwrap_or("stop")
}

/// Whether this exception should pause the UI; `"pass"` / `"handled"` auto-continue.
pub(crate) fn exception_should_stop(settings: &DebugSettings, code: u32, first_chance: bool) -> bool {
    exception_rule_action(settings, code, first_chance) == "stop"
}

/// `read` / `write` / `execute` for the access-kind parameter of an access
/// violation or in-page error.
fn access_kind(param: u64) -> &'static str {
    match param {
        0 => "read",
        1 => "write",
        8 => "execute",
        _ => "access",
    }
}

/// Build the `ExceptionDetail` for an `Exception` event: decode the record and,
/// when `capture` is set, symbolize the faulting and referenced addresses and
/// capture the callstack (through the per-pause cache). Non-exception events
/// return `None`.
///
/// `capture` is the pause decision: an exception the user's rules auto-continue
/// (C++ EH throws, guard-page traffic) can arrive thousands of times per run, so
/// it gets the decoded one-liner without the symbol resolves and the stack walk
/// that only a stopped UI can show.
pub(crate) fn describe_exception(
    session: &mut DebugSession,
    event: &joybug_core::protocol_io::DebugEvent,
    capture: bool,
) -> Option<ExceptionDetail> {
    let joybug_core::protocol_io::DebugEvent::Exception { pid, tid, code, address, first_chance, parameters } = event
    else {
        return None;
    };
    let (pid, tid, code, address, first_chance) = (*pid, *tid, *code, *address, *first_chance);
    let width = session.state.lock().unwrap().target_arch().pointer_size() * 2;
    let hex = |v: u64| format!("0x{:0w$X}", v, w = width);

    let is_memory_fault = code == EXCEPTION_ACCESS_VIOLATION || code == EXCEPTION_IN_PAGE_ERROR;
    let access = if is_memory_fault { parameters.first().map(|p| access_kind(*p).to_string()) } else { None };
    let referenced_address = if is_memory_fault { parameters.get(1).copied() } else { None };
    let nt_status = if code == EXCEPTION_IN_PAGE_ERROR { parameters.get(2).map(|p| *p as u32) } else { None };

    // Walk first: frame 0 is the faulting instruction and the walk already
    // symbolized it, so the fault address costs no extra round-trip. One module
    // snapshot serves the walk's fallback and both `symbolize_address` calls.
    let callstack = if capture { cached_or_walk_call_stack(session, pid, tid).unwrap_or_default() } else { Vec::new() };
    let (address_symbol, referenced_symbol) = if capture {
        let modules = get_modules_snapshot(session);
        let frame_0 = format!("0x{:0w$x}", address, w = width);
        let address_symbol = callstack
            .first()
            .filter(|f| f.instruction_pointer == frame_0)
            .and_then(|f| f.symbol_info.clone())
            .or_else(|| symbolize_address(session, pid, address, &modules));
        // The referenced address of an access violation is unmapped by
        // construction, so ask the module list before paying for a server
        // resolve that would come back empty.
        let referenced_symbol = referenced_address
            .filter(|a| super::helpers::find_module_for_address(&modules, *a).is_some())
            .and_then(|a| symbolize_address(session, pid, a, &modules));
        (address_symbol, referenced_symbol)
    } else {
        (None, None)
    };

    let mut detail = ExceptionDetail {
        code,
        name: exception_code_name(code).map(str::to_string),
        first_chance,
        address: hex(address),
        address_symbol,
        access,
        referenced_address: referenced_address.map(hex),
        referenced_symbol,
        nt_status,
        parameters: parameters.iter().map(|p| hex(*p)).collect(),
        callstack,
        access_clause: None,
        message: String::new(),
    };
    detail.access_clause = access_clause(&detail);
    detail.message = format_message(&detail);
    Some(detail)
}

/// The memory clause of an access violation / in-page error, e.g.
/// `write to 0xDEAD0000 (mod!sym+0x10)`. Built here and shipped on the record
/// so the log line, the toast and the frontend all read the same words.
fn access_clause(detail: &ExceptionDetail) -> Option<String> {
    let (kind, addr) = (detail.access.as_deref()?, detail.referenced_address.as_deref()?);
    let verb = match kind {
        "read" => "read of",
        "write" => "write to",
        "execute" => "execute at",
        _ => "access at",
    };
    Some(match &detail.referenced_symbol {
        Some(sym) => format!("{} {} ({})", verb, addr, sym),
        None => format!("{} {}", verb, addr),
    })
}

/// The one-line log/toast text, e.g.
/// `Exception: EXCEPTION_ACCESS_VIOLATION (0xC0000005) first-chance at crash_c!crash_here+0x2f (0x00007FF6…) — write to 0xDEAD0000`.
/// Reads the already-formatted fields off the record so no hex widths or verbs
/// are spelled a second time.
fn format_message(detail: &ExceptionDetail) -> String {
    let mut message = format!(
        "Exception: {} {}-chance at {}",
        match &detail.name {
            Some(n) => format!("{} ({})", n, format_code(detail.code)),
            None => format_code(detail.code),
        },
        if detail.first_chance { "first" } else { "second" },
        match &detail.address_symbol {
            Some(s) => format!("{} ({})", s, detail.address),
            None => detail.address.clone(),
        },
    );
    if let Some(clause) = &detail.access_clause {
        message.push_str(&format!(" — {}", clause));
    }
    if let Some(status) = detail.nt_status {
        message.push_str(&format!(", status {}", format_code(status)));
    }
    message
}

/// An exception code / NTSTATUS as `0xC0000005`. Twin of `formatExceptionCode`
/// in `src/lib/exceptionNames.ts`.
fn format_code(code: u32) -> String {
    format!("0x{:08X}", code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ExceptionRule;

    /// A record with everything decoded but the derived text, as
    /// `describe_exception` has it just before it fills the last two fields.
    fn detail(name: Option<&str>, code: u32, first_chance: bool, address: &str, address_symbol: Option<&str>) -> ExceptionDetail {
        ExceptionDetail {
            code,
            name: name.map(str::to_string),
            first_chance,
            address: address.to_string(),
            address_symbol: address_symbol.map(str::to_string),
            access: None,
            referenced_address: None,
            referenced_symbol: None,
            nt_status: None,
            parameters: Vec::new(),
            callstack: Vec::new(),
            access_clause: None,
            message: String::new(),
        }
    }

    #[test]
    fn known_codes_have_names_and_unknown_do_not() {
        assert_eq!(exception_code_name(0xC0000005), Some("EXCEPTION_ACCESS_VIOLATION"));
        assert_eq!(exception_code_name(0x12345678), None);
    }

    #[test]
    fn rules_decide_stop_per_chance() {
        let mut settings = DebugSettings::default();
        assert!(exception_should_stop(&settings, 0xC0000005, true));
        settings.exception_rules.push(ExceptionRule {
            code: 0xC0000005,
            first_chance: "pass".into(),
            second_chance: "stop".into(),
        });
        assert_eq!(exception_rule_action(&settings, 0xC0000005, true), "pass");
        assert!(!exception_should_stop(&settings, 0xC0000005, true));
        assert!(exception_should_stop(&settings, 0xC0000005, false));
        assert!(exception_should_stop(&settings, 0xC0000094, true));
    }

    #[test]
    fn message_for_write_access_violation() {
        let mut d = detail(
            Some("EXCEPTION_ACCESS_VIOLATION"),
            0xC0000005,
            true,
            "0x00007FF600001000",
            Some("crash_c!crash_here+0x2f"),
        );
        d.access = Some("write".into());
        d.referenced_address = Some("0x00000000DEAD0000".into());
        d.access_clause = access_clause(&d);
        assert_eq!(d.access_clause.as_deref(), Some("write to 0x00000000DEAD0000"));
        assert_eq!(
            format_message(&d),
            "Exception: EXCEPTION_ACCESS_VIOLATION (0xC0000005) first-chance at crash_c!crash_here+0x2f (0x00007FF600001000) — write to 0x00000000DEAD0000"
        );
    }

    #[test]
    fn message_for_unknown_code_without_symbol() {
        let d = detail(None, 0x1234_5678, false, "0x00001000", None);
        assert_eq!(format_message(&d), "Exception: 0x12345678 second-chance at 0x00001000");
    }

    #[test]
    fn access_kinds() {
        assert_eq!(access_kind(0), "read");
        assert_eq!(access_kind(1), "write");
        assert_eq!(access_kind(8), "execute");
    }
}
