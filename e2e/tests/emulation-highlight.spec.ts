import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW, PC_ROW } from "../helpers/selectors";

const EXECUTED_ROW = `${ASM_ROW}[data-highlight="executed"]`;

test.describe("Emulation executed-line highlight", () => {
  test("highlights executed rows when quick emulation is expanded", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Emu Highlight");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Footer starts collapsed (fixture sets it) — no rows are highlighted
      await expect(page.locator(EXECUTED_ROW)).toHaveCount(0);

      // Expand the Quick Emulation footer through the real UI
      await page.locator(ASM_PANEL).getByText("Quick Emulation").click();

      // The emulator runs from the current PC; executed rows get highlighted
      await expect(page.locator(EXECUTED_ROW).first()).toBeVisible({
        timeout: 30_000,
      });

      // The PC row keeps its PC highlight — the executed wash must never win
      // over it. (The trace may or may not include the PC address itself: at
      // an initial breakpoint the emulator starts from the thread's RIP,
      // which is already past the int3.)
      await expect(page.locator(PC_ROW)).toHaveCount(1);

      // Collapsing the footer clears the highlights immediately
      await page.locator(ASM_PANEL).getByText("Quick Emulation").click();
      await expect(page.locator(EXECUTED_ROW)).toHaveCount(0);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
