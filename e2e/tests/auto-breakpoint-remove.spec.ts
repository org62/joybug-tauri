import { test, expect } from "../helpers/test-fixtures";
import { echoCmd, COVERAGE_MODULE, IS_WINDOWS } from "../helpers/launch-commands";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  type BreakpointData,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  continueSession,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface Session {
  status: string;
  breakpoints: BreakpointData[];
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
 * The target is `cmd.exe` (the echo fixture on Linux), whose module entry
 * points — DLL entry points / shared-object initializers — have not all run at
 * the first pause, and which exits promptly.
 */
test.describe("Auto breakpoint removal", () => {
  test("removed module-entry breakpoints do not fire", async ({
    tauriPage: page,
  }) => {
    // cmd.exe and its DLLs live in System32 (libc under /usr/lib), so this is
    // the toggle that covers them.
    await configureMinimalStopSettings(page, { break_on_system_module_entry: true });

    let sessionId = "";
    try {
      // A launch command of its own: breakpoints are persisted per command, and
      // the shared default carries rows left behind by other specs, which would
      // stop this run for reasons that have nothing to do with what it asserts.
      sessionId = await createAndStartSession(
        page,
        "Auto BP Remove",
        echoCmd("e2e_auto_bp_remove"),
      );
      await waitForPaused(page, sessionId);

      if (!IS_WINDOWS) {
        // On Linux a library's "module entry" is its first initializer, which
        // ld.so runs *before* the program's entry point, so the row planted at
        // libc's load has already fired by the first pause: that pause is the
        // hit itself, inside libc, and the single-shot row is consumed. Prove
        // that, then that nothing of it lingers — with the setting off the run
        // must reach process exit with no further stop.
        const first = (await invoke(page, "get_debug_session", { sessionId })) as Session & {
          current_event: { event_type: string; address: number };
        };
        expect(first.current_event?.event_type).toBe("SingleShotBreakpoint");
        const modules = (await invoke(page, "get_session_modules", { sessionId })) as {
          name: string; base_address: string; size: number;
        }[];
        const libc = modules.find((m) => m.name.includes(COVERAGE_MODULE));
        expect(libc, "libc is loaded").toBeTruthy();
        const base = BigInt(libc!.base_address);
        const hit = BigInt(first.current_event.address);
        expect(hit >= base && hit < base + BigInt(libc!.size), "the hit is libc's initializer").toBe(true);
        expect(first.breakpoints.filter((bp) => bp.single_shot)).toHaveLength(0);

        await configureMinimalStopSettings(page, {
          break_on_system_module_entry: false,
          stop_on_initial_breakpoint: false,
        });
        await continueSession(page, sessionId);
        await waitForStopped(page, sessionId);
        return;
      }

      // Entry-point rows are planted as modules load; the first pause is either
      // the initial breakpoint or one of these breakpoints firing.
      let autoBps: BreakpointData[] = [];
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
