import { test, expect } from "../helpers/test-fixtures";
import type { Page } from "../helpers/test-fixtures";
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
import { IS_WINDOWS } from "../helpers/launch-commands";

interface ThreadRow {
  id: number;
  suspend_count: number | null;
}

async function threadById(page: Page, sessionId: string, tid: number): Promise<ThreadRow | undefined> {
  const threads: ThreadRow[] = await invoke(page, "get_session_threads", { sessionId });
  return threads.find((t) => t.id === tid);
}

/** Poll the reported count (including the Windows debug freeze when paused). */
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
      // Let the target start its parked worker thread, then break in. The
      // thread the break-in lands on (an injected one on Windows, main on
      // Linux) stays untouched; the other, parked in a long sleep, is the one
      // suspended, resumed and killed here.
      await breakIntoRunningTarget(page, sessionId);

      const session = await invoke(page, "get_debug_session", { sessionId });
      const eventTid: number = session.current_event.thread_id;
      const pausedCount = IS_WINDOWS ? 1 : 0;
      const pausedStatus = IS_WINDOWS ? "Suspended" : "Running";
      const threads: ThreadRow[] = await invoke(page, "get_session_threads", { sessionId });
      const main = threads.find((t) => t.id !== eventTid && t.suspend_count === pausedCount);
      expect(main, "target has a second thread after break-in").toBeTruthy();
      const mainTid = main!.id;
      expect(main!.suspend_count).toBe(pausedCount);

      await goToWindow(page, "Threads");
      const row = page.locator(`[data-testid="thread-row"][data-tid="${mainTid}"]`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute("data-status", pausedStatus);

      // Bulk bar: disabled until something is selected.
      const suspendBtn = page.getByTestId("thread-action-suspend");
      const resumeBtn = page.getByTestId("thread-action-resume");
      const killBtn = page.getByTestId("thread-action-kill");
      await expect(suspendBtn).toBeDisabled();

      await row.getByTestId("thread-checkbox").click();
      await expect(row).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("thread-selection-count")).toHaveText("1 selected");
      await expect(suspendBtn).toBeEnabled();

      // User suspension adds to the existing Windows debug freeze.
      await suspendBtn.click();
      await expectSuspendCount(page, sessionId, mainTid, pausedCount + 1);
      await expect(row).toHaveAttribute("data-status", "Suspended");
      // The selection survives the refresh.
      await expect(row).toHaveAttribute("data-selected", "true");

      // Resume via the bulk bar.
      await resumeBtn.click();
      await expectSuspendCount(page, sessionId, mainTid, pausedCount);
      await expect(row).toHaveAttribute("data-status", pausedStatus);

      // Header checkbox: with one selected it selects all, then clears all.
      await page.getByTestId("thread-select-all").click();
      await expect(page.getByTestId("thread-selection-count")).toHaveText(`${threads.length} selected`);
      await page.getByTestId("thread-select-all").click();
      await expect(suspendBtn).toBeDisabled();

      // Context menu on an unselected row acts on that row alone.
      await row.locator("h3").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Suspend" }).click();
      await expectSuspendCount(page, sessionId, mainTid, pausedCount + 1);
      // The event thread retains only its debug freeze on Windows.
      expect((await threadById(page, sessionId, eventTid))?.suspend_count).toBe(pausedCount);
      await row.locator("h3").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Resume" }).click();
      await expectSuspendCount(page, sessionId, mainTid, pausedCount);

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

test.describe("Threads panel: filtered actions", () => {
  test("hidden checkbox identities never become bulk or context-menu targets", async ({
    tauriPage: page,
  }) => {
    test.skip(!IS_WINDOWS, "Windows named diagnostic fixture");
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(
      page, "Filtered thread actions", `"${fixtureExe("hello_c")}" --thread-info`,
    );
    try {
      await waitForPaused(page, sessionId);
      await continueSession(page, sessionId);
      await waitForStatus(page, sessionId, "Running");
      let workerTid = 0;
      let legacyTid = 0;
      await expect(async () => {
        const rows = await invoke(page, "get_session_threads", { sessionId });
        workerTid = rows.find((t: { name: string | null }) => t.name === "Worker Ω diagnostic")?.id ?? 0;
        legacyTid = rows.find((t: { name: string | null }) => t.name === "Legacy worker")?.id ?? 0;
        expect(workerTid).not.toBe(0);
        expect(legacyTid).not.toBe(0);
      }).toPass({ timeout: 15_000, intervals: [50, 100] });
      await goToWindow(page, "Threads");
      const filter = page.getByRole("textbox", { name: "Filter threads" });
      const worker = page.locator(`[data-testid="thread-row"][data-tid="${workerTid}"]`);
      const legacy = page.locator(`[data-testid="thread-row"][data-tid="${legacyTid}"]`);
      const suspend = page.getByTestId("thread-action-suspend");
      const hidden = page.getByTestId("thread-hidden-selection-count");
      const selectAll = page.getByTestId("thread-select-all");

      await filter.fill("Worker Ω");
      await worker.getByTestId("thread-checkbox").click();
      await expect(worker).toHaveAttribute("data-selected", "true");
      await filter.fill("Legacy worker");
      await expect(worker).toHaveCount(0);
      await expect(hidden).toContainText("1");
      await expect(suspend).toBeDisabled();
      // Adding visible identities and clearing them must leave the hidden one intact.
      await selectAll.click();
      await expect(legacy).toHaveAttribute("data-selected", "true");
      await suspend.click();
      await expectSuspendCount(page, sessionId, legacyTid, 1);
      await expectSuspendCount(page, sessionId, workerTid, 0);
      await invoke(page, "pause_debug_session", { sessionId });
      await waitForPaused(page, sessionId);
      await expectSuspendCount(page, sessionId, legacyTid, 2);
      await expectSuspendCount(page, sessionId, workerTid, 1);
      await continueSession(page, sessionId);
      await waitForStatus(page, sessionId, "Running");
      await expectSuspendCount(page, sessionId, legacyTid, 1);
      await legacy.locator("h3").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Resume" }).click();
      await expectSuspendCount(page, sessionId, legacyTid, 0);
      await expectSuspendCount(page, sessionId, workerTid, 0);
      await selectAll.click();
      await expect(legacy).toHaveAttribute("data-selected", "false");
      await expect(hidden).toContainText("1");
      await expect(suspend).toBeDisabled();
      await filter.fill("Worker Ω");
      await expect(worker).toHaveAttribute("data-selected", "true");

      // A context menu must not survive a query that hides its target.
      await worker.locator("h3").click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Suspend" })).toBeVisible();
      await filter.fill("Legacy worker");
      await expect(page.getByRole("menuitem", { name: "Suspend" })).toHaveCount(0);
      await legacy.getByTestId("thread-checkbox").click();
      await page.getByTestId("thread-action-kill").click();
      await page.getByTestId("thread-kill-confirm").click();
      await expect(async () => {
        expect(await threadById(page, sessionId, legacyTid)).toBeUndefined();
        expect((await threadById(page, sessionId, workerTid))?.suspend_count).toBe(0);
      }).toPass({ timeout: 15_000, intervals: [50, 100] });
      await expect(legacy).toHaveCount(0);
      await filter.fill("Worker Ω");
      await expect(worker).toHaveAttribute("data-selected", "true");
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
