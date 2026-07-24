import { ChildProcess } from "child_process";
import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { cleanupSession } from "../helpers/session-helpers";
import { spawnTarget, isAlive, killQuietly } from "../helpers/process-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

/** Read the session id out of the current /session/:id URL. */
function sessionIdFromUrl(url: string): string {
  const match = url.match(/\/session\/([^/?#]+)/);
  if (!match) throw new Error(`Expected a /session/:id URL, got: ${url}`);
  return match[1];
}

test.describe("Attach / Detach", () => {
  test("attach via dialog reaches Paused; Detach leaves the target running", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      expect(pid).toBeGreaterThan(0);

      await navigateTo(page, "/debugger");

      // Open the attach dialog and wait for the process list to populate.
      await page.getByRole("button", { name: /Attach to Process/i }).click();

      // Narrow the list to our target PID, then click its row.
      await page.getByPlaceholder("Filter by name or PID").fill(String(pid));
      const row = page.locator("button", {
        hasText: new RegExp(`PID ${pid}$`),
      });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();

      // Clicking creates + starts the attach session and navigates to it.
      await page.waitForURL(/\/session\//, { timeout: 15_000 });
      sessionId = sessionIdFromUrl(page.url());

      // Attaching injects a breakpoint into the target, so it should pause.
      await waitForPaused(page, sessionId);

      // The backend should record this as an attach session on the right PID.
      const attachPid = await page.evaluate(async (id: string) => {
        const s = await (window as any).__TAURI_INTERNALS__.invoke(
          "get_debug_session",
          { sessionId: id },
        );
        return s?.attach_pid;
      }, sessionId);
      expect(attachPid).toBe(pid);

      // Detach via the Stop split-button dropdown and confirm the session ends.
      await page.getByRole("button", { name: "Stop options" }).click();
      const detachItem = page.getByRole("menuitem", { name: /Detach/ });
      await expect(detachItem).toBeEnabled();
      await detachItem.click();
      await waitForStopped(page, sessionId);

      // The whole point of detach: the target keeps running afterwards.
      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
      await restoreDefaultSettings(page);
    }
  });

  test("list_processes includes a freshly spawned process", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;

    try {
      expect(pid).toBeGreaterThan(0);

      const found = await page.evaluate(async (targetPid: number) => {
        const procs = await (window as any).__TAURI_INTERNALS__.invoke(
          "list_processes",
          { serverUrl: null },
        );
        return procs.some((p: any) => p.pid === targetPid);
      }, pid);

      expect(found).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });

  test("attach via backend and detach through the session channel", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      expect(pid).toBeGreaterThan(0);

      // Create + start an attach session directly through the backend.
      sessionId = await page.evaluate(async (targetPid: number) => {
        const invoke = (window as any).__TAURI_INTERNALS__.invoke;
        const id = await invoke("create_debug_session", {
          name: `Attach Backend ${targetPid}`,
          serverUrl: "",
          launchCommand: `attach-target-${targetPid}`,
          workingDirectory: null,
          isLocalRun: true,
          attachPid: targetPid,
        });
        await invoke("start_debug_session", { sessionId: id });
        return id;
      }, pid);

      await navigateTo(page, `/session/${sessionId}`);
      await waitForPaused(page, sessionId);

      await page.evaluate(async (id: string) => {
        await (window as any).__TAURI_INTERNALS__.invoke(
          "detach_debug_session",
          { sessionId: id },
        );
      }, sessionId!);

      await waitForStopped(page, sessionId);
      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
      await restoreDefaultSettings(page);
    }
  });

  test("re-attach resolves a restarted process by name automatically", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const targetA = spawnTarget();
    const pidA = targetA.pid!;
    let targetB: ChildProcess | undefined;
    let sessionId: string | undefined;

    try {
      // Attach to the first instance.
      sessionId = await page.evaluate(async (pid: number) => {
        const invoke = (window as any).__TAURI_INTERNALS__.invoke;
        const id = await invoke("create_debug_session", {
          name: `Reattach ${pid}`,
          serverUrl: "",
          launchCommand: "ping.exe",
          workingDirectory: null,
          isLocalRun: true,
          attachPid: pid,
        });
        await invoke("start_debug_session", { sessionId: id });
        return id;
      }, pidA);

      await navigateTo(page, `/session/${sessionId}`);
      await waitForPaused(page, sessionId);

      // Detach — the first instance keeps running.
      await page.evaluate(async (id: string) => {
        await (window as any).__TAURI_INTERNALS__.invoke(
          "detach_debug_session",
          { sessionId: id },
        );
      }, sessionId!);
      await waitForStopped(page, sessionId);

      // Restart the target: kill the first instance, launch a new one (new PID,
      // same image name). Wait until the old PID is really gone so it can't be
      // resolved by mistake.
      killQuietly(pidA);
      await expect(() => {
        expect(isAlive(pidA)).toBe(false);
      }).toPass({ timeout: 10_000 });

      targetB = spawnTarget();
      const pidB = targetB.pid!;
      expect(pidB).not.toBe(pidA);

      // Re-attach from the session list. The stored PID is dead, but there's a
      // single "ping.exe", so it should attach to the new instance automatically.
      await navigateTo(page, "/debugger");
      await page.getByTitle("Re-attach").click();
      await page.waitForURL(/\/session\//, { timeout: 15_000 });
      await waitForPaused(page, sessionId);

      const attachPid = await page.evaluate(async (id: string) => {
        const s = await (window as any).__TAURI_INTERNALS__.invoke(
          "get_debug_session",
          { sessionId: id },
        );
        return s?.attach_pid;
      }, sessionId!);
      expect(attachPid).toBe(pidB);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pidA);
      killQuietly(targetB?.pid);
      await restoreDefaultSettings(page);
    }
  });
});
