import { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { cleanupSession, invoke } from "../helpers/session-helpers";
import { spawnTarget, isAlive, killQuietly } from "../helpers/process-helpers";
import {
  waitForPaused,
  waitForStatus,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

/**
 * Create + start a non-invasive session against `pid` directly through the
 * backend, navigate to it, and wait until it reaches Open (no debug loop,
 * no pause). Returns the session id.
 */
async function createOpenSession(page: Page, pid: number): Promise<string> {
  const sessionId: string = await invoke(page, "create_debug_session", {
    name: `Open ${pid}`,
    serverUrl: "",
    launchCommand: "ping.exe",
    workingDirectory: null,
    isLocalRun: true,
    attachPid: pid,
    nonInvasive: true,
  });
  await invoke(page, "start_debug_session", { sessionId });

  await navigateTo(page, `/session/${sessionId}`);
  await waitForStatus(page, sessionId, "Open", 15_000);
  return sessionId;
}

test.describe("Non-invasive mode", () => {
  test("open a process non-invasively: reaches Open, never attaches, enumerates modules/threads", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      expect(pid).toBeGreaterThan(0);

      sessionId = await createOpenSession(page, pid);

      // The backend recorded the target PID.
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session?.attach_pid).toBe(pid);

      // Module/thread enumeration works with no debugger attach (Toolhelp
      // fallback). A non-invasive Open session has no debug loop to populate
      // the cached lists, so each call goes to the server over OOB; right
      // after OpenProcess the Toolhelp snapshot can momentarily come back
      // empty, so poll until the enumeration settles rather than reading once.
      const expectNonEmptyList = async (cmd: string) => {
        await expect(async () => {
          const items = await invoke(page, cmd, { sessionId });
          expect(Array.isArray(items)).toBe(true);
          expect(items.length).toBeGreaterThan(0);
        }).toPass({ timeout: 10_000, intervals: [50, 100, 250] });
      };
      await expectNonEmptyList("get_session_modules");
      await expectNonEmptyList("get_session_threads");

      // A memory scan must run over the OOB scan connection against the
      // never-attached process. Starting one should resolve without error.
      await invoke(page, "request_scan_memory_start", {
        sessionId,
        valueType: "U32",
        compareType: "UnknownInitialValue",
        value: null,
        value2: null,
        alignment: 4,
        floatTolerance: null,
        writableOnly: true,
      });

      // The whole point of non-invasive: the target was never attached/suspended
      // and keeps running the entire time.
      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
    }
  });

  test("stopping a non-invasive session leaves the target running", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      sessionId = await createOpenSession(page, pid);

      // Stop the session — a non-invasive stop must NOT terminate the target.
      await invoke(page, "stop_debug_session", { sessionId });

      await waitForStatus(page, sessionId!, "Stopped", 15_000);

      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
    }
  });

  test("attaching from an Open session reaches Paused (enables full debugging)", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      sessionId = await createOpenSession(page, pid);

      // Promote the non-invasive session to a full attached debug session.
      await invoke(page, "attach_open_session", { sessionId });

      // Attaching injects a breakpoint, so the session pauses and becomes invasive.
      await waitForPaused(page, sessionId);

      const s = await invoke(page, "get_debug_session", { sessionId });
      expect(s.non_invasive).toBe(false);
      expect(s.attach_pid).toBe(pid);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
      await restoreDefaultSettings(page);
    }
  });
});
