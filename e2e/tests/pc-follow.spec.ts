import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, pcRegister, goToWindow, fixtureExe } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  stepAndWaitForNewPc,
  runToNestedFunction,
  waitForSymbolVa,
  getPcAddress,
} from "../helpers/wait-helpers";
import { ASM_PANEL } from "../helpers/selectors";
import { IS_WINDOWS } from "../helpers/launch-commands";
import { assemblyViewport, expectAssemblyContext, expectAssemblyWheel, refreshUnderPointer } from "../helpers/assembly-viewport";
import type { Page } from "../helpers/test-fixtures";

async function pcInViewport(page: Page): Promise<boolean> {
  return (await assemblyViewport(page))?.rows.some((row) => row.highlight === "pc") ?? false;
}

test.describe("PC follow across steps", () => {
  test("first pause opens with instructions visible on both sides of the PC", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "First PC Context", `"${fixtureExe("echo_c")}"`);
    try {
      await waitForPaused(page, sessionId);
      const pc = await getPcAddress(page, sessionId);
      expect(pc).not.toBeNull();
      await expectAssemblyContext(page, BigInt(pc!), { highlight: "pc" });
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

  test("short function goto and Refresh keep context; wheel works from Refresh", async ({ tauriPage: page }) => {
    test.skip(!IS_WINDOWS, "Requires the MASM overlap fixture");
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Short Function Context", `"${fixtureExe("overlap_asm")}"`);
    try {
      await waitForPaused(page, sessionId);
      const address = BigInt(await waitForSymbolVa(page, sessionId, "overlap_asm", "overlap_fn"));
      const input = page.locator(`${ASM_PANEL} input`).first();
      await input.fill("overlap_asm!overlap_fn");
      await input.press("Enter");
      const context = { highlight: "selected", after: address + 0xCn } as const; // past ret
      await expectAssemblyContext(page, address, context);
      await refreshUnderPointer(page);
      await expectAssemblyContext(page, address, context);
      await expectAssemblyWheel(page, 1);
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

  test("step out then step in keeps RIP visible; extensions stay user-driven", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "PC Follow");
      await waitForPaused(page, sessionId);
      await runToNestedFunction(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Step out of LdrpDoDebuggerBreak (main on Linux): lands mid-function on
      // a call; the reload must scroll the new PC row into the viewport.
      await stepAndWaitForNewPc(page, sessionId, "step_out_debug_session");
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Step into the call: a fresh (small) function loads, and the context
      // prefetch pulls in adjacent code on both sides. The PC row must stay
      // visible through the prefetch prepend (the view re-centers on it), with
      // context rows loaded ABOVE it — never an isolated function-only view.
      const pc = await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      await expectAssemblyContext(page, BigInt(pc), { highlight: "pc" });

      // Keep the native wheel-over-listing path covered separately from the
      // forwarded toolbar input. Move to the actual instruction viewport.
      const view = (await assemblyViewport(page))!;
      await page.mouse.move(view.x, view.y);
      await expectAssemblyWheel(page, -1);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("PC move while the Disassembly tab is hidden re-centers once shown", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Hidden Tab PC");
      await waitForPaused(page, sessionId);
      await runToNestedFunction(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Hide Disassembly: Memory shares its dock panel, so activating it puts
      // the assembly view into rc-dock's cached zero-height state.
      await goToWindow(page, "Memory");

      // Step while hidden — the PC-follow scroll would previously run against
      // the 0-height viewport and be silently lost.
      await stepAndWaitForNewPc(page, sessionId, "step_out_debug_session");

      // Reveal the tab again: the visibility observer must re-center the RIP row.
      await goToWindow(page, "Disassembly");
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("go-to-PC button returns to RIP after navigating away", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Go To PC");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Navigate away (different function) — the PC row leaves the view.
      const gotoInput = page.locator(`${ASM_PANEL} input`).first();
      await gotoInput.fill(`${await pcRegister(page, sessionId)}+0x2000`);
      await gotoInput.press("Enter");
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(false);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // The go-to-PC button reloads/re-centers the PC row.
      await page.locator(`${ASM_PANEL} button[title^="Go to PC"]`).click();
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
