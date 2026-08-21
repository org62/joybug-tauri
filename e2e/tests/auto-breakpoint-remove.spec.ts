import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  continueSession,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface Breakpoint {
  id: string;
  address: number;
  group: string | null;
  single_shot: boolean;
}

interface Session {
  status: string;
  breakpoints: Breakpoint[];
  current_event?: { event_type?: string; address?: number };
}

/**
 * Removing a settings-planted single-shot breakpoint must actually disarm it.
 *
 * The "Module Entry" / "TLS Callbacks" settings plant `single_shot` rows. Those
 * live in their own map on the server, and `remove_breakpoint` used to consult
 * only the persistent map — so deleting such a row dropped it from the UI while
 * leaving the breakpoint instruction written in the debuggee, and the session
 * still trapped there. This drives the reported flow end to end: plant, delete,
 * continue, and the process must run to exit instead of stopping.
 *
 * The target is `cmd.exe`, whose module entry points have not all run at the
 * first pause, and which exits promptly (the source fixtures sleep for minutes).
 */
test.describe("Auto breakpoint removal", () => {
  test("removed module-entry breakpoints do not fire", async ({
    tauriPage: page,
  }) => {
    // cmd.exe and its DLLs live in System32, so this is the toggle that covers them.
    await configureMinimalStopSettings(page, { break_on_system_module_entry: true });

    let sessionId = "";
    try {
      // A launch command of its own: breakpoints are persisted per command, and
      // the shared default carries rows left behind by other specs, which would
      // stop this run for reasons that have nothing to do with what it asserts.
      sessionId = await createAndStartSession(
        page,
        "Auto BP Remove",
        "cmd.exe /c echo e2e_auto_bp_remove",
      );
      await waitForPaused(page, sessionId);

      // Entry-point rows are planted as modules load; the first pause is either
      // the initial breakpoint or one of these breakpoints firing.
      let autoBps: Breakpoint[] = [];
      await expect(async () => {
        const session = (await invoke(page, "get_debug_session", {
          sessionId,
        })) as Session;
        autoBps = session.breakpoints.filter(
          (bp) => bp.group === "Module Entry" && bp.single_shot,
        );
        expect(autoBps.length).toBeGreaterThan(0);
      }).toPass({ timeout: 20_000, intervals: [50, 100] });

      const removedAddresses = autoBps.map((bp) => bp.address);

      await invoke(page, "remove_breakpoints", {
        sessionId,
        breakpointIds: autoBps.map((bp) => bp.id),
      });

      // Turn the setting back off (it exercises the same removal path through
      // the mid-session sync, and stops later module loads from planting fresh
      // rows), and stop pausing on the initial breakpoint. Nothing is left that
      // may legitimately stop the run — so a single Go has to reach process exit
      // unless one of the removed breakpoints is still armed.
      await configureMinimalStopSettings(page, {
        break_on_system_module_entry: false,
        stop_on_initial_breakpoint: false,
      });

      await expect(async () => {
        const session = (await invoke(page, "get_debug_session", {
          sessionId,
        })) as Session;
        expect(session.breakpoints.filter((bp) => bp.single_shot)).toHaveLength(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Before the fix the breakpoint instruction was still written in the
      // debuggee, so this stopped at an entry point instead of finishing.
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      const final = (await invoke(page, "get_debug_session", {
        sessionId,
      })) as Session;
      const stoppedAt = final.current_event?.address;
      if (stoppedAt !== undefined) {
        expect(removedAddresses).not.toContain(stoppedAt);
      }
    } finally {
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });
});
