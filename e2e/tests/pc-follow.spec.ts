import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, pcRegister } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  stepAndWaitForNewPc,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW, PC_ROW } from "../helpers/selectors";
import type { Page } from "@playwright/test";

/** True when the PC row is rendered and geometrically inside the scroll viewport. */
function pcInViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ panel, pcRow }) => {
      const pc = document.querySelector(pcRow);
      const vp = document
        .querySelector(panel)
        ?.querySelector("[data-radix-scroll-area-viewport]");
      if (!pc || !vp) return false;
      const p = pc.getBoundingClientRect();
      const v = vp.getBoundingClientRect();
      return p.bottom > v.top && p.top < v.bottom;
    },
    { panel: ASM_PANEL, pcRow: PC_ROW },
  );
}

/** Total loaded content height — grows when a scroll extension lands. */
function contentHeight(page: Page): Promise<number> {
  return page.evaluate(
    (panel) =>
      document
        .querySelector(panel)
        ?.querySelector("[data-radix-scroll-area-viewport]")?.scrollHeight ?? 0,
    ASM_PANEL,
  );
}

test.describe("PC follow across steps", () => {
  test("step out then step in keeps RIP visible; extensions stay user-driven", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "PC Follow");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Step out of LdrpDoDebuggerBreak: lands mid-function on a call; the
      // reload must scroll the new PC row into the viewport.
      await stepAndWaitForNewPc(page, sessionId, "step_out_debug_session");
      await expect(async () => {
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Step into the call: a fresh (small) function loads, and the context
      // prefetch pulls in adjacent code on both sides. The PC row must stay
      // visible through the prefetch prepend (the view re-centers on it), with
      // context rows loaded ABOVE it — never an isolated function-only view.
      await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      await expect(async () => {
        const state = await page.evaluate(
          ({ row, pcRow }) => {
            const first = document.querySelector(row) as HTMLElement | null;
            return {
              hasContextAbove: !!first && first.dataset.highlight !== "pc",
              hasPcRow: !!document.querySelector(pcRow),
            };
          },
          { row: ASM_ROW, pcRow: PC_ROW },
        );
        expect(state.hasPcRow).toBe(true);
        expect(state.hasContextAbove).toBe(true);
        expect(await pcInViewport(page)).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // A real user gesture still extends further: wheel up to the top of the
      // prefetched context prepends more rows, and the scroll compensation
      // keeps the viewport stable (PC may scroll off — that's user intent).
      const before = await contentHeight(page);
      await page.locator(ASM_PANEL).hover();
      await expect(async () => {
        await page.mouse.wheel(0, -2000);
        expect(await contentHeight(page)).toBeGreaterThan(before);
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
