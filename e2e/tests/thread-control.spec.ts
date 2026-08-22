import { test, expect } from "../helpers/test-fixtures";
import type { Page } from "@playwright/test";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  invoke,
  fixtureExe,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStatus,
  continueSession,
  breakIntoRunningTarget,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface ThreadRow {
  id: number;
  suspend_count: number;
}

async function threadById(page: Page, sessionId: string, tid: number): Promise<ThreadRow | undefined> {
  const threads: ThreadRow[] = await invoke(page, "get_session_threads", { sessionId });
  return threads.find((t) => t.id === tid);
}

/** Poll until the backend reports `tid` at exactly `count` nested suspends. */
async function expectSuspendCount(
  page: Page,
  sessionId: string,
  tid: number,
  count: number,
): Promise<void> {
  await expect(async () => {
    expect((await threadById(page, sessionId, tid))?.suspend_count).toBe(count);
  }).toPass({ timeout: 10_000, intervals: [50, 100] });
}

test.describe("Threads panel: suspend / resume / kill", () => {
  test("multi-select bulk actions and context menu control threads", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Thread Control", fixtureExe("hello_c"));
    try {
      await waitForPaused(page, sessionId);
      // Let main park in its long Sleep, then break in so there is a second
      // (injected) thread and the main thread is a safe target.
      await breakIntoRunningTarget(page, sessionId);

      const session = await invoke(page, "get_debug_session", { sessionId });
      const eventTid: number = session.current_event.thread_id;
      const threads: ThreadRow[] = await invoke(page, "get_session_threads", { sessionId });
      const main = threads.find((t) => t.id !== eventTid);
      expect(main, "target has a second thread after break-in").toBeTruthy();
      const mainTid = main!.id;
      expect(main!.suspend_count).toBe(0);

      await goToWindow(page, "Threads");
      const row = page.locator(`[data-testid="thread-row"][data-tid="${mainTid}"]`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-status", "Running");

      // Bulk bar: disabled until something is selected.
      const suspendBtn = page.getByTestId("thread-action-suspend");
      const resumeBtn = page.getByTestId("thread-action-resume");
      const killBtn = page.getByTestId("thread-action-kill");
      await expect(suspendBtn).toBeDisabled();

      await row.getByTestId("thread-checkbox").click();
      await expect(row).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("thread-selection-count")).toHaveText("1 selected");
      await expect(suspendBtn).toBeEnabled();

      // Suspend via the bulk bar → live count and badge flip.
      await suspendBtn.click();
      await expectSuspendCount(page, sessionId, mainTid, 1);
      await expect(row).toHaveAttribute("data-status", "Suspended");
      // The selection survives the refresh.
      await expect(row).toHaveAttribute("data-selected", "true");

      // Resume via the bulk bar.
      await resumeBtn.click();
      await expectSuspendCount(page, sessionId, mainTid, 0);
      await expect(row).toHaveAttribute("data-status", "Running");

      // Header checkbox: with one selected it selects all, then clears all.
      await page.getByTestId("thread-select-all").click();
      await expect(page.getByTestId("thread-selection-count")).toHaveText(`${threads.length} selected`);
      await page.getByTestId("thread-select-all").click();
      await expect(suspendBtn).toBeDisabled();

      // Context menu on an unselected row acts on that row alone.
      await row.locator("h3").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Suspend" }).click();
      await expectSuspendCount(page, sessionId, mainTid, 1);
      // The event thread was not touched.
      expect((await threadById(page, sessionId, eventTid))?.suspend_count).toBe(0);
      await row.locator("h3").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Resume" }).click();
      await expectSuspendCount(page, sessionId, mainTid, 0);

      // Kill: while the target runs, so the ThreadExited event prunes the list.
      await continueSession(page, sessionId);
      await waitForStatus(page, sessionId, "Running", 15_000);
      await row.getByTestId("thread-checkbox").click();
      await expect(killBtn).toBeEnabled();
      await killBtn.click();
      const confirm = page.getByTestId("thread-kill-confirm");
      await expect(confirm).toBeVisible();
      await confirm.click();
      await expect(async () => {
        expect(await threadById(page, sessionId, mainTid)).toBeUndefined();
      }).toPass({ timeout: 15_000, intervals: [50, 100] });
      await expect(row).toHaveCount(0);
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
