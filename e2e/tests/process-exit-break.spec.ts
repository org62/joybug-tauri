import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  contextPc,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";

/**
 * "Stop on process exit" must produce a *real* break, not a cosmetic one.
 *
 * The debuggee is a zombie by the time `ProcessExited` arrives, but its handles
 * (process, thread, address space) stay valid until the debugger issues the
 * final `ContinueDebugEvent` — so registers, modules and the callstack all still
 * resolve. The regression this guards: the session used to tear that state down
 * (and force status `Stopped`) while the debug loop was still parked waiting for
 * a UI command, so the configured break never surfaced.
 */
test.describe("Break on process exit", () => {
  test("pauses on ProcessExited with live state, then Go ends the session", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page, { stop_on_process_exit: true });

    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(
        page,
        "Process Exit Break",
        'cmd.exe /c "exit /b 42"',
      );
      await waitForPaused(page, sessionId);

      // Run to completion — this must land on a pause, not end the session.
      await continueSession(page, sessionId);
      await expect(async () => {
        const s = await invoke(page, "get_debug_session", { sessionId });
        expect(s?.status).toBe("Paused");
        expect(s?.current_event?.event_type).toBe("ProcessExited");
      }).toPass({ timeout: 30_000, intervals: [100, 250] });

      const s = await invoke(page, "get_debug_session", { sessionId });

      // The exit code is surfaced (cmd.exe exited with 42 = 0x2A).
      expect(s.current_event.details).toContain("0x2A");

      // A real break: registers resolved off the exiting thread. The PC lives
      // under a different name per debuggee arch (rip / pc), so read it through
      // the helper — cmd.exe is native on both x64 and ARM64 runners.
      const pc = contextPc(s.current_event.context);
      expect(pc).toBeTruthy();
      expect(BigInt(pc!)).toBeGreaterThan(0n);

      // ...and the module/thread lists survived instead of being wiped.
      const modules = await invoke(page, "get_session_modules", { sessionId });
      expect(modules.length).toBeGreaterThan(0);
      expect(
        modules.some((m: { name: string }) =>
          m.name.toLowerCase().includes("ntdll"),
        ),
      ).toBe(true);

      // The UI shows the paused badge, not a stopped session.
      await expect(
        page.locator('[data-session-status="Paused"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Go from the exit break releases the zombie and finishes the run.
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });
});
