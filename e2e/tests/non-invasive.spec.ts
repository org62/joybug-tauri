import { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { cleanupSession } from "../helpers/session-helpers";
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
  const sessionId: string = await page.evaluate(async (targetPid: number) => {
    const invoke = (window as any).__TAURI_INTERNALS__.invoke;
    const id = await invoke("create_debug_session", {
      name: `Open ${targetPid}`,
      serverUrl: "",
      launchCommand: "ping.exe",
      workingDirectory: null,
      isLocalRun: true,
      attachPid: targetPid,
      nonInvasive: true,
    });
    await invoke("start_debug_session", { sessionId: id });
    return id;
  }, pid);

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
      const attachPid = await page.evaluate(async (id: string) => {
        const s = await (window as any).__TAURI_INTERNALS__.invoke(
          "get_debug_session",
          { sessionId: id },
        );
        return s?.attach_pid;
      }, sessionId!);
      expect(attachPid).toBe(pid);

      // Module enumeration works with no debugger attach (Toolhelp fallback).
      const modules = await page.evaluate(async (id: string) => {
        return await (window as any).__TAURI_INTERNALS__.invoke(
          "get_session_modules",
          { sessionId: id },
        );
      }, sessionId!);
      expect(Array.isArray(modules)).toBe(true);
      expect(modules.length).toBeGreaterThan(0);

      // Thread enumeration works with no debugger attach (Toolhelp fallback).
      const threads = await page.evaluate(async (id: string) => {
        return await (window as any).__TAURI_INTERNALS__.invoke(
          "get_session_threads",
          { sessionId: id },
        );
      }, sessionId!);
      expect(Array.isArray(threads)).toBe(true);
      expect(threads.length).toBeGreaterThan(0);

      // A memory scan must run over the OOB scan connection against the
      // never-attached process. Starting one should resolve without error.
      const scanOk = await page.evaluate(async (id: string) => {
        try {
          await (window as any).__TAURI_INTERNALS__.invoke("request_scan_memory_start", {
            sessionId: id,
            valueType: "U32",
            compareType: "UnknownInitialValue",
            value: null,
            value2: null,
            alignment: 4,
            floatTolerance: null,
            writableOnly: true,
          });
          return true;
        } catch {
          return false;
        }
      }, sessionId!);
      expect(scanOk).toBe(true);

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
      await page.evaluate(async (id: string) => {
        await (window as any).__TAURI_INTERNALS__.invoke("stop_debug_session", {
          sessionId: id,
        });
      }, sessionId!);

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
      await page.evaluate(async (id: string) => {
        await (window as any).__TAURI_INTERNALS__.invoke("attach_open_session", { sessionId: id });
      }, sessionId!);

      // Attaching injects a breakpoint, so the session pauses and becomes invasive.
      await waitForPaused(page, sessionId);

      const s = await page.evaluate(async (id: string) => {
        return await (window as any).__TAURI_INTERNALS__.invoke("get_debug_session", { sessionId: id });
      }, sessionId!);
      expect(s.non_invasive).toBe(false);
      expect(s.attach_pid).toBe(pid);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
      await restoreDefaultSettings(page);
    }
  });
});
