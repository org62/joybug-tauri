import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, goToWindow } from "../helpers/session-helpers";
import { waitForPaused } from "../helpers/wait-helpers";

test.describe("Call Stack panel", () => {
  // Regression: the Threads hover popover fetches a thread's call stack for
  // preview. Those fetches carry preview=true and must NOT retarget the Call
  // Stack panel — only an explicit click on a thread row may do that.
  test("thread hover previews without retargeting; click retargets", async ({
    tauriPage: page,
  }) => {
    const sessionId = await createAndStartSession(page, "CallStack Hover");
    try {
      await waitForPaused(page, sessionId);

      const panel = page.locator('[data-testid="callstack-panel"]');
      // The "Thread N" toolbar only appears after an explicit thread selection.
      const selectedThreadBar = panel.locator("text=/^Thread \\d+$/");

      // On pause the panel auto-fetches the current thread's stack: frames
      // appear, but no thread is explicitly selected.
      await goToWindow(page, "Call Stack");
      const firstFrame = panel.locator('[data-testid="callstack-frame"]').first();
      await expect(firstFrame).toBeVisible({ timeout: 15_000 });
      await expect(selectedThreadBar).toHaveCount(0);
      const frameBefore = await firstFrame.textContent();

      // Hover a thread row until its preview popover shows — the popover
      // rendering proves the preview fetch round-tripped through the backend.
      await goToWindow(page, "Threads");
      const threadTitle = page.locator("h3", { hasText: /^Thread \d+$/ }).first();
      await expect(threadTitle).toBeVisible();
      const tid = (await threadTitle.textContent())!.replace("Thread", "").trim();
      await threadTitle.hover();
      await expect(page.getByText(`Thread ${tid} Call Stack`)).toBeVisible({ timeout: 15_000 });

      // The Call Stack panel is untouched: same first frame, still no selection.
      await expect(selectedThreadBar).toHaveCount(0);
      expect(await firstFrame.textContent()).toBe(frameBefore);

      // Clicking the thread IS an explicit selection — the panel retargets.
      await threadTitle.click();
      await expect(selectedThreadBar).toHaveText(`Thread ${tid}`, { timeout: 15_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
