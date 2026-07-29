import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface SymbolStatus {
  module_path: string;
  base_address: string;
  status: string;
  symbol_count: number | null;
  error: string | null;
  pdb_path: string | null;
}

test.describe("Symbol Status", () => {
  test("reports per-module symbol load status; ntdll symbols finish loading", async ({
    tauriPage: page,
  }) => {
    // On a cold symbol cache the ntdll PDB download can take a while.
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Symbol Status");
      await waitForPaused(page, sessionId);

      const getStatuses = async () =>
        await page.evaluate(async (id: string) => {
          return await (window as any).__TAURI_INTERNALS__.invoke(
            "get_session_symbol_status",
            { sessionId: id },
          );
        }, sessionId) as SymbolStatus[];

      // The status list should be non-empty and every entry in a known state.
      await expect(async () => {
        const statuses = await getStatuses();
        expect(statuses.length).toBeGreaterThan(0);
        for (const s of statuses) {
          expect(["loaded", "exports_only", "loading", "failed", "not_requested"]).toContain(s.status);
        }
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      // ntdll symbols load in the background (from cache or symbol server) and
      // the status flips to loaded with a symbol count.
      await expect(async () => {
        const statuses = await getStatuses();
        const ntdll = statuses.find((s) =>
          s.module_path.toLowerCase().includes("ntdll"),
        );
        expect(ntdll).toBeTruthy();
        expect(ntdll!.status).toBe("loaded");
        expect(ntdll!.symbol_count ?? 0).toBeGreaterThan(0);
      }).toPass({ timeout: 60_000, intervals: [250, 500] });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
