import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  getCapturedEvents,
} from "../helpers/event-helpers";
import { ASM_PANEL, ASM_ROW, PC_ROW } from "../helpers/selectors";

test.describe("Disassembly View", () => {
  test("shows real x86 mnemonics when paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Mnemonics");
      await waitForPaused(page, sessionId);

      // Wait for disassembly to load — look for common x86-64 mnemonics
      // At InitialBreakpoint in ntdll, we expect instructions like mov, push, sub, call, etc.
      const mnemonics = ["mov", "push", "sub", "call", "int", "lea", "xor", "nop", "ret", "jmp", "cmp", "test"];

      // Wait until at least one mnemonic appears in the disassembly
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        const found = mnemonics.some((m) => text.includes(m));
        expect(found).toBe(true);
      }).toPass({ timeout: 15_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("shows function name containing ntdll in disassembly header", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Ntdll");
      await waitForPaused(page, sessionId);

      // At InitialBreakpoint, RIP is in ntdll — disassembly header should mention ntdll
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).toContain("ntdll");
      }).toPass({ timeout: 15_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("stale forward-disassembly response does not hijack the view", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Stale");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Capture raw event deliveries so the test knows when both the replace
      // and the orphaned chunk response have definitely reached the webview.
      await installEventCapture(page, [
        "disassembly-updated",
        "function-disassembly-updated",
      ]);

      // The race's damaging order, reproduced deterministically: a full-replace
      // request followed by a forward chunk request anchored at RIP (the shape
      // loadMoreBelow sends) whose pending marker the replace has already
      // cleared. The session channel is FIFO (sequential awaited invokes), so
      // the orphaned chunk response arrives LAST — it used to be misread as a
      // full replace and hijack the fresh view, putting the RIP row at the
      // very top.
      const s = await invoke(page, "get_debug_session", { sessionId });
      const pc = s.current_event.address;
      await invoke(page, "request_function_disassembly", {
        sessionId,
        address: pc,
        maxInstructions: 2000,
      });
      await invoke(page, "request_disassembly", {
        sessionId,
        address: pc,
        count: 64,
      });

      // Wait until both responses have been delivered...
      await expect(async () => {
        expect(
          (await getCapturedEvents(page, "function-disassembly-updated")).length,
        ).toBeGreaterThan(0);
        expect(
          (await getCapturedEvents(page, "disassembly-updated")).length,
        ).toBeGreaterThan(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // ...and the view must still be the function view (first row = function
      // head), NOT the stale 64-row chunk anchored at RIP. The PC row itself
      // must still exist further down.
      await expect(async () => {
        const state = await page.evaluate(
          ({ row, pcRow }) => {
            const first = document.querySelector(row) as HTMLElement | null;
            return {
              firstIsPc: first ? first.dataset.highlight === "pc" : null,
              hasPcRow: !!document.querySelector(pcRow),
            };
          },
          { row: ASM_ROW, pcRow: PC_ROW },
        );
        expect(state.firstIsPc).toBe(false);
        expect(state.hasPcRow).toBe(true);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("stale function-disassembly response does not hijack the view", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Fn Stale");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const firstRowBefore = await page.locator(ASM_ROW).first().innerText();

      // Forge a late replace response for an address the view never requested —
      // the shape the slow OOB fallback produces when its request raced a
      // resume (e.g. an auto-continued thread-create event's PC at startup).
      // The echo guard must discard it instead of replacing the view.
      await installEventCapture(page, ["function-disassembly-updated"]);
      const staleAddress = 0x1000;
      await page.evaluate(
        async ({ id, address }) => {
          await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
            event: "function-disassembly-updated",
            payload: {
              session_id: id,
              address,
              instructions: [
                {
                  address: "0x1000",
                  symbol: "stale!Hijack+0x0",
                  bytes: "90",
                  mnemonic: "stalehijack",
                  op_str: "",
                  is_jump: false,
                  is_call: false,
                  is_ret: false,
                  jump_target: null,
                },
              ],
              function_start: "0x1000",
              function_end: "0x2000",
              function_name: "stale!Hijack",
            },
          });
        },
        { id: sessionId, address: staleAddress },
      );

      // Wait until the forged event has demonstrably reached the webview...
      await expect(async () => {
        const events = await getCapturedEvents(page, "function-disassembly-updated");
        expect(events.some((e: any) => e.address === staleAddress)).toBe(true);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

      // ...and the view must be untouched.
      expect(await page.locator(ASM_ROW).first().innerText()).toBe(firstRowBefore);
      await expect(page.getByText("stalehijack")).toHaveCount(0);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("disassembly clears when session resumes and stops", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Clear");
      await waitForPaused(page, sessionId);

      // Verify disassembly is showing instructions
      await waitForDisassemblyLoaded(page);

      // Continue — process exits, session stops
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Disassembly should be cleared — ntdll function name should be gone
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).not.toMatch(/ntdll.*!/);
      }).toPass({ timeout: 5_000 });

      // Regression: the refresh button must not be stuck spinning after stop
      // (the PC-follow effect used to re-request disassembly against the dead
      // session and the backend swallowed it without an event, so isLoading
      // never cleared).
      const refreshButtons = page.getByRole("button", { name: "Refresh" });
      await expect(refreshButtons.first()).toBeVisible({ timeout: 5_000 });
      await expect(refreshButtons.locator(".animate-spin")).toHaveCount(0, { timeout: 5_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
