import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStatus,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface SymbolStatus {
  module_path: string;
  base_address: string;
  status: string;
  symbol_count: number | null;
}

test.describe("Restart & symbol unload", () => {
  test("restart stops the run and reaches a fresh Paused", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Restart Test");
      await waitForPaused(page, sessionId);

      // Current event identity, so we can tell the run actually cycled (a
      // restart terminates the target and launches a fresh one).
      const getPid = async () => {
        const s = await invoke(page, "get_debug_session", { sessionId });
        return s?.current_event?.process_id ?? null;
      };

      const beforePid = await getPid();

      await invoke(page, "restart_debug_session", { sessionId });

      // The backend stops, waits for the old loop to unwind, then starts a new
      // run that pauses at the fresh InitialBreakpoint.
      await waitForStatus(page, sessionId, "Paused", 60_000);

      // A relaunch gets a new PID (the old target was terminated).
      const afterPid = await getPid();
      expect(afterPid).toBeTruthy();
      expect(afterPid).not.toBe(beforePid);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("unloading a module's symbols drops its status to not_requested", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Unload Symbols");
      await waitForPaused(page, sessionId);

      const getStatuses = async (): Promise<SymbolStatus[]> =>
        await invoke(page, "get_session_symbol_status", { sessionId });

      // Wait for ntdll symbols to load (from cache or the symbol server).
      let ntdllBase = "";
      await expect(async () => {
        const ntdll = (await getStatuses()).find((s) =>
          s.module_path.toLowerCase().includes("ntdll"),
        );
        expect(ntdll?.status).toBe("loaded");
        expect(ntdll!.symbol_count ?? 0).toBeGreaterThan(0);
        ntdllBase = ntdll!.base_address;
      }).toPass({ timeout: 60_000, intervals: [100, 250, 500] });

      // Unload frees the server-side caches; status must fall to not_requested.
      await invoke(page, "unload_module_symbols", {
        sessionId,
        moduleBase: ntdllBase,
      });

      await expect(async () => {
        const ntdll = (await getStatuses()).find(
          (s) => s.base_address === ntdllBase,
        );
        expect(ntdll?.status).toBe("not_requested");
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
