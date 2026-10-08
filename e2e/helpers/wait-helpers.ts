import { expect, type Page } from "./test-fixtures";
import { invoke } from "./session-helpers";
import { ASM_PANEL, ASM_ROW_ONLY } from "./selectors";
import { installEventCapture, waitForCapturedEvent } from "./event-helpers";
import { INITIAL_BP_MODULE, IS_WINDOWS } from "./launch-commands";

/**
 * Wait until the backend reports the session in the given status, polling
 * with short-lived evaluate calls (survives context resets). Backend-only —
 * makes no assertion about the UI having caught up.
 */
export async function waitForStatus(
  page: Page,
  sessionId: string,
  status: string,
  timeout = 30_000,
): Promise<void> {
  await expect(async () => {
    const current = await page.evaluate(async (id: string) => {
      const s = await (window as any).__TAURI_INTERNALS__.invoke(
        "get_debug_session",
        { sessionId: id },
      );
      return s?.status;
    }, sessionId);
    expect(current).toBe(status);
  }).toPass({ timeout, intervals: [100, 250, 500] });
}

/** The session status badge, matched on its semantic attribute rather than on
 *  its styling. This used to be `.bg-yellow-600`, which quietly made a purely
 *  visual restyle of the badge fail nearly every test in the suite. */
const pausedBadge = (page: Page) => page.locator('[data-session-status="Paused"]');

/**
 * Wait until the session reaches "Paused" status by polling the backend.
 * Uses short-lived evaluate calls with retry to survive context resets.
 * Falls back to the badge check if no sessionId provided.
 */
export async function waitForPaused(
  page: Page,
  sessionId?: string,
  timeout = 30_000,
): Promise<void> {
  if (sessionId) {
    // 1. Wait for backend to report Paused
    await waitForStatus(page, sessionId, "Paused", timeout);

    // 2. Wait for UI to reflect the Paused state (React processes session-updated event)
    try {
      await expect(pausedBadge(page)).toBeVisible({ timeout: 5_000 });
    } catch {
      // UI didn't sync — the session-updated event was likely missed.
      // Force a re-mount by navigating away and back, which makes the
      // React hook re-subscribe and re-fetch the current session state.
      const sessionPath = new URL(await page.url()).pathname;
      await page.evaluate(() => {
        window.history.pushState({}, "", "/debugger");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForTimeout(100);
      await page.evaluate((p: string) => {
        window.history.pushState({}, "", p);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, sessionPath);
      await expect(pausedBadge(page)).toBeVisible({ timeout: 10_000 });
    }
  } else {
    await expect(pausedBadge(page)).toBeVisible({ timeout });
  }
}

/**
 * Wait until the session reaches "Stopped" status by polling the backend.
 * Uses short-lived evaluate calls with retry to survive context resets.
 * Falls back to text check if no sessionId provided.
 */
export async function waitForStopped(
  page: Page,
  sessionId?: string,
  timeout = 30_000,
): Promise<void> {
  if (sessionId) {
    // 1. Wait for backend to report Stopped
    await waitForStatus(page, sessionId, "Stopped", timeout);

    // 2. Wait for UI to reflect the Stopped state
    try {
      await expect(
        page.getByText("Stopped", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
    } catch {
      // UI didn't sync — force re-mount
      const sessionPath = new URL(await page.url()).pathname;
      await page.evaluate(() => {
        window.history.pushState({}, "", "/debugger");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForTimeout(100);
      await page.evaluate((p: string) => {
        window.history.pushState({}, "", p);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, sessionPath);
      await expect(
        page.getByText("Stopped", { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
    }
  } else {
    await expect(
      page.getByText("Stopped", { exact: true }),
    ).toBeVisible({ timeout });
  }
}

/**
 * Poll until disassembly instructions are rendered: at least one instruction
 * row exists and common x64 mnemonics appear in its text. `scopeSelector`
 * narrows the scan (e.g. to the assembly panel); without it the whole page
 * body is scanned. The row check matters because panel chrome can contain
 * mnemonic substrings (the Quick Emulation "Syscall" toggle contains "call").
 */
export async function waitForDisassemblyLoaded(
  page: Page,
  scopeSelector?: string,
): Promise<void> {
  await expect(async () => {
    const texts = await page
      .locator(scopeSelector ?? "body")
      .locator(ASM_ROW_ONLY)
      .allInnerTexts();
    const hasAsm = ["mov", "push", "sub", "call", "int", "lea"].some((m) =>
      texts.some((t) => t.includes(m)),
    );
    expect(hasAsm).toBe(true);
  }).toPass({ timeout: 15_000, intervals: [100, 250] });
}

/**
 * Configure debug settings to only stop on InitialBreakpoint.
 * This makes sessions reach a stable pause quickly by auto-continuing
 * all other events (DLL loads, thread creates, process create, etc.).
 *
 * `overrides` flips specific keys on top of the minimal set — e.g.
 * `{ stop_on_process_exit: true }` for a test that needs the exit break, or
 * `{ exception_rules: [...] }` for one that needs a per-code rule — without a
 * test hand-repeating the whole payload and drifting from this helper. Every
 * field the payload omits falls back to its serde default on the Rust side.
 */
export async function configureMinimalStopSettings(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  try {
    await page.evaluate(async (overrides) => {
      await (window as any).__TAURI_INTERNALS__.invoke("update_debug_settings", {
        newSettings: {
          stop_on_thread_create: false,
          stop_on_thread_exit: false,
          stop_on_dll_load: false,
          stop_on_dll_unload: false,
          stop_on_initial_breakpoint: true,
          stop_on_process_create: false,
          stop_on_process_exit: false,
          ...overrides,
        },
      });
    }, overrides);
  } catch {
    // Page or context may have been closed (e.g. test timeout)
  }
}

/**
 * Restore debug settings to their defaults.
 */
export async function restoreDefaultSettings(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      await (window as any).__TAURI_INTERNALS__.invoke("update_debug_settings", {
        newSettings: {
          stop_on_thread_create: true,
          stop_on_thread_exit: false,
          stop_on_dll_load: true,
          stop_on_dll_unload: true,
          stop_on_initial_breakpoint: true,
          stop_on_process_create: true,
          stop_on_process_exit: false,
        },
      });
    });
  } catch {
    // Page or context may have been closed (e.g. test timeout)
  }
}

/**
 * Set a software breakpoint at `address` and wait until the backend confirms it
 * is armed (`is_active`) in the debuggee before returning. `toggle_breakpoint`
 * only enqueues the arm and resolves before it completes, so a caller that
 * continues immediately can race the arm — on a cold PDB load the arm lands
 * after the process has already run past the target, so the breakpoint is never
 * hit and the run reads as a 30s "Running" timeout. Gating the continue on the
 * confirmed-armed state removes that race. Idempotent: skips the toggle if a row
 * is already armed at the address (toggling again would remove it).
 */
export async function setArmedBreakpoint(
  page: Page,
  sessionId: string,
  address: string,
): Promise<void> {
  const armedAt = async (): Promise<boolean> => {
    const s = await invoke(page, "get_debug_session", { sessionId });
    const want = BigInt(address);
    return (s?.breakpoints || []).some(
      (b: any) => BigInt(b.address) === want && b.is_active === true,
    );
  };

  if (await armedAt()) return;

  await invoke(page, "toggle_breakpoint", { sessionId, address });

  await expect(async () => {
    expect(await armedAt()).toBe(true);
  }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });
}

/**
 * Send Go/Continue command via backend IPC — more reliable than keyboard F5
 * which can miss if the page focus is wrong.
 */
export async function continueSession(
  page: Page,
  sessionId: string,
): Promise<void> {
  await page.evaluate(async (id: string) => {
    await (window as any).__TAURI_INTERNALS__.invoke("step_debug_session", {
      sessionId: id,
    });
  }, sessionId);
}

/** Current PC (current_event.address) as reported by the backend. */
export async function getPcAddress(
  page: Page,
  sessionId: string,
): Promise<number | null> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  return s?.current_event?.address ?? null;
}

/**
 * Invoke a stepping command and poll until the session pauses at a new PC.
 * Returns the new PC.
 */
export async function stepAndWaitForNewPc(
  page: Page,
  sessionId: string,
  cmd: string,
): Promise<number> {
  const before = await getPcAddress(page, sessionId);
  await invoke(page, cmd, { sessionId });
  let pc: number | null = null;
  await expect(async () => {
    const s = await invoke(page, "get_debug_session", { sessionId });
    const addr = s?.current_event?.address ?? null;
    expect(s?.status).toBe("Paused");
    expect(addr).not.toBeNull();
    expect(addr).not.toBe(before);
    pc = addr;
  }).toPass({ timeout: 15_000, intervals: [50, 100] });
  return pc!;
}

/**
 * Resume a paused target, wait for it to actually be running, then break back
 * in. `BreakInto` raises its event on an injected break thread, so on return
 * the target has a second thread and the original one is a distinct target for
 * thread switch / suspend / kill.
 */
export async function breakIntoRunningTarget(
  page: Page,
  sessionId: string,
): Promise<void> {
  await continueSession(page, sessionId);
  await waitForStatus(page, sessionId, "Running", 15_000);
  await invoke(page, "pause_debug_session", { sessionId });
  await waitForPaused(page, sessionId);
}

/**
 * Press F5 (Go/Continue) and wait for the session to pause again.
 */
export async function goAndWaitForPause(
  page: Page,
  sessionId?: string,
  timeout = 30_000,
): Promise<void> {
  if (sessionId) {
    await continueSession(page, sessionId);
  } else {
    await page.keyboard.press("F5");
  }
  await waitForPaused(page, sessionId, timeout);
}

/** One entry of `get_session_symbol_status`. */
interface ModuleSymbolStatus {
  module_path: string;
  status: string;
  symbol_count?: number;
}

interface ModuleSymbolsOptions {
  /**
   * Statuses that count as usable. `["loaded"]` (the default) for a test that
   * needs real PDB names; add `"exports_only"` when exported names are enough
   * — that is all a system DLL may ever get on a machine with no symbol server.
   */
  accept?: string[];
  /** Require at least this many symbols, for tests that then look one up. */
  minSymbolCount?: number;
  timeout?: number;
}

/** Wait until a module's symbols are usable. */
export async function waitForModuleSymbols(
  page: Page,
  sessionId: string,
  moduleSubstr: string,
  { accept = ["loaded"], minSymbolCount = 0, timeout = 60_000 }: ModuleSymbolsOptions = {},
): Promise<void> {
  const needle = moduleSubstr.toLowerCase();
  await expect(async () => {
    const statuses = (await invoke(page, "get_session_symbol_status", { sessionId })) as ModuleSymbolStatus[];
    const usable = (statuses ?? []).some(
      (s) =>
        String(s.module_path).toLowerCase().includes(needle) &&
        accept.includes(s.status) &&
        (s.symbol_count ?? 0) >= minSymbolCount,
    );
    expect(usable).toBe(true);
  }).toPass({ timeout, intervals: [250, 500] });
}

/**
 * Turn on the disassembly view's image-patch lens. It is opt-in (off by default
 * so ordinary stepping doesn't pay the per-instruction on-disk-image diff), and
 * a test asserting patched rows must enable it or the view's own re-decodes
 * clear the highlight. Idempotent.
 */
export async function enableImagePatchLens(page: Page): Promise<void> {
  await page.locator(ASM_PANEL).getByTestId("asm-more-menu").click();
  const toggle = page.getByTestId("asm-image-patches-toggle");
  if ((await toggle.getAttribute("data-state")) === "unchecked") {
    await toggle.click();
  }
  await page.keyboard.press("Escape");
}

/**
 * VA (hex string) of `module!name`, through the session's symbol search. A
 * module's symbols load in the background after launch and the search answers
 * from what is loaded, so this polls until the symbol resolves.
 */
export async function waitForSymbolVa(
  page: Page,
  sessionId: string,
  module: string,
  name: string,
): Promise<string> {
  const pattern = `${module}!${name}`;
  await installEventCapture(page, ["symbols-updated"]);
  let va: string | undefined;
  await expect(async () => {
    await invoke(page, "search_session_symbols", { sessionId, pattern, limit: 10 });
    const res = await waitForCapturedEvent(
      page,
      "symbols-updated",
      (p) => p.session_id === sessionId && p.pattern === pattern,
      5_000,
    );
    const hit = (res.symbols as { name: string; va: string }[]).find((s) => s.name === name);
    expect(hit, `${pattern} should resolve`).toBeTruthy();
    va = hit!.va;
  }).toPass({ timeout: 20_000, intervals: [100, 250] });
  return va!;
}

/**
 * Wait for the session to be paused on an event of `type`, and return the
 * event.
 */
export async function waitForPauseOn(page: Page, sessionId: string, type: string): Promise<any> {
  let event: any;
  await expect(async () => {
    const s = await invoke(page, "get_debug_session", { sessionId });
    expect(s?.status).toBe("Paused");
    expect(s?.current_event?.event_type).toBe(type);
    event = s.current_event;
  }).toPass({ timeout: 30_000, intervals: [50, 100, 250] });
  return event;
}

/**
 * Make sure the paused PC is inside a *called* function, so Step Out has a
 * caller to return to. On Windows the initial breakpoint already is: ntdll's
 * LdrpDoDebuggerBreak, reached from LdrpInitializeProcess. On Linux it is the
 * executable's entry point, which nothing called — so run to `main` first
 * (reached from libc's `__libc_start_call_main`). No-op on Windows.
 */
export async function runToNestedFunction(page: Page, sessionId: string): Promise<void> {
  if (IS_WINDOWS) return;
  const address = await waitForSymbolVa(page, sessionId, INITIAL_BP_MODULE, "main");
  await setArmedBreakpoint(page, sessionId, address);
  await continueSession(page, sessionId);
  await waitForPaused(page, sessionId);
}

/**
 * Make sure the paused PC is *inside* a function, not at its first
 * instruction. Windows: already the case (the initial breakpoint is the int3
 * inside LdrpDoDebuggerBreak). Linux: the entry point is a function head, and
 * so is the `main` breakpoint `runToNestedFunction` runs to — step once past
 * it. No-op on Windows.
 */
export async function pauseMidFunction(page: Page, sessionId: string): Promise<void> {
  if (IS_WINDOWS) return;
  await runToNestedFunction(page, sessionId);
  await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
}
