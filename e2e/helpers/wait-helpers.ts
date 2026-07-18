import { Page, expect } from "@playwright/test";
import { invoke } from "./session-helpers";

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

/**
 * Wait until the session reaches "Paused" status by polling the backend.
 * Uses short-lived evaluate calls with retry to survive context resets.
 * Falls back to CSS badge check if no sessionId provided.
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
      await expect(page.locator(".bg-yellow-600")).toBeVisible({ timeout: 5_000 });
    } catch {
      // UI didn't sync — the session-updated event was likely missed.
      // Force a re-mount by navigating away and back, which makes the
      // React hook re-subscribe and re-fetch the current session state.
      const sessionPath = new URL(page.url()).pathname;
      await page.evaluate(() => {
        window.history.pushState({}, "", "/debugger");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForTimeout(100);
      await page.evaluate((p: string) => {
        window.history.pushState({}, "", p);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, sessionPath);
      await expect(page.locator(".bg-yellow-600")).toBeVisible({ timeout: 10_000 });
    }
  } else {
    await expect(page.locator(".bg-yellow-600")).toBeVisible({ timeout });
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
      const sessionPath = new URL(page.url()).pathname;
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
 * Poll until disassembly instructions are rendered (common x64 mnemonics
 * appear). `scopeSelector` narrows the scan (e.g. to the assembly panel);
 * without it the whole page body is scanned.
 */
export async function waitForDisassemblyLoaded(
  page: Page,
  scopeSelector?: string,
): Promise<void> {
  await expect(async () => {
    const text = scopeSelector
      ? await page.locator(scopeSelector).innerText()
      : await page.evaluate(() => document.body.innerText);
    const hasAsm = ["mov", "push", "sub", "call", "int", "lea"].some((m) =>
      text.includes(m),
    );
    expect(hasAsm).toBe(true);
  }).toPass({ timeout: 15_000, intervals: [100, 250] });
}

/**
 * Configure debug settings to only stop on InitialBreakpoint.
 * This makes sessions reach a stable pause quickly by auto-continuing
 * all other events (DLL loads, thread creates, process create, etc.).
 */
export async function configureMinimalStopSettings(
  page: Page,
): Promise<void> {
  try {
    await page.evaluate(async () => {
      await (window as any).__TAURI_INTERNALS__.invoke("update_debug_settings", {
        newSettings: {
          stop_on_thread_create: false,
          stop_on_thread_exit: false,
          stop_on_dll_load: false,
          stop_on_dll_unload: false,
          stop_on_initial_breakpoint: true,
          stop_on_process_create: false,
        },
      });
    });
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
        },
      });
    });
  } catch {
    // Page or context may have been closed (e.g. test timeout)
  }
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
