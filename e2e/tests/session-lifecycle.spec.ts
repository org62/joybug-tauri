import { test, expect, navigateTo } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  createSession,
  cleanupSession,
  findSessionById,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";

test.describe("Session Lifecycle", () => {
  test("shows empty state when no sessions exist", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");
    await expect(page.getByText("No processes yet")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("create session via dialog shows card with Stopped badge", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    const sessionId = await createSession(page, "Lifecycle Test");

    // Session card should show with Stopped badge
    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toBeVisible();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();

    // Cleanup
    await cleanupSession(page, sessionId);
  });

  test("create & start session navigates to session page and reaches Paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Start Test");

      // Should be on the session page
      await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`));

      // Wait for InitialBreakpoint → Paused
      await waitForPaused(page, sessionId);

      // Cleanup
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("F5 from InitialBreakpoint completes session", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Complete Test");
      await waitForPaused(page, sessionId);

      // Continue — cmd.exe should run and exit
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Cleanup
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("create session with working directory persists it to backend", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    await page.getByRole("button", { name: /Create Process/i }).first().click();
    await page.getByLabel("Launch Command").fill("cmd.exe /c echo WorkingDir Test");
    // Working directory lives inside its own collapsed fold; target the input by
    // id (its aria-label matches the fold button's).
    await page.getByRole("button", { name: "Working directory" }).click();
    await page.locator("#workingDirectory").fill("C:\\Windows");
    await page
      .getByRole("button", { name: "Create Session", exact: true })
      .click();

    // The backend should have stored the working directory we entered. (Naming
    // was removed from the dialog, so identify the session by that value.)
    let session: any;
    await expect(async () => {
      const sessions = await invoke(page, "get_debug_sessions");
      session = sessions.find((s: any) => s.working_directory === "C:\\Windows");
      expect(session).toBeTruthy();
    }).toPass({ timeout: 5_000 });

    expect(session?.working_directory).toBe("C:\\Windows");
    // No env vars entered → backend stores "inherit" (null), not an empty list.
    expect(session?.environment).toBeNull();

    // Cleanup
    await cleanupSession(page, session.id);
  });

  test("create session with environment variables persists them to backend", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    // Blank lines and # comments are skipped; the value keeps everything
    // after the first "=".
    const sessionId = await createSession(page, "EnvVars Test", {
      environment: "FOO=bar\n# comment\n\nBAZ=a=b",
    });

    const session = await findSessionById(page, sessionId);
    expect(session?.environment).toEqual([
      ["FOO", "bar"],
      ["BAZ", "a=b"],
    ]);

    await cleanupSession(page, sessionId);
  });

  test("environment variables reach the launched process", async ({
    tauriPage: page,
  }) => {
    // cmd.exe exits with %JOYBUG_E2E_EXIT%, which only exists if our block was
    // applied — and cmd.exe is only found at all because the rest of the
    // environment (PATH/SystemRoot) is still inherited, so this also proves
    // the merge is additive. The exit code is read off the ProcessExited break.
    await configureMinimalStopSettings(page, { stop_on_process_exit: true });

    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(
        page,
        "EnvVars Launch",
        'cmd.exe /c "exit /b %JOYBUG_E2E_EXIT%"',
        { environment: "JOYBUG_E2E_EXIT=42" },
      );

      await waitForPaused(page, sessionId);
      await continueSession(page, sessionId);
      let exited: any;
      await expect(async () => {
        exited = await invoke(page, "get_debug_session", { sessionId });
        expect(exited?.current_event?.event_type).toBe("ProcessExited");
      }).toPass({ timeout: 30_000, intervals: [50, 100] });

      // 42 = 0x2A; without the variable cmd.exe would exit 0.
      expect(exited.current_event.details).toContain("0x2A");

      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });

  test("delete session removes card from list", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");

    const sessionId = await createSession(page, "Delete Test");
    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible();

    // Delete via backend invoke
    await page.evaluate(async (id: string) => {
      await (window as any).__TAURI_INTERNALS__.invoke(
        "delete_debug_session",
        { sessionId: id },
      );
    }, sessionId);

    // Session card should disappear
    await expect(card).not.toBeVisible({ timeout: 5_000 });
  });
});
