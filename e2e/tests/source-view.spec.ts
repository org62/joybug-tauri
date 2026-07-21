import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, fixtureExe, invoke, goToWindow, moduleBase } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
  setArmedBreakpoint,
} from "../helpers/wait-helpers";
import { installEventCapture, waitForCapturedEvent } from "../helpers/event-helpers";
import type { Page } from "@playwright/test";

/**
 * Invoke a fire-and-forget backend command and resolve with the payload of the
 * first matching Tauri event it emits (bucket capture from event-helpers).
 */
async function invokeAndCaptureEvent<T = any>(
  page: Page,
  opts: { event: string; command: string; args: Record<string, unknown>; matchKey?: string; matchValue?: string; timeout?: number },
): Promise<T> {
  await installEventCapture(page, [opts.event]);
  await invoke(page, opts.command, opts.args);
  return waitForCapturedEvent(page, opts.event, (p) => {
    if (!opts.matchKey || !opts.matchValue) return true;
    return String(p?.[opts.matchKey] ?? "").toLowerCase().includes(opts.matchValue.toLowerCase());
  }, opts.timeout ?? 8000);
}

/** Poll get_session_symbol_status until the named module reports "loaded". */
async function waitForModuleSymbols(page: Page, sessionId: string, moduleSubstr: string): Promise<void> {
  await expect(async () => {
    const loaded = await page.evaluate(async ({ id, sub }) => {
      const statuses = await (window as any).__TAURI_INTERNALS__.invoke("get_session_symbol_status", { sessionId: id });
      return (statuses || []).some(
        (s: any) => s.module_path.toLowerCase().includes(sub) && s.status === "loaded" && (s.symbol_count ?? 0) > 0,
      );
    }, { id: sessionId, sub: moduleSubstr });
    expect(loaded).toBe(true);
  }).toPass({ timeout: 20_000, intervals: [200, 500] });
}

/** Activate a dock tab by its header title, opening it if the layout lacks it. */
async function activateTab(page: Page, title: string): Promise<void> {
  const tab = page.locator(".dock-tab", { hasText: title }).first();
  if (await tab.count() === 0) {
    await goToWindow(page, title);
    return;
  }
  await tab.click();
}

test.describe("Source View", () => {
  test("shows C source and resolves a source-line breakpoint", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    // Unique launch command per test: breakpoints persist keyed by launch_command,
    // so distinct commands keep tests from inheriting each other's breakpoints.
    const sessionId = await createAndStartSession(page, "Source C", `${fixtureExe("hello_c")} srcbp`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint (ntdll)
      await waitForModuleSymbols(page, sessionId, "hello_c");

      const base = await moduleBase(page, sessionId, "hello_c");
      expect(base).toBeTruthy();

      // Discover the exact compile-time path of hello_c.c from the PDB.
      const filesPayload = await invokeAndCaptureEvent<{ files: { path: string }[] }>(page, {
        event: "source-files-listed",
        command: "list_source_files",
        args: { sessionId, moduleBase: base },
      });
      const cFile = filesPayload.files.find((f) => f.path.toLowerCase().endsWith("hello_c.c"));
      expect(cFile).toBeTruthy();

      // Get its line map and set a breakpoint at the lowest-address line
      // (compute()'s prologue — reached via main → hello_c_marker → compute).
      const mapPayload = await invokeAndCaptureEvent<{ entries: { address: string; line: number }[] }>(page, {
        event: "source-file-line-map",
        command: "get_source_file_line_map",
        args: { sessionId, moduleBase: base, filePath: cFile!.path },
        matchKey: "file_path",
        matchValue: "hello_c.c",
      });
      expect(mapPayload.entries.length).toBeGreaterThan(0);
      const target = mapPayload.entries.reduce((a, b) => (BigInt(a.address) <= BigInt(b.address) ? a : b));

      // Arm and confirm before running so a cold-PDB arm can't land after the
      // process has already sped past the target line.
      await setArmedBreakpoint(page, sessionId, target.address);

      // Run to the source-line breakpoint.
      await continueSession(page, sessionId);
      await waitForPaused(page, sessionId);

      // The breakpoint should carry resolved source metadata.
      await expect(async () => {
        const bp = await page.evaluate(async (id: string) => {
          const s = await (window as any).__TAURI_INTERNALS__.invoke("get_debug_session", { sessionId: id });
          return (s?.breakpoints || [])[0] ?? null;
        }, sessionId);
        expect(bp?.source_file?.toLowerCase()).toContain("hello_c.c");
        expect(typeof bp?.source_line).toBe("number");
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      // Open the Source tab — it follows the PC and shows the .c text.
      await activateTab(page, "Source");
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        // Distinctive strings from compute()/hello_c.c.
        expect(text).toContain("acc += i * 2");
      }).toPass({ timeout: 15_000, intervals: [100, 250] });

      // Syntax highlighting: C keywords/comments should render as token spans.
      await expect(async () => {
        const tokens = await page.evaluate(
          () => document.querySelectorAll(".tok-keyword, .tok-comment").length,
        );
        expect(tokens).toBeGreaterThan(0);
      }).toPass({ timeout: 5_000, intervals: [100, 250] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("source-line stepping advances the PC to a new line", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Source Step", `${fixtureExe("hello_c")} srcstep`);
    try {
      await waitForPaused(page, sessionId);
      await waitForModuleSymbols(page, sessionId, "hello_c");
      const base = await moduleBase(page, sessionId, "hello_c");

      const files = await invokeAndCaptureEvent<{ files: { path: string }[] }>(page, {
        event: "source-files-listed",
        command: "list_source_files",
        args: { sessionId, moduleBase: base },
      });
      const cFile = files.files.find((f) => f.path.toLowerCase().endsWith("hello_c.c"))!;
      const map = await invokeAndCaptureEvent<{ entries: { address: string; line: number }[] }>(page, {
        event: "source-file-line-map",
        command: "get_source_file_line_map",
        args: { sessionId, moduleBase: base, filePath: cFile.path },
        matchKey: "file_path",
        matchValue: "hello_c.c",
      });
      const target = map.entries.reduce((a, b) => (BigInt(a.address) <= BigInt(b.address) ? a : b));
      await setArmedBreakpoint(page, sessionId, target.address);
      await continueSession(page, sessionId);
      await waitForPaused(page, sessionId);

      // Resolve the current source line, step over one source line, and confirm
      // the line changed (a source-line step covers >1 instruction here).
      const lineBefore = await page.evaluate(async (id: string) => {
        const s = await (window as any).__TAURI_INTERNALS__.invoke("get_debug_session", { sessionId: id });
        return s?.current_event?.address as number;
      }, sessionId);

      await page.evaluate(async (id: string) => {
        await (window as any).__TAURI_INTERNALS__.invoke("step_over_line_debug_session", { sessionId: id });
      }, sessionId);
      await waitForPaused(page, sessionId);

      const lineAfter = await page.evaluate(async (id: string) => {
        const s = await (window as any).__TAURI_INTERNALS__.invoke("get_debug_session", { sessionId: id });
        return s?.current_event?.address as number;
      }, sessionId);

      expect(lineAfter).not.toBe(lineBefore);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("shows MASM assembly source after stepping", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Source ASM", `${fixtureExe("hello_asm")} srcasm`);
    try {
      await waitForPaused(page, sessionId);
      await waitForModuleSymbols(page, sessionId, "hello_asm");
      const base = await moduleBase(page, sessionId, "hello_asm");

      const files = await invokeAndCaptureEvent<{ files: { path: string }[] }>(page, {
        event: "source-files-listed",
        command: "list_source_files",
        args: { sessionId, moduleBase: base },
      });
      const asmFile = files.files.find((f) => f.path.toLowerCase().endsWith("hello_asm.asm"));
      expect(asmFile).toBeTruthy();

      const map = await invokeAndCaptureEvent<{ entries: { address: string; line: number }[] }>(page, {
        event: "source-file-line-map",
        command: "get_source_file_line_map",
        args: { sessionId, moduleBase: base, filePath: asmFile!.path },
        matchKey: "file_path",
        matchValue: "hello_asm.asm",
      });
      expect(map.entries.length).toBeGreaterThan(0);
      const target = map.entries.reduce((a, b) => (BigInt(a.address) <= BigInt(b.address) ? a : b));
      await setArmedBreakpoint(page, sessionId, target.address);
      await continueSession(page, sessionId);
      await waitForPaused(page, sessionId);

      await activateTab(page, "Source");
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        // Distinctive strings from hello_asm.asm.
        expect(text).toContain("asm_loop");
      }).toPass({ timeout: 15_000, intervals: [100, 250] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
