import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  goAndWaitForPause,
  continueSession,
} from "../helpers/wait-helpers";

test.describe("Stepping Controls", () => {
  test("F5 continues and pauses on next event with default settings", async ({
    tauriPage: page,
  }) => {
    // Use default settings (stop on most events)
    const sessionId = await createAndStartSession(page, "Step Default Test");

    try {
      // Should pause on first event (ProcessCreate or DllLoad)
      await waitForPaused(page, sessionId);

      // Continue — should pause on next event
      await goAndWaitForPause(page, sessionId);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("can step through multiple events to reach InitialBreakpoint", async ({
    tauriPage: page,
  }) => {
    // Use default settings — stops on many events
    const sessionId = await createAndStartSession(page, "Multi-Step Test");

    try {
      let foundInitialBreakpoint = false;
      for (let i = 0; i < 50; i++) {
        // Wait for session to reach Paused (retries short-lived evaluates)
        try {
          await waitForPaused(page, sessionId, 10_000);
        } catch {
          break; // Session stopped or timed out
        }

        // Get current event snapshot
        let currentEvent: any;
        try {
          currentEvent = await page.evaluate(async (id: string) => {
            const s = await (window as any).__TAURI_INTERNALS__.invoke(
              "get_debug_session",
              { sessionId: id },
            );
            return s?.current_event ?? null;
          }, sessionId);
        } catch {
          continue; // Context destroyed — retry
        }

        if (currentEvent?.event_type === "InitialBreakpoint") {
          foundInitialBreakpoint = true;
          break;
        }

        // Continue and wait for a NEW event to arrive (or session to leave Paused).
        // We compare events rather than waiting for "not Paused" because the debugger
        // often re-pauses on the next event in microseconds — too fast to catch Running.
        const prevEventJson = JSON.stringify(currentEvent);
        try {
          await continueSession(page, sessionId);
          await expect(async () => {
            const snapshot = await page.evaluate(async (id: string) => {
              const s = await (window as any).__TAURI_INTERNALS__.invoke(
                "get_debug_session",
                { sessionId: id },
              );
              return {
                status: s?.status,
                currentEvent: s?.current_event ?? null,
              };
            }, sessionId);
            const newEventJson = JSON.stringify(snapshot.currentEvent);
            expect(
              snapshot.status !== "Paused" || newEventJson !== prevEventJson,
            ).toBe(true);
          }).toPass({ timeout: 5_000, intervals: [50, 100, 250] });
        } catch {
          // Session might have stopped or context destroyed — next iteration handles it
        }
      }

      expect(foundInitialBreakpoint).toBe(true);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("F5 from InitialBreakpoint completes session", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Complete Step Test");
      await waitForPaused(page, sessionId);

      // Continue from InitialBreakpoint — process should run and exit
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Cleanup
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
