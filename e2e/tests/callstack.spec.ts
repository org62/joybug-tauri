import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, fixtureExe, goToWindow } from "../helpers/session-helpers";
import {
  configureMinimalStopSettings,
  continueSession,
  restoreDefaultSettings,
  setArmedBreakpoint,
  waitForPaused,
  waitForPauseOn,
  waitForSymbolVa,
} from "../helpers/wait-helpers";

test.describe("Stack panel", () => {
  test("wheel reveals clipped callers without moving the Stack toolbar", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "CallStack Scroll", `"${fixtureExe("hello_c")}" stack-scroll`);
    try {
      await waitForPauseOn(page, sessionId, "InitialBreakpoint");
      const compute = await waitForSymbolVa(page, sessionId, "hello_c", "compute");
      await setArmedBreakpoint(page, sessionId, compute);
      await continueSession(page, sessionId);
      await waitForPauseOn(page, sessionId, "Breakpoint");
      await goToWindow(page, "Stack");

      const panel = page.getByTestId("callstack-panel");
      const frames = panel.getByTestId("callstack-frame");
      const toolbarButton = panel.getByTestId("stack-mode-frames");
      await expect(frames.first()).toContainText("compute");

      // Shrink the Stack dock as a user can, so the real stack overflows.
      const splitter = await page.evaluate(() => {
        const dock = document.querySelector('[data-testid="callstack-panel"]')?.closest(".dock-panel");
        const divider = dock?.previousElementSibling;
        if (!dock || !divider?.matches(".dock-divider")) return null;
        const r = divider.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, targetY: dock.getBoundingClientRect().bottom - 150 };
      });
      expect(splitter).not.toBeNull();
      await page.mouse.move(splitter!.x, splitter!.y);
      await page.mouse.down();
      await page.mouse.move(splitter!.x, splitter!.targetY, { steps: 6 });
      await page.mouse.up();

      const bounds = (await panel.boundingBox())!;
      const lastFrame = frames.last();
      expect((await lastFrame.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
      const toolbarY = (await toolbarButton.boundingBox())!.y;
      const wheelPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 14 };
      // Breakpoint toasts can cover this dock; hovering a toast keeps it alive.
      await page.mouse.move(bounds.x / 2, wheelPoint.y);
      await expect.poll(() => page.evaluate(({ x, y }) =>
        !!document.elementFromPoint(x, y)?.closest('[data-testid="callstack-frame"]'),
      wheelPoint), { intervals: [50, 100] }).toBe(true);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await expect(panel.locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]'))
        .toBeVisible({ intervals: [50, 100] });
      await page.mouse.wheel(0, 600);
      await expect(async () => {
        const row = (await lastFrame.boundingBox())!;
        expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
        expect(row.y).toBeGreaterThan(toolbarY + (await toolbarButton.boundingBox())!.height);
        expect((await toolbarButton.boundingBox())!.y).toBe(toolbarY);
      }).toPass({ intervals: [50, 100] });
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

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
      await goToWindow(page, "Stack");
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
