import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

test.describe("Registers View", () => {
  test("shows real register names and hex values when paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Registers Test");
      await waitForPaused(page, sessionId);

      // At InitialBreakpoint, we should see x64 register names and hex values
      // The registers panel should show rip, rax, rsp, etc.
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        // Check for key x64 register names
        expect(text).toContain("rip");
        expect(text).toContain("rax");
        expect(text).toContain("rsp");
      }).toPass({ timeout: 15_000 });

      // Check for hex values (0x...)
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        expect(text).toMatch(/0x[0-9a-fA-F]{8,16}/);
      }).toPass({ timeout: 5_000 });

      // XMM registers are hidden by default; toggling the XMM button reveals them.
      const xmmToggle = page.getByRole("button", { name: "XMM", exact: true });
      await expect(xmmToggle).toBeVisible();
      await xmmToggle.click();
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).toContain("xmm0");
      }).toPass({ timeout: 5_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
