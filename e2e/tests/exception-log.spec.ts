import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, fixtureExe } from "../helpers/session-helpers";
import {
  waitForPaused,
  goAndWaitForPause,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

/**
 * An access violation must surface with the decoded exception record — code
 * name, read/write, the referenced address, the faulting symbol and the
 * callstack — on the session header badge (label + hover popup) and in the
 * Logs page (one-line message, unfold, hover). The crash_c fixture writes to
 * 0xDEAD0000 from `crash_here`, so every value is known up front.
 */
test.describe("Exception log", () => {
  test.afterEach(async ({ tauriPage: page }) => {
    await restoreDefaultSettings(page);
  });

  test("access violation is symbolized on the badge and unfoldable in the log", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Exception Log", `${fixtureExe("crash_c")} exclog`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint
      await goAndWaitForPause(page, sessionId); // the AV

      // --- Header badge: name + access + referenced address on the label. ---
      const badge = page.getByTestId("session-exception");
      await expect(badge).toBeVisible({ timeout: 5_000 });
      await expect(badge).toContainText("EXCEPTION_ACCESS_VIOLATION");
      await expect(badge).toContainText("write 0xDEAD0000");

      // Hovering shows the full record: symbolized fault address + callstack.
      await badge.hover();
      const badgePopup = page.getByTestId("session-exception-popup");
      await expect(badgePopup).toBeVisible({ timeout: 5_000 });
      await expect(badgePopup).toContainText("crash_c!crash_here");
      await expect(badgePopup).toContainText("write to");
      await expect(badgePopup).toContainText("DEAD0000");
      await expect(badgePopup.locator('[data-testid="callstack-frame"]', { hasText: "crash_c!crash_here" })).toHaveCount(1);
      await page.mouse.move(0, 0);
      await expect(badgePopup).toBeHidden({ timeout: 5_000 });

      // --- Logs page: the one-liner carries everything; the chip unfolds the frames. ---
      await navigateTo(page, "/logs");
      const row = page.locator('[data-testid="log-row"]', { hasText: "EXCEPTION_ACCESS_VIOLATION" }).first();
      await expect(row).toBeVisible({ timeout: 10_000 }); // the page polls every 2s
      await expect(row).toContainText("first-chance at crash_c!crash_here");
      await expect(row).toContainText("write to");
      await expect(row).toContainText("DEAD0000");

      const toggle = row.getByTestId("log-exception-toggle");
      await expect(toggle).toContainText(/stack \([1-9]\d*\)/);

      // Hover → popup with the same record.
      await toggle.hover();
      const logPopup = page.getByTestId("log-exception-popup");
      await expect(logPopup).toBeVisible({ timeout: 5_000 });
      await expect(logPopup).toContainText("crash_c!crash_here");
      await expect(logPopup.locator('[data-testid="callstack-frame"]').first()).toBeVisible();

      // Click → the record and the frames unfold inline as extra list rows.
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator('[data-testid="log-detail-row"]', { hasText: "write to" })).toBeVisible();
      await expect(page.locator('[data-testid="log-frame-row"]', { hasText: "crash_c!crash_here" })).toBeVisible();

      // Click again folds it back.
      await page.mouse.move(0, 0);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator('[data-testid="log-frame-row"]')).toHaveCount(0);
    } finally {
      await cleanupSession(page, sessionId);
      // Leave /logs so the next spec doesn't inherit its 2s get_logs poll.
      await navigateTo(page, "/");
    }
  });

  /**
   * The same access violation, but the user's rule passes the first chance to
   * the program. crash_c has no handler, so it comes straight back as a
   * second-chance exception and stops there — which is also the proof the first
   * chance never paused. The first-chance log row must still carry the
   * symbolized fault address and a walked callstack: an exception nobody stops
   * on is exactly the one whose log entry has to stand on its own.
   */
  test("a passed first-chance exception is symbolized and carries a callstack", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page, {
      exception_rules: [{ code: 0xc0000005, first_chance: "pass", second_chance: "stop" }],
    });
    const sessionId = await createAndStartSession(page, "Passed Exception", `${fixtureExe("crash_c")} passexc`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint
      await goAndWaitForPause(page, sessionId); // straight past the first chance to the second

      await expect(page.getByTestId("session-exception")).toContainText("second-chance", { timeout: 5_000 });

      await navigateTo(page, "/logs");
      const firstChance = page
        .locator('[data-testid="log-row"]', { hasText: "EXCEPTION_ACCESS_VIOLATION" })
        .filter({ hasText: "first-chance" })
        .first();
      await expect(firstChance).toBeVisible({ timeout: 10_000 }); // the page polls every 2s
      await expect(firstChance).toContainText("first-chance at crash_c!crash_here");
      await expect(firstChance).toContainText("write to");
      await expect(firstChance.getByTestId("log-exception-toggle")).toContainText(/stack \([1-9]\d*\)/);
    } finally {
      await cleanupSession(page, sessionId);
      // Leave /logs so the next spec doesn't inherit its 2s get_logs poll.
      await navigateTo(page, "/");
    }
  });
});
