import { Page } from "@playwright/test";
import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  invoke,
  contextSp,
} from "../helpers/session-helpers";
import { HEX_ADDRESS, HEX_OFFSET_ORIGIN, hexPanelFor } from "../helpers/selectors";
import {
  waitForPaused,
  stepAndWaitForNewPc,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

/**
 * The Stack tab toggles between the walked call stack and a pointer-style hex
 * view of the raw stack. In hex mode the view follows the stack pointer on
 * every pause and measures the gutter from it (0x0 / +0x8 / ...).
 */
const PANEL = '[data-testid="callstack-panel"]';
const HEX = hexPanelFor("stack");

/** Stack pointer of the paused session: as the footer prints it (`0x` + 16
 *  uppercase digits) and as the gutter's `data-address` (decimal). */
async function stackPointer(page: Page, sessionId: string): Promise<{ hex: string; dec: string }> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  const raw = contextSp(s?.current_event?.context);
  expect(raw).toBeTruthy();
  const v = BigInt(raw!);
  return { hex: "0x" + v.toString(16).padStart(16, "0").toUpperCase(), dec: v.toString() };
}

test.describe("Stack hex mode", () => {
  test("hex mode follows the stack pointer across steps", async ({ tauriPage: page }) => {
    test.setTimeout(60_000);

    // Pause at the initial breakpoint (a real thread context), not at the
    // process-create event where single-stepping has nothing to step.
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Stack Hex");
    try {
      await waitForPaused(page, sessionId);
      await goToWindow(page, "Stack");

      const panel = page.locator(PANEL);
      const firstFrame = panel.locator('[data-testid="callstack-frame"]').first();
      await expect(firstFrame).toBeVisible({ timeout: 15_000 });

      // --- Toggle to hex: window at RSP, gutter relative to it ---------------
      const hex = page.locator(HEX);
      const originLabel = hex.locator(HEX_OFFSET_ORIGIN);
      const spRow = (dec: string) => hex.locator(`${HEX_ADDRESS}[data-address="${dec}"]`);

      await panel.locator('[data-testid="stack-mode-hex"]').click();

      const sp1 = await stackPointer(page, sessionId);
      await expect(originLabel).toHaveText(`relative to ${sp1.hex}`, { timeout: 15_000 });
      await expect(spRow(sp1.dec)).toHaveText("0x0");
      // Pointer mode: one 8-byte unit per row.
      await expect(hex.locator("span").filter({ hasText: /^Pointer$/ }).first()).toBeVisible();

      // --- Step: the view re-follows the new RSP ----------------------------
      await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      const sp2 = await stackPointer(page, sessionId);
      await expect(originLabel).toHaveText(`relative to ${sp2.hex}`, { timeout: 15_000 });
      await expect(spRow(sp2.dec)).toHaveText("0x0");

      // --- Back to frames: refetched after the step -------------------------
      await panel.locator('[data-testid="stack-mode-frames"]').click();
      await expect(hex).toHaveCount(0);
      await expect(firstFrame).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
