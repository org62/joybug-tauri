import { invoke } from '@tauri-apps/api/core';
import { RegisterContext, SymbolResolver } from '@/lib/hexUtils';
import { resolveSymbol as resolveSymbolByName, SearchSymbolsFn, ModuleRef } from '@/lib/symbolUtils';
import { SerializableThreadContext } from '@/components/RegisterView';
import type { SessionStatus } from '@/contexts/SessionContext';

/**
 * True when a process is available for memory/enumeration ops: paused, running
 * (invasive), or a non-invasive Open session. These ops run over the OOB
 * connection and never need a pause.
 */
export function isProcessAvailable(status: SessionStatus | string | undefined | null): boolean {
  return status === 'Paused' || status === 'Running' || status === 'Open';
}

/**
 * True while the target executes live and values drift between reads: running
 * (invasive), or a non-invasive Open session. Used to gate polling loops.
 */
export function isTargetLive(status: SessionStatus | string | undefined | null): boolean {
  return status === 'Running' || status === 'Open';
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
  return /no active process|must be paused|session not|invalid ?session ?state/i.test(message);
}

export { moduleBasename } from '@/lib/symbolUtils';

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
