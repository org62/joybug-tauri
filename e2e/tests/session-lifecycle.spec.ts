import { test, expect, navigateTo } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  createSession,
  cleanupSession,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";

test.describe("Session Lifecycle", () => {
  test("shows empty state when no sessions exist", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");
    await expect(page.getByText("No debug sessions yet")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("create session via dialog shows card with Stopped badge", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    const sessionId = await createSession(page, "Lifecycle Test");

    // Session card should show with Stopped badge
    await expect(page.getByText("Lifecycle Test")).toBeVisible();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();

    // Cleanup
    await cleanupSession(page, sessionId);
  });

  test("create & start session navigates to session page and reaches Paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Start Test");

      // Should be on the session page
      await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`));

      // Wait for InitialBreakpoint → Paused
      await waitForPaused(page, sessionId);

      // Cleanup
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("F5 from InitialBreakpoint completes session", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Complete Test");
      await waitForPaused(page, sessionId);

      // Continue — cmd.exe should run and exit
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Cleanup
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("delete session removes card from list", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    const sessionId = await createSession(page, "Delete Test");
    await expect(page.getByText("Delete Test")).toBeVisible();

    // Delete via backend invoke
    await page.evaluate(async (id: string) => {
      await (window as any).__TAURI_INTERNALS__.invoke(
        "delete_debug_session",
        { sessionId: id },
      );
    }, sessionId);

    // Session card should disappear
    await expect(page.getByText("Delete Test")).not.toBeVisible({
      timeout: 5_000,
    });
  });
});
