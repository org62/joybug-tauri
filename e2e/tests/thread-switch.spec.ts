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
  continueSession,
  waitForStatus,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import { IS_WINDOWS } from "../helpers/launch-commands";

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
      // Break in on the running target: by then hello_c has started its parked
      // worker thread, so there is a second thread to switch to. On Windows the
      // break-in also runs on a thread the debugger injected, so the process's
      // initial thread is a distinct one — which is what makes this the place
      // to prove the "main" badge tracks identity, not the current context. A
      // Linux break-in stops the main thread itself, so there the event thread
      // *is* main and the identity half of the check does not apply.
      await breakIntoRunningTarget(page, sessionId);

      const session = await invoke(page, "get_debug_session", { sessionId });
      const eventTid: number = session.current_event.thread_id;
      expect(session.selected_thread_id ?? null).toBeNull();
      const mainTid: number = session.main_thread_id;
      expect(mainTid, "backend recorded the initial thread").toBeTruthy();
      if (IS_WINDOWS) expect(mainTid).not.toBe(eventTid);

      await goToWindow(page, "Threads");
      const activeRow = page.locator('[data-testid="thread-row"][data-active="true"]');

      // Exactly one row is active, and it is the event thread.
      await expect(activeRow).toHaveCount(1);
      await expect(activeRow).toHaveAttribute("data-tid", String(eventTid));
      await expect(activeRow.getByText("current")).toBeVisible();
      await expect(activeRow.getByText("event", { exact: true })).toBeVisible();

      // ...and "main" sits on the initial thread — on Windows never on the
      // break-in thread that currently holds the context. Exact text match: the
      // start symbol of that very row reads `hello_c!mainCRTStartup`.
      const mainRow = page.locator('[data-testid="thread-row"][data-main="true"]');
      await expect(mainRow).toHaveCount(1);
      await expect(mainRow).toHaveAttribute("data-tid", String(mainTid));
      await expect(mainRow.getByText("main", { exact: true })).toBeVisible();
      if (IS_WINDOWS) await expect(activeRow).not.toHaveAttribute("data-main", "true");

      // Pick another thread (parked in its long sleep).
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

test.describe("Threads panel: named native and WOW64 targets", () => {
  for (const fixture of ["hello_c", "hello_c32"] as const) {
    test(`${fixture}: filtering and expansion preserve context; restart clears view state`, async ({
      tauriPage: page,
    }) => {
      test.skip(!IS_WINDOWS, "Windows legacy notifications and thread descriptions");
      await configureMinimalStopSettings(page);
      const sessionId = await createAndStartSession(
        page, "Named threads", `"${fixtureExe(fixture)}" --thread-info`,
      );
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      try {
        await waitForPaused(page, sessionId);
        await continueSession(page, sessionId);
        await waitForStatus(page, sessionId, "Running");
        let workerTid = 0;
        await expect(async () => {
          const rows = await invoke(page, "get_session_threads", { sessionId });
          const worker = rows.find((t: { name: string | null }) => t.name === "Worker Ω diagnostic");
          expect(worker?.priority).toBe(-1);
          expect(worker?.thread_state).toBe(5);
          expect(worker?.wait_reason).not.toBeNull();
          expect(worker?.suspend_count).toBe(0);
          expect(worker?.instruction_pointer).toBeNull();
          workerTid = worker.id;
          expect(rows.some((t: { name: string | null }) => t.name === "Main Δ thread")).toBe(true);
          expect(rows.some((t: { name: string | null }) => t.name === "Legacy worker")).toBe(true);
        }).toPass({ timeout: 15_000, intervals: [50, 100] });
        await invoke(page, "pause_debug_session", { sessionId });
        await waitForPaused(page, sessionId);
        await page.setViewportSize({ width: 900, height: 1000 });
        await goToWindow(page, "Threads");

        const before = await invoke(page, "get_debug_session", { sessionId });
        const eventTid = before.current_event.thread_id;
        const pausedThreads = await invoke(page, "get_session_threads", { sessionId });
        const pausedWorker = pausedThreads.find((t: { id: number }) => t.id === workerTid);
        expect(pausedWorker.suspend_count).toBe(1);
        const expectedArch = fixture === "hello_c32"
          ? "X86" : before.current_event.context.arch;
        expect(pausedWorker.teb_architecture).toBe(expectedArch);
        expect(BigInt(pausedWorker.teb_address) > 0n).toBe(true);
        expect(pausedWorker.instruction_pointer_architecture).toBe(expectedArch);
        expect(BigInt(pausedWorker.instruction_pointer) > 0n).toBe(true);
        const row = page.locator(`[data-testid="thread-row"][data-tid="${workerTid}"]`);
        const filter = page.getByRole("textbox", { name: "Filter threads" });
        const allRows = page.getByTestId("thread-row");
        await filter.fill("  wOrKeR Ω  ");
        await expect(allRows).toHaveCount(1);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-selected", "false");
        const disclosure = row.getByRole("button", { name: `Thread ${workerTid} details` });
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        const details = row.locator("dl");
        await expect(details).toContainText("Worker Ω diagnostic");
        await expect(details).toContainText("Below normal (-1)");
        await expect(details).toContainText(/\d{2,}:\d{2}:\d{2}\.\d{7}/);
        await expect(details).toContainText(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z/);
        // Selecting detail text must not act like clicking the thread summary.
        await details.locator("dd").last().click();
        // Scrolling a tall detail row must leave the filter and toolbar fixed.
        await expect(async () => {
          const metrics = await row.evaluate((element) => {
            const viewport = element.closest('[data-slot="scroll-area-viewport"]')!;
            const panel = element.closest('[data-slot="dock-panel"]')!;
            return { viewport: viewport.clientHeight, panel: panel.clientHeight, chromeScroll: panel.scrollTop };
          });
          expect(metrics.viewport).toBeLessThanOrEqual(metrics.panel);
          expect(metrics.chromeScroll).toBe(0);
        }).toPass({ timeout: 5_000, intervals: [50, 100] });
        await expect(details).toContainText(pausedWorker.teb_address);
        await expect(details).toContainText(pausedWorker.instruction_pointer);
        await expect(row).toHaveAttribute("data-selected", "false");
        const afterDetails = await invoke(page, "get_debug_session", { sessionId });
        expect(afterDetails.selected_thread_id ?? null).toBe(before.selected_thread_id ?? null);
        expect(afterDetails.current_event.thread_id).toBe(eventTid);

        // Role filters are observational, including the unique current row.
        await filter.fill("current");
        await expect(allRows).toHaveCount(1);
        await expect(allRows).toHaveAttribute("data-tid", String(eventTid));
        await expect(async () => {
          const fits = await allRows.evaluate((element) => {
            const row = element.getBoundingClientRect();
            const disclosure = element.querySelector('button[aria-expanded]')!.getBoundingClientRect();
            return [...element.querySelectorAll('[data-slot="badge"]')].every((badge) => {
              const box = badge.getBoundingClientRect();
              return box.left >= row.left && box.right <= row.right
                && (box.right <= disclosure.left || box.left >= disclosure.right
                  || box.bottom <= disclosure.top || box.top >= disclosure.bottom);
            });
          });
          expect(fits).toBe(true);
        }).toPass({ timeout: 5_000, intervals: [50, 100] });
        await filter.fill("main");
        await expect(allRows).toHaveCount(1);
        await expect(allRows).toHaveAttribute("data-tid", String(before.main_thread_id));
        await filter.fill("no-thread-matches-this");
        await expect(allRows).toHaveCount(0);
        await expect(filter).toBeVisible();
        await filter.fill(`0x${workerTid.toString(16)}`);
        await expect(row).toBeVisible();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        const afterFilter = await invoke(page, "get_debug_session", { sessionId });
        expect(afterFilter.selected_thread_id ?? null).toBe(before.selected_thread_id ?? null);
        expect(afterFilter.current_event.thread_id).toBe(eventTid);

        // Measured empty -> populated lists retain usable disclosure and selection.
        await continueSession(page, sessionId);
        await waitForStatus(page, sessionId, "Running");
        await expect(details).not.toContainText(pausedWorker.instruction_pointer);
        await expect(async () => {
          const worker = (await invoke(page, "get_session_threads", { sessionId }))
            .find((t: { id: number }) => t.id === workerTid);
          expect(worker.suspend_count).toBe(0);
          expect(worker.instruction_pointer).toBeNull();
        }).toPass({ timeout: 5_000, intervals: [50, 100] });
        await filter.fill("current");
        await expect(allRows).toHaveCount(0);
        await filter.fill(`0x${workerTid.toString(16)}`);
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await row.getByTestId("thread-checkbox").click();
        await expect(row).toHaveAttribute("data-selected", "true");
        await invoke(page, "restart_debug_session", { sessionId });
        await expect(async () => {
          const restarted = await invoke(page, "get_debug_session", { sessionId });
          expect(restarted.status).toBe("Paused");
          expect(restarted.current_event.process_id).not.toBe(before.current_event.process_id);
        }).toPass({ timeout: 20_000, intervals: [50, 100] });
        await expect(filter).toHaveValue("");
        await expect(page.locator('[data-testid="thread-row"][data-selected="true"]')).toHaveCount(0);
        await expect(page.locator('[aria-expanded="true"][aria-label$=" details"]')).toHaveCount(0);
        await invoke(page, "stop_debug_session", { sessionId });
        await waitForStatus(page, sessionId, "Stopped");
        await expect(allRows).toHaveCount(0);
        await expect(filter).toHaveCount(0);
      } finally {
        await cleanupSession(page, sessionId);
        await restoreDefaultSettings(page);
        await page.setViewportSize(viewport);
      }
    });
  }
});
