import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface SymbolStatus {
  module_path: string;
  status: string;
}

interface Breakpoint {
  address: number;
  group: string | null;
  symbol: string | null;
  bp_kind: string;
}

// A narrow ntdll term that resolves to a small, stable set of function symbols,
// keeping the mass-apply well under the confirm threshold.
const SEARCH_TERM = "RtlInitUnicodeString";

test.describe("Symbol mass breakpoints", () => {
  test("select all symbols and mass-apply an auto-grouped breakpoint set", async ({
    tauriPage: page,
  }) => {
    // Cold ntdll PDB download can be slow.
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    try {
      // Unique launch command per attempt: breakpoints persist keyed by launch
      // command, so a fixed one would reload a previous run's/retry's breakpoints
      // (under fresh ASLR addresses) and inflate the count.
      const sessionId = await createAndStartSession(
        page,
        "Symbol Mass BP",
        `cmd.exe /c echo mass_bp_${Date.now()}`,
      );
      await waitForPaused(page, sessionId);

      // ntdll symbols load in the background — the search needs them to resolve hits.
      await expect(async () => {
        const statuses = (await invoke(page, "get_session_symbol_status", {
          sessionId,
        })) as SymbolStatus[];
        const ntdll = statuses.find((s) =>
          s.module_path.toLowerCase().includes("ntdll"),
        );
        expect(ntdll?.status).toBe("loaded");
      }).toPass({ timeout: 60_000, intervals: [250, 500] });

      // Open the Symbols window and search.
      await goToWindow(page, "Symbols");
      const search = page.getByPlaceholder("Search symbols...");
      await search.waitFor({ state: "visible" });
      await search.fill(SEARCH_TERM);

      // Wait for results (the selection strip shows "N found").
      const selectAll = page.getByRole("button", { name: "Select All" });
      await expect(selectAll).toBeVisible({ timeout: 10_000 });

      // Select everything, then read the count off the apply button before clicking.
      await selectAll.click();
      const applyBtn = page.getByRole("button", { name: /Set Breakpoints/ });
      await expect(applyBtn).toBeEnabled();
      const label = (await applyBtn.textContent()) ?? "";
      const selectedCount = parseInt(label.match(/\((\d+)\)/)?.[1] ?? "0", 10);
      expect(selectedCount).toBeGreaterThan(0);

      await applyBtn.click();

      // The breakpoints land in state, each tagged with the search term as its group.
      await expect(async () => {
        const session = (await invoke(page, "get_debug_session", {
          sessionId,
        })) as { breakpoints: Breakpoint[] };
        const grouped = session.breakpoints.filter((b) => b.group === SEARCH_TERM);
        // Each selected symbol becomes a grouped breakpoint; dedup can only collapse
        // symbols that share an address, so the count never exceeds the selection.
        expect(grouped.length).toBeGreaterThan(0);
        expect(grouped.length).toBeLessThanOrEqual(selectedCount);
        // They are ordinary software breakpoints and resolve to the searched symbol.
        for (const b of grouped) {
          expect(b.bp_kind).toBe("software");
        }
        expect(
          grouped.some((b) => (b.symbol ?? "").includes(SEARCH_TERM)),
        ).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      // Applying clears the selection — the apply button drops back to disabled.
      await expect(
        page.getByRole("button", { name: "Set Breakpoints" }),
      ).toBeDisabled();

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
