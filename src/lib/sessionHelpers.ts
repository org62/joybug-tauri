import { invoke } from '@tauri-apps/api/core';
import { toastError } from '@/lib/logger';
import { RegisterContext, SymbolResolver } from '@/lib/hexUtils';
import { resolveSymbol as resolveSymbolByName, SearchSymbolsFn, ModuleRef, moduleBasename as basename } from '@/lib/symbolUtils';
import { SerializableThreadContext } from '@/components/RegisterView';
import type { SessionStatus } from '@/contexts/SessionContext';

/*
 * Session-state policy — every panel gates on exactly one of these three
 * predicates, never on the raw `session.status` string:
 *
 * | predicate                    | meaning                          | gates                                   |
 * |------------------------------|----------------------------------|-----------------------------------------|
 * | `isPaused`                   | target is paused at an event     | stepping, register edits, applying /    |
 * |   (`displayStatus==='Paused'`)|                                  | undoing patch bytes, source step-line   |
 * | `canUseMemoryOps`            | a process exists                 | every OOB op: read memory, disassemble, |
 * |   (`isProcessAvailable(...)`)| (Paused / Running / Open)        | symbol search, scans, add breakpoint /  |
 * |                              |                                  | bookmark by address, find-accesses      |
 * | `sessionId`                  | the session object exists,       | persisted config (breakpoints, patches, |
 * |                              | including Stopped                | bookmarks): visible + metadata-editable |
 *
 * Live-derived views (registers, call stack, memory, disassembly, threads,
 * modules, source, symbol results) clear on `!sessionId || !canUseMemoryOps`
 * (the canonical cleanup effect), never on `isPaused` — a running target is
 * still a process. Scan caches (strings / scanner / pointer scan) hide behind
 * an "unavailable" state instead and drop when a *new* pid appears.
 *
 * Any control whose handler invokes the backend against the process is
 * `disabled={!canUseMemoryOps}` (or `!isPaused` where the command goes through
 * `send_paused_command`). Metadata-only controls on persisted config stay
 * enabled while Stopped — the backend takes a state-only path for them.
 */

/**
 * True when a process is available for memory/enumeration ops: paused, running
 * (invasive), or a non-invasive Open session. These ops run over the OOB
 * connection and never need a pause.
 */
export function isProcessAvailable(status: SessionStatus | string | undefined | null): boolean {
  return status === 'Paused' || status === 'Running' || status === 'Open';
}

/**
 * True when the target is stopped at a debug event, so a command can be sent
 * over the session's own connection from inside the paused debug loop.
 */
export function isPausedSession(status: SessionStatus | string | undefined | null): boolean {
  return status === 'Paused';
}

/**
 * True while the target executes live and values drift between reads: running
 * (invasive), or a non-invasive Open session. Used to gate polling loops.
 */
export function isTargetLive(status: SessionStatus | string | undefined | null): boolean {
  return status === 'Running' || status === 'Open';
}

/**
 * True when the session can be stopped: a process exists, or a sandbox is still
 * provisioning — the backend supports cancelling mid-provision (it tears the
 * fresh VM back down), so a slow/stuck boot is never un-stoppable.
 */
export function canStopSession(status: SessionStatus | string | undefined | null): boolean {
  return isProcessAvailable(status) || status === 'Provisioning';
}

/**
 * Extract a human-readable error message from a Tauri invoke error.
 * Tauri serializes Rust enum errors as objects like {"VariantName": "message"},
 * which String() renders as "[object Object]".
 */
export function formatTauriError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    // Tauri serialized enum: {"VariantName": "message"}
    const values = Object.values(err as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === 'string') {
      return values[0];
    }
    if ('message' in err && typeof (err as any).message === 'string') {
      return (err as any).message;
    }
    return JSON.stringify(err);
  }
  return String(err);
}

/**
 * True for backend errors that mean "nothing to show yet" rather than a real
 * failure — e.g. no active process, or an op that needs a pause (non-invasive
 * Open sessions before an address is chosen). Views should render their neutral
 * empty state instead of an error box. Single place matching the backend's
 * `InvalidSessionState` message wording (see src-tauri `Error` variants).
 */
export function isBenignSessionError(message: string): boolean {
  // `invalid ?session ?state` matches both the Display text ("Invalid session
  // state: ...") and the serialized variant name ("InvalidSessionState").
  // `session is stopped` is `oob_pid`'s wording for a Stopped session; via a
  // direct invoke it arrives bare (formatTauriError unwraps the enum), so it
  // must be matched on its own, not only through the "Invalid session state:"
  // prefix the event path carries.
  return /no active process|must be paused|session not|session is stopped|invalid ?session ?state/i.test(message);
}

/**
 * Report a failed session command to the user. The single place the policy
 * above is enforced for command handlers: an error that only means "the process
 * went away" (a click that raced the Stopped transition) is dropped — the
 * panel's no-process state already says it — and anything else is toasted.
 * `label` names the action, e.g. "remove bookmark".
 */
export function reportSessionError(label: string, err: unknown, sessionId?: string): void {
  const message = formatTauriError(err);
  if (isBenignSessionError(message)) return;
  void toastError(`Failed to ${label}: ${message}`, sessionId);
}

export { moduleBasename, pathDirname } from '@/lib/symbolUtils';

/** One entry of the `list_processes` command's result. */
export interface ProcessInfo {
  pid: number;
  name: string;
}

/** Placeholder the new-session dialog writes when the user names nothing. */
export const DEFAULT_SESSION_NAME = 'Unnamed Session';

/**
 * The label to show for a session. Prefers the user's name, but falls back to
 * the launched executable (then the attached pid) so the app header and the
 * session bar are never blank — an unnamed session used to render as an empty
 * top-left corner.
 */
export function sessionDisplayName(session: {
  name?: string | null;
  launch_command?: string | null;
  attach_pid?: number | null;
}): string {
  const name = session.name?.trim();
  if (name && name !== DEFAULT_SESSION_NAME) return name;

  const command = session.launch_command?.trim();
  if (command) {
    // The exe is the first token, quoted when the path contains spaces
    // (see buildLaunchCommand).
    const exe = command.startsWith('"')
      ? command.slice(1, command.indexOf('"', 1))
      : command.split(/\s+/)[0];
    const stem = basename(exe).replace(/\.exe$/i, '');
    if (stem) return stem;
  }

  if (session.attach_pid != null) return `PID ${session.attach_pid}`;
  return DEFAULT_SESSION_NAME;
}



/**
 * Turn an executable path into a launch command the backend can parse as a
 * command line: a path containing spaces must be quoted. Every producer of
 * `launch_command` (file picker, drag-drop) must go through this.
 */
export function buildLaunchCommand(exePath: string): string {
  return exePath.includes(' ') ? `"${exePath}"` : exePath;
}

/** Convert a thread context snapshot to a flat register name -> value map for address expression parsing. */
export function contextToRegisters(context: SerializableThreadContext | undefined): RegisterContext {
  if (!context) return {};

  const registers: RegisterContext = {};

  if ('rax' in context) {
    registers['rax'] = context.rax;
    registers['rbx'] = context.rbx;
    registers['rcx'] = context.rcx;
    registers['rdx'] = context.rdx;
    registers['rsi'] = context.rsi;
    registers['rdi'] = context.rdi;
    registers['rbp'] = context.rbp;
    registers['rsp'] = context.rsp;
    registers['rip'] = context.rip;
    registers['r8'] = context.r8;
    registers['r9'] = context.r9;
    registers['r10'] = context.r10;
    registers['r11'] = context.r11;
    registers['r12'] = context.r12;
    registers['r13'] = context.r13;
    registers['r14'] = context.r14;
    registers['r15'] = context.r15;
    registers['eflags'] = context.eflags;
  } else if ('x0' in context) {
    registers['x0'] = context.x0;
    registers['x1'] = context.x1;
    registers['x2'] = context.x2;
    registers['x3'] = context.x3;
    registers['x4'] = context.x4;
    registers['x5'] = context.x5;
    registers['x6'] = context.x6;
    registers['x7'] = context.x7;
    registers['x8'] = context.x8;
    registers['x9'] = context.x9;
    registers['x10'] = context.x10;
    registers['x11'] = context.x11;
    registers['x12'] = context.x12;
    registers['x13'] = context.x13;
    registers['x14'] = context.x14;
    registers['x15'] = context.x15;
    registers['x16'] = context.x16;
    registers['x17'] = context.x17;
    registers['x18'] = context.x18;
    registers['x19'] = context.x19;
    registers['x20'] = context.x20;
    registers['x21'] = context.x21;
    registers['x22'] = context.x22;
    registers['x23'] = context.x23;
    registers['x24'] = context.x24;
    registers['x25'] = context.x25;
    registers['x26'] = context.x26;
    registers['x27'] = context.x27;
    registers['x28'] = context.x28;
    registers['x29'] = context.x29;
    registers['x30'] = context.x30;
    registers['sp'] = context.sp;
    registers['pc'] = context.pc;
    registers['cpsr'] = context.cpsr;
    registers['lr'] = context.x30;
    registers['fp'] = context.x29;
  }

  return registers;
}

/**
 * Invoke the toggle_breakpoint Tauri command for the given session and address. When
 * `singleShot` is true, a newly added breakpoint is one-shot (auto-removed on first hit).
 */
export async function invokeToggleBreakpoint(sessionId: string, address: string, singleShot?: boolean): Promise<void> {
  await invoke('toggle_breakpoint', { sessionId, address, singleShot: singleShot ?? false });
}

/**
 * Invoke the batched set_breakpoints Tauri command: sets a software breakpoint at each
 * address (skipping addresses that already have one), tagging every new breakpoint with
 * `group`. When `singleShot` is true the breakpoints are one-shot (auto-removed on first hit).
 */
export async function invokeSetBreakpoints(sessionId: string, addresses: string[], group?: string, singleShot?: boolean): Promise<void> {
  await invoke('set_breakpoints', { sessionId, addresses, group: group ?? null, singleShot: singleShot ?? false });
}

/**
 * Create a SymbolResolver that delegates to the session's searchSymbols
 * function via resolveSymbolByName, which understands "module!symbol" syntax
 * and prefers exact name matches over the first fuzzy hit. When `modules` is
 * provided, bare module names ("orig", "ntdll.dll") resolve to the module base
 * so `module+0x...` expressions land in the right module.
 */
export function createSymbolResolver(
  searchSymbols: SearchSymbolsFn | undefined,
  modules?: ModuleRef[],
): SymbolResolver {
  return async (name: string): Promise<bigint | null> => {
    if (!searchSymbols) return null;
    try {
      const result = await resolveSymbolByName(searchSymbols, name, modules);
      return result?.address ?? null;
    } catch (e) {
      console.error('Symbol resolution failed:', e);
      return null;
    }
  };
}
