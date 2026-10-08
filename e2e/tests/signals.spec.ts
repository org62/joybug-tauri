import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, fixtureExe } from "../helpers/session-helpers";
import { IS_WINDOWS } from "../helpers/launch-commands";
import { waitForPaused, waitForPauseOn, continueSession, configureMinimalStopSettings, restoreDefaultSettings } from "../helpers/wait-helpers";

/** The exception code a Linux target's SIGUSR1 is reported as. */
const SIGUSR1_CODE = 0x4c53000a;
const SIGUSR1_RULE = { code: SIGUSR1_CODE, first_chance: "stop", second_chance: "stop" };

/**
 * Signal policy (Linux). A signal that is the program's own business reaches
 * it unseen unless an exception rule names it; with a rule it stops like any
 * exception, and the continue decides whether the program ever gets it. The
 * `signal_c` fixture handles SIGUSR1 and raises it: it exits 10 when its
 * handler ran and 11 when the signal never arrived.
 */
test.describe("Signal policy", () => {
  test.skip(IS_WINDOWS, "POSIX signals");

  test.afterEach(async ({ tauriPage: page }) => {
    await restoreDefaultSettings(page);
  });

  test("a signal without a rule reaches the program unseen", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page, { stop_on_process_exit: true });
    const sessionId = await createAndStartSession(page, "Signal Unseen", `${fixtureExe("signal_c")} unseen`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint
      await continueSession(page, sessionId);
      // No stop in between: the next pause is the exit, and the handler ran.
      const exit = await waitForPauseOn(page, sessionId, "ProcessExited");
      expect(exit.details).toContain("0xA");
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a rule stops on the signal by name, and Go drops it", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page, { stop_on_process_exit: true, exception_rules: [SIGUSR1_RULE] });
    const sessionId = await createAndStartSession(page, "Signal Dropped", `${fixtureExe("signal_c")} dropped`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint
      await continueSession(page, sessionId);

      const stop = await waitForPauseOn(page, sessionId, "Exception");
      expect(stop.exception.name).toBe("SIGUSR1");
      expect(stop.exception.code).toBe(SIGUSR1_CODE);
      expect(stop.exception.first_chance).toBe(true);
      // raise() is the program signalling itself: the record names the sender.
      expect(stop.details).toMatch(/SIGUSR1 \(0x4C53000A\) first-chance at .* — sent by pid \d+/);
      await expect(page.getByTestId("session-exception")).toContainText("SIGUSR1");

      // A plain Go handles the exception: the signal is never delivered.
      await continueSession(page, sessionId);
      const exit = await waitForPauseOn(page, sessionId, "ProcessExited");
      expect(exit.details).toContain("0xB");
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("Go (Pass Exception) delivers the signal to the program's handler", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page, { stop_on_process_exit: true, exception_rules: [SIGUSR1_RULE] });
    const sessionId = await createAndStartSession(page, "Signal Passed", `${fixtureExe("signal_c")} passed`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint
      await continueSession(page, sessionId);
      await waitForPauseOn(page, sessionId, "Exception");

      await invoke(page, "step_pass_exception", { sessionId });
      // The program handles SIGUSR1, so there is no second chance: straight to the exit.
      const exit = await waitForPauseOn(page, sessionId, "ProcessExited");
      expect(exit.details).toContain("0xA");
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a rule added while the session is live takes effect at the next event", async ({ tauriPage: page }) => {
    // Stop on thread/module events off, process exit on: the only stops are
    // the initial breakpoint, the signal (once the rule exists) and the exit.
    await configureMinimalStopSettings(page, { stop_on_process_exit: true });
    const sessionId = await createAndStartSession(page, "Signal Live Rule", `${fixtureExe("signal_c")} liverule`);
    try {
      await waitForPaused(page, sessionId); // initial breakpoint, launched with no rule
      await configureMinimalStopSettings(page, { stop_on_process_exit: true, exception_rules: [SIGUSR1_RULE] });
      // The policy rides on the next event the session sees; a single step is one.
      await invoke(page, "step_in_debug_session", { sessionId });
      await waitForPauseOn(page, sessionId, "StepComplete");

      await continueSession(page, sessionId);
      const stop = await waitForPauseOn(page, sessionId, "Exception");
      expect(stop.exception.name).toBe("SIGUSR1");
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("Settings offers the signals by name and fills in the code", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    try {
      await navigateTo(page, "/settings");
      await expect(page.getByTestId("exception-rules-empty")).toContainText("add a rule for a signal");

      await page.getByRole("button", { name: "Add", exact: true }).click();
      const rule = page.getByTestId("exception-rule").last();
      await rule.getByTestId("exception-rule-signal").click();
      await page.getByRole("option", { name: "SIGUSR1", exact: true }).click();
      await expect(rule.getByTestId("exception-rule-code")).toHaveValue("0x4C53000A");

      // The rule is saved under the code the backend reports the signal as.
      await expect(async () => {
        const settings = await invoke(page, "get_debug_settings", {});
        expect(settings.exception_rules).toEqual([SIGUSR1_RULE]);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });
    } finally {
      await navigateTo(page, "/");
    }
  });
});
