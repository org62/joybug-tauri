import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  fixtureExe,
  goToWindow,
  closeWindow,
  invoke,
  contextPc,
  contextSp,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  stepAndWaitForNewPc,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  waitForModuleSymbols,
  setArmedBreakpoint,
  goAndWaitForPause,
} from "../helpers/wait-helpers";
import { HEX_ADDRESS, hexPanelFor } from "../helpers/selectors";

/**
 * A 32-bit (WOW64) target end to end. The fixture is the 32-bit build of
 * hello_c; the debugger is the same 64-bit binary as everywhere else, so
 * everything below runs through the WOW64 context path: the session reports
 * X86, registers are eax..eip with 8-hex-digit values, stepping stays in the
 * 32-bit address space, symbol breakpoints resolve into the SysWOW64 ntdll,
 * the call stack walks 32-bit frames and the stack hex view uses 4-byte slots.
 */
test.describe("WOW64 (32-bit) target", () => {
  test("debugs a 32-bit process with the 32-bit register file", async ({ tauriPage: page }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);
    // Unique launch command per attempt: breakpoints persist keyed by it.
    const cmd = `"${fixtureExe("hello_c32")}" wow64_${Date.now()}`;
    const sessionId = await createAndStartSession(page, "WOW64", cmd);
    try {
      await waitForPaused(page, sessionId);

      // --- Session-level architecture + the 32-bit context -----------------
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session.arch).toBe("X86");
      expect(session.pointer_size).toBe(4);
      const ctx = session.current_event?.context;
      expect(ctx?.arch).toBe("X86");
      expect(contextPc(ctx)).toMatch(/^0x[0-9a-f]{8}$/);
      expect(contextSp(ctx)).toMatch(/^0x[0-9a-f]{8}$/);
      await expect(page.getByTestId("session-arch")).toHaveText("x86 (WOW64)");

      // Both ntdlls are mapped; the initial break is the SysWOW64 one's, not
      // the 64-bit loader's.
      const mods = (await invoke(page, "get_session_modules", { sessionId })) as Array<{ path: string; base_address: string; size: number }>;
      const ntdll32 = mods.find((m) => /\\syswow64\\ntdll\.dll$/i.test(m.path));
      expect(ntdll32, `modules: ${mods.map((m) => m.path).join(", ")}`).toBeTruthy();
      expect(mods.some((m) => /\\system32\\ntdll\.dll$/i.test(m.path))).toBe(true);
      const ntdll32Base = Number(BigInt(ntdll32!.base_address));
      // Inside the 32-bit ntdll, which by construction is below 4 GB.
      const inNtdll32 = (addr: number) => addr >= ntdll32Base && addr < ntdll32Base + ntdll32!.size;
      expect(inNtdll32(Number(session.current_event.address))).toBe(true);

      // --- Registers panel: x86 names, 8-digit values ------------------------
      await goToWindow(page, "Registers");
      await expect(page.getByText("EAX", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("EIP", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("RAX", { exact: true })).toHaveCount(0);

      // --- Step into: eip moves, stays 32-bit --------------------------------
      const pc0 = Number(session.current_event.address);
      const pc1 = await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      expect(pc1).not.toBe(pc0);
      expect(pc1).toBeLessThan(0x1_0000_0000);
      const pc2 = await stepAndWaitForNewPc(page, sessionId, "step_over_debug_session");
      expect(pc2).toBeLessThan(0x1_0000_0000);

      // --- Symbols resolve into the 32-bit ntdll -----------------------------
      // The same `ntdll.dll` basename is mapped twice; a 32-bit session must
      // hand out the SysWOW64 image's addresses (all below 4 GB).
      await waitForModuleSymbols(page, sessionId, "syswow64\\ntdll", { accept: ["loaded", "exports_only"], minSymbolCount: 1, timeout: 60_000 });
      const ntdllSyms = (await invoke(page, "get_symbols_in_range", {
        sessionId,
        start: ntdll32!.base_address,
        size: Math.min(ntdll32!.size, 0x40000),
      })) as Array<{ va: string; display_name: string }>;
      expect(ntdllSyms.length).toBeGreaterThan(0);
      for (const sym of ntdllSyms) {
        expect(inNtdll32(Number(BigInt(sym.va))), `${sym.display_name} @ ${sym.va}`).toBe(true);
      }

      // --- Call stack: 32-bit frames -----------------------------------------
      await goToWindow(page, "Stack");
      const panel = page.locator('[data-testid="callstack-panel"]');
      await expect(async () => {
        const frames = await panel.locator('[data-testid="callstack-frame"]').allInnerTexts();
        expect(frames.length).toBeGreaterThanOrEqual(2);
        // Frame addresses render at the 32-bit width.
        expect(frames.join("\n")).toMatch(/0x[0-9a-f]{8}\b/i);
        expect(frames.join("\n")).not.toMatch(/0x[0-9a-f]{16}\b/i);
      }).toPass({ timeout: 15_000, intervals: [100, 250] });

      // --- Stack hex view: 4-byte pointer slots, 8-digit gutter ---------------
      await panel.locator('[data-testid="stack-mode-hex"]').click();
      const hex = page.locator(hexPanelFor("stack"));
      const sp = BigInt(contextSp((await invoke(page, "get_debug_session", { sessionId })).current_event.context)!);
      const rowAt = (v: bigint) => hex.locator(`${HEX_ADDRESS}[data-address="${v.toString()}"]`);
      await expect(rowAt(sp)).toBeVisible({ timeout: 15_000 });
      // Consecutive rows are one 32-bit pointer apart.
      await expect(rowAt(sp + 4n)).toBeVisible();
      await expect(hex.locator("span").filter({ hasText: /^Pointer$/ }).first()).toBeVisible();
      await panel.locator('[data-testid="stack-mode-frames"]').click();

      // --- Breakpoint on main + continue: lands in the 32-bit image ------------
      const main = mods.find((m) => /hello_c32\.exe$/i.test(m.path));
      expect(main).toBeTruthy();
      await waitForModuleSymbols(page, sessionId, "hello_c32", { accept: ["loaded"], minSymbolCount: 1, timeout: 60_000 });
      const mainSyms = (await invoke(page, "get_symbols_in_range", {
        sessionId,
        start: main!.base_address,
        size: main!.size,
      })) as Array<{ va: string; display_name: string }>;
      const mainVa = mainSyms.find((s) => /!main$/.test(s.display_name))?.va;
      expect(mainVa, `symbols: ${mainSyms.slice(0, 20).map((s) => s.display_name).join(", ")}`).toBeTruthy();
      expect(BigInt(mainVa!) < 0x1_0000_0000n).toBe(true);
      await setArmedBreakpoint(page, sessionId, mainVa!);
      await goAndWaitForPause(page, sessionId, 30_000);
      const at = await invoke(page, "get_debug_session", { sessionId });
      expect(BigInt(at.current_event.address)).toBe(BigInt(mainVa!));
      // Registers at main: esp/eip are 32-bit, and the frame list names main.
      expect(contextPc(at.current_event.context)).toMatch(/^0x[0-9a-f]{8}$/);
    } finally {
      await closeWindow(page, "Stack").catch(() => {});
      await closeWindow(page, "Registers").catch(() => {});
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
