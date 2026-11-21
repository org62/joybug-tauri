import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  debuggeeArch,
  pcRegister,
  rowAddress,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
  pauseMidFunction,
  getPcAddress,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  getCapturedEvents,
} from "../helpers/event-helpers";
import { ASM_PANEL, ASM_ROW, PC_ROW, SELECTED_ROW, ASM_LABEL_ROW, ASM_INVALID_ROW } from "../helpers/selectors";
import { INITIAL_BP_MODULE } from "../helpers/launch-commands";
import type { Locator, Page } from "../helpers/test-fixtures";

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
      // At InitialBreakpoint (ntdll / the entry point), we expect instructions like mov, push, sub, call, etc.
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

  test("shows function name containing the initial breakpoint's module in disassembly header", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Ntdll");
      await waitForPaused(page, sessionId);

      // At InitialBreakpoint, RIP is in ntdll (Windows) or the executable's
      // entry point (Linux) — the disassembly header should name that module.
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).toContain(INITIAL_BP_MODULE);
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
      // the module's symbols finish loading a label row must precede it.
      const moduleLabel = new RegExp(`${INITIAL_BP_MODULE}!`, "i");
      await expect(async () => {
        const labels = await page.locator(ASM_LABEL_ROW).allInnerTexts();
        expect(labels.some((t) => moduleLabel.test(t))).toBe(true);
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
      // The assertion below needs the PC away from the function head.
      await pauseMidFunction(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Capture raw event deliveries so the test knows when both the replace
      // and the orphaned chunk response have definitely reached the webview.
      await installEventCapture(page, [
        "disassembly-updated",
        "function-disassembly-updated",
      ]);

      const pc = await getPcAddress(page, sessionId);
      if (pc === null) throw new Error("Expected a paused PC");
      const pcVa = rowAddress(pc);
      const pcRow = page.locator(`${PC_ROW}[data-address="${pcVa}"]`);
      await expect(pcRow).toBeVisible();

      // Get a full replacement through the view so its pending request is real.
      // Identify the predecessor in the replacement itself: the orphaned
      // forward chunk starts at the PC and cannot contain that instruction.
      await page.locator(`${ASM_PANEL} button[title="Refresh"]`).click();
      let predecessor = "";
      await expect(async () => {
        const events = await getCapturedEvents(page, "function-disassembly-updated");
        const listing = events.find((e) => e.session_id === sessionId && e.address === pc);
        const pcIndex = listing?.instructions.findIndex((i: { address: string }) => i.address === pcVa) ?? -1;
        expect(pcIndex).toBeGreaterThan(0);
        predecessor = listing.instructions[pcIndex - 1].address;
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      const predecessorRow = page.locator(`${ASM_ROW}[data-address="${predecessor}"]`);
      await expect(predecessorRow).toBeVisible();

      // An untagged orphan with a unique sentinel cannot be mistaken for the
      // automatic forward seed at the same address.
      await invoke(page, "plugin:event|emit", {
        event: "disassembly-updated",
        payload: { session_id: sessionId, address: pc, instructions: [
          { address: pcVa, bytes: "90", mnemonic: "stalechunk", op_str: "", is_jump: false, is_call: false, is_ret: false, jump_target: null },
        ] },
      });

      await expect(async () => {
        const events = await getCapturedEvents(page, "disassembly-updated");
        expect(events.some((e) =>
          e.session_id === sessionId && e.address === pc && !e.request_id &&
          e.instructions[0]?.address === pcVa && e.instructions[0]?.mnemonic === "stalechunk",
        )).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Neither the PC nor its predecessor should have been displaced.
      await expect(pcRow).toBeVisible();
      await expect(predecessorRow).toBeVisible();
      await expect(page.getByText("stalechunk")).toHaveCount(0);

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

      const pc = await getPcAddress(page, sessionId);
      if (pc === null) throw new Error("Expected a paused PC");
      const pcRow = page.locator(`${PC_ROW}[data-address="${rowAddress(pc)}"]`);
      await expect(pcRow).toBeVisible();

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
              request_id: 0,
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
        expect(events.some((e) =>
          e.session_id === sessionId && e.address === staleAddress &&
          e.instructions[0]?.mnemonic === "stalehijack",
        )).toBe(true);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

      // ...and the view must be untouched.
      await expect(pcRow).toBeVisible();
      await expect(page.getByText("stalehijack")).toHaveCount(0);

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

      const arch = await debuggeeArch(page, sessionId);

      // Corrupt the picked instruction with an undecodable pattern. On x64
      // (variable-length) a single 0x06 (PUSH ES, invalid in long mode) suffices
      // and capstone resyncs on the next byte. On ARM64 (fixed 4-byte words) one
      // byte usually just yields another valid instruction, so overwrite the
      // whole aligned word with 0x00000000 — an unallocated encoding capstone
      // refuses. WriteProcessMemory temporarily lifts the code page's protection,
      // so this lands even in read-only ntdll code (same mechanism as software
      // breakpoints / patches). The real backend decode must now emit a `db` row
      // there and keep decoding valid code below it.
      const invalidBytes = arch === "Arm64" ? [0x00, 0x00, 0x00, 0x00] : [0x06];
      await invoke(page, "request_memory_write", { sessionId, address: addrNum, data: invalidBytes });

      // Refresh through the view after the write (FIFO on the pause channel).
      await page.locator(`${ASM_PANEL} button[title="Refresh"]`).click();
      await expect(async () => {
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

  test("memory-reference operand links open the Memory view at the address", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm MemRef");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      test.skip(await debuggeeArch(page, sessionId) !== "X64", "Static RIP-relative operands require x64");
      const pc = (await getPcAddress(page, sessionId))!;
      // mov rax, [rip - 7] references the instruction's own readable address.
      // Decode at the literal PC in case a function bound crosses the edit.
      await invoke(page, "request_memory_write", {
        sessionId, address: pc, data: [0x48, 0x8b, 0x05, 0xf9, 0xff, 0xff, 0xff],
      });
      const input = page.locator(`${ASM_PANEL} input`).first();
      const pcVa = rowAddress(pc);
      await input.fill(pcVa);
      await input.press("Enter");
      const memLink = page.locator(`${SELECTED_ROW}[data-address="${pcVa}"] span[title="Open memory at ${pcVa}"]`);
      await expect(memLink).toBeVisible({ timeout: 10_000 });
      await memLink.click();

      // Memory tab activates and its hex gutter lands on the referenced
      // address (gutter rows are 16-byte aligned, 0x + 16 uppercase digits).
      const gutterAddr =
        "0x" + (BigInt(pc) & ~0xfn).toString(16).toUpperCase().padStart(16, "0");
      await expect(async () => {
        const state = await page.evaluate(() => ({
          activeTabs: Array.from(document.querySelectorAll(".dock-tab-active")).map(
            (t) => (t as HTMLElement).innerText,
          ),
          body: document.body.innerText,
        }));
        expect(state.activeTabs.some((t) => /Memory/i.test(t))).toBe(true);
        expect(state.body).toContain(gutterAddr);
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });

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

      // Disassembly should be cleared — the function name should be gone
      const moduleBang = new RegExp(`${INITIAL_BP_MODULE}.*!`);
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).not.toMatch(moduleBang);
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

  test("goto box evaluates expressions with operator precedence", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm ExprMath");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const pc = await pcRegister(page, sessionId);
      const input = page.locator(`${ASM_PANEL} input`).first();
      const goto = async (expression: string) => {
        await input.fill(expression);
        await input.press("Enter");
      };

      // Identify rows by data-address, and read it off the row the navigation
      // *landed on* (the view selects its jump target) rather than the topmost
      // row. "First row" is a scroll artifact, not row identity: a load's
      // context prefetch prepends rows above the target and the view re-centres
      // on it, so returning to an address leaves a different row on top than
      // the first load did. Text is no good either — the address column swaps
      // to symbol+offset once symbol loading catches up.
      const rowAddress = async (locator: Locator) => {
        await expect(locator).toHaveCount(1, { timeout: 10_000 });
        const address = await locator.getAttribute("data-address");
        expect(address, "row carries a data-address").toBeTruthy();
        return address as string;
      };
      const landedRow = page.locator(SELECTED_ROW);
      /** Poll until the goto has landed on `address`. */
      const expectLandedAt = (address: string) =>
        expect(landedRow).toHaveAttribute("data-address", address, { timeout: 10_000 });

      // Establish the baseline through the goto box too, rather than off the
      // PC-highlighted row: the highlight tracks the debug event's address,
      // which need not be the row the `pc` register expression resolves to.
      await goto(pc);
      const atPc = await rowAddress(landedRow);

      // `*` binds tighter than `+`, so this must land exactly 0x2000 past the
      // PC — a plain +/- tokenizer used to hand "2*0x1000" to the symbol
      // resolver and fail with "Symbol not found".
      await goto(`${pc}+2*0x1000`);
      await expect(landedRow).not.toHaveAttribute("data-address", atPc, { timeout: 10_000 });
      const scaled = await rowAddress(landedRow);

      // Return to the PC, then prove the arithmetic: the same address written
      // without multiplication lands on the identical row.
      await goto(pc);
      await expectLandedAt(atPc);
      await goto(`${pc}+0x2000`);
      await expectLandedAt(scaled);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

});
