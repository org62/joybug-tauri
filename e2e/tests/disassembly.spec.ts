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
import { ASM_PANEL, ASM_ROW, PC_ROW, ASM_LABEL_ROW, ASM_INVALID_ROW } from "../helpers/selectors";
import type { Page } from "@playwright/test";

/** DOM scan shared by the invalid-byte tests: locate the rendered `db` row and
 * check a valid (non-invalid) instruction row still renders strictly below it —
 * proving disassembly continued past the bad byte. `belowPattern` optionally
 * constrains that below-row's text. */
const readInvalidRowState = (page: Page, belowPattern?: RegExp) =>
  page.evaluate(
    ({ rowSel, invalidSel, belowSrc }) => {
      const rows = Array.from(document.querySelectorAll(rowSel)) as HTMLElement[];
      const invalidIdx = rows.findIndex((r) => r.hasAttribute("data-invalid"));
      const below = belowSrc ? new RegExp(belowSrc) : null;
      return {
        invalidCount: document.querySelectorAll(invalidSel).length,
        invalidText: invalidIdx >= 0 ? rows[invalidIdx].innerText : "",
        validBelow:
          invalidIdx >= 0 &&
          rows
            .slice(invalidIdx + 1)
            .some((r) => !r.hasAttribute("data-invalid") && (!below || below.test(r.innerText))),
      };
    },
    { rowSel: ASM_ROW, invalidSel: ASM_INVALID_ROW, belowSrc: belowPattern?.source ?? null },
  );

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

  test("symbol label rows appear and first column stays an address", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Labels");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Function disassembly anchors at the function head (offset 0), so once
      // ntdll symbols finish loading a label row must precede it.
      await expect(async () => {
        const labels = await page.locator(ASM_LABEL_ROW).allInnerTexts();
        expect(labels.some((t) => /ntdll!/i.test(t))).toBe(true);
      }).toPass({ timeout: 15_000, intervals: [100, 200] });

      // Instruction rows always lead with the raw address — never symbol+offset.
      const firstRow = (await page.locator(ASM_ROW).first().innerText()).trim();
      expect(firstRow).toMatch(/^0x[0-9A-F]+/i);
      expect(firstRow).not.toMatch(/\+0x[0-9a-f]+\s/i);

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
        compareImage: true,
      });
      await invoke(page, "request_disassembly", {
        sessionId,
        address: pc,
        count: 64,
        compareImage: true,
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
                  symbols: ["stale!Hijack"],
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

  test("an undecodable byte renders as a db row and disassembly continues below it", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Invalid Byte");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // The backend's resilient decode (a real undecodable byte becomes a
      // `db 0xXX` row and decoding resumes after it) is covered by a joybug2
      // unit test. Here we assert the user-visible outcome deterministically:
      // a replace payload carrying an invalid row sandwiched between valid rows
      // must render the invalid row distinctly (data-invalid, mnemonic "db") AND
      // still show the valid instruction BELOW it. The payload echoes the view's
      // requested anchor (the PC) so the echo guard accepts it as a replace.
      const s = await invoke(page, "get_debug_session", { sessionId });
      const pc: number = s.current_event.address;

      const forge = async () => {
        await page.evaluate(
          async ({ id, pcAddr }) => {
            const hex = (n: number) => "0x" + n.toString(16).toUpperCase();
            await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
              event: "function-disassembly-updated",
              payload: {
                session_id: id,
                address: pcAddr,
                instructions: [
                  { address: hex(pcAddr), bytes: "48 89 C8", mnemonic: "mov", op_str: "rax, rcx", is_jump: false, is_call: false, is_ret: false, jump_target: null, is_invalid: false },
                  { address: hex(pcAddr + 3), bytes: "06", mnemonic: "db", op_str: "0x06", is_jump: false, is_call: false, is_ret: false, jump_target: null, is_invalid: true },
                  { address: hex(pcAddr + 4), bytes: "90", mnemonic: "nop", op_str: "", is_jump: false, is_call: false, is_ret: false, jump_target: null, is_invalid: false },
                ],
                function_start: hex(pcAddr),
                function_end: hex(pcAddr + 5),
                function_name: null,
              },
            });
          },
          { id: sessionId, pcAddr: pc },
        );
      };

      // Re-forge each poll so a late symbol-load refresh can't leave the check
      // racing a replaced view; the invalid-row render is idempotent.
      await expect(async () => {
        await forge();
        const state = await readInvalidRowState(page, /nop/);
        expect(state.invalidCount).toBeGreaterThan(0);
        expect(state.invalidText).toContain("db");
        expect(state.validBelow).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("a real undecodable byte in target memory renders as a db row end-to-end", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Real Invalid");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Pick a real instruction boundary a few rows below the PC. Every asm-row
      // address is a decoded instruction start, so it's a genuine boundary the
      // function re-decode will land on exactly.
      const targetAddr: string | null = await page.evaluate((rowSel) => {
        const rows = Array.from(document.querySelectorAll(rowSel)) as HTMLElement[];
        const pcIdx = rows.findIndex((r) => r.dataset.highlight === "pc");
        const idx = Math.min((pcIdx >= 0 ? pcIdx : 0) + 3, rows.length - 2);
        const pick = rows[idx];
        const m = pick?.innerText.match(/0x[0-9A-Fa-f]+/);
        return m ? m[0] : null;
      }, ASM_ROW);
      expect(targetAddr).toBeTruthy();
      const addrNum = Number(BigInt(targetAddr!));

      // Overwrite that instruction's first byte with 0x06 (PUSH ES) — invalid in
      // x64 long mode. WriteProcessMemory temporarily lifts the code page's
      // protection, so this lands even in read-only ntdll code (same mechanism
      // as software breakpoints / patches). The real backend decode must now
      // emit a `db 0x06` row there and keep decoding below it.
      await invoke(page, "request_memory_write", { sessionId, address: addrNum, data: [0x06] });

      const s = await invoke(page, "get_debug_session", { sessionId });
      const pc = s.current_event.address;

      // Re-request the PC's function so the corrupted byte is re-read (FIFO after
      // the write on the same session channel). Poll the rendered rows.
      await expect(async () => {
        await invoke(page, "request_function_disassembly", {
          sessionId,
          address: pc,
          maxInstructions: 2000,
          compareImage: true,
        });
        const state = await readInvalidRowState(page);
        expect(state.invalidCount).toBeGreaterThan(0);
        expect(state.invalidText).toContain("db");
        expect(state.validBelow).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [100, 200] });

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
