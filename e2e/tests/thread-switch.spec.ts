import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  invoke,
  contextPc,
  fixtureExe,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  stepAndWaitForNewPc,
  breakIntoRunningTarget,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

test.describe("Threads panel: active thread", () => {
  test("highlights the context thread; click switches it; step snaps back", async ({
    tauriPage: page,
  }) => {
    // Only the initial break stops the target; DLL-load/thread-create pauses
    // would otherwise land before the break-in below.
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Thread Switch", fixtureExe("hello_c"));
    try {
      await waitForPaused(page, sessionId);
      // The initial break has a single thread; break in on a running target so
      // the main thread (parked in a long Sleep) is a distinct switch target.
      await breakIntoRunningTarget(page, sessionId);

      const session = await invoke(page, "get_debug_session", { sessionId });
      const eventTid: number = session.current_event.thread_id;
      expect(session.selected_thread_id ?? null).toBeNull();

      await goToWindow(page, "Threads");
      const activeRow = page.locator('[data-testid="thread-row"][data-active="true"]');

      // Exactly one row is active, and it is the event thread.
      await expect(activeRow).toHaveCount(1);
      await expect(activeRow).toHaveAttribute("data-tid", String(eventTid));
      await expect(activeRow.getByText("current")).toBeVisible();
      await expect(activeRow.getByText("event")).toHaveCount(0);

      // Pick another thread (the main thread, parked in Sleep).
      const threads: Array<{ id: number }> = await invoke(page, "get_session_threads", { sessionId });
      const other = threads.find((t) => t.id !== eventTid);
      expect(other, "target has a second thread after break-in").toBeTruthy();
      const otherTid = other!.id;
      const pcBefore = contextPc(session.current_event.context);

      // Click the title: the row centre may land on the Start/TEB links, which
      // stop propagation.
      await page.locator(`[data-testid="thread-row"][data-tid="${otherTid}"] h3`).click();

      // Backend switches the context: thread id follows, event thread stays.
      await expect(async () => {
        const s = await invoke(page, "get_debug_session", { sessionId });
        expect(s.status).toBe("Paused");
        expect(s.selected_thread_id).toBe(otherTid);
        expect(s.current_event.thread_id).toBe(eventTid);
        expect(contextPc(s.current_event.context)).not.toBe(pcBefore);
      }).toPass({ timeout: 15_000, intervals: [50, 100] });

      // UI: highlight moved, the event thread is marked, Call Stack panel retargeted.
      await expect(activeRow).toHaveCount(1);
      await expect(activeRow).toHaveAttribute("data-tid", String(otherTid));
      await expect(
        page.locator(`[data-testid="thread-row"][data-tid="${eventTid}"]`).getByText("event"),
      ).toBeVisible();
      await goToWindow(page, "Stack");
      const panel = page.locator('[data-testid="callstack-panel"]');
      const selectedThreadBar = panel.locator("text=/^Thread \\d+$/");
      await expect(selectedThreadBar).toHaveText(`Thread ${otherTid}`, { timeout: 15_000 });

      // A step continues the event thread and resets the selection.
      await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      await expect(async () => {
        const s = await invoke(page, "get_debug_session", { sessionId });
        expect(s.selected_thread_id ?? null).toBeNull();
        expect(s.current_event.thread_id).toBe(eventTid);
      }).toPass({ timeout: 15_000, intervals: [50, 100] });
      await expect(selectedThreadBar).toHaveCount(0);
      await goToWindow(page, "Threads");
      await expect(activeRow).toHaveAttribute("data-tid", String(eventTid));
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
