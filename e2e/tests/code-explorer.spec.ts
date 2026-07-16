import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, type ModuleData } from "../helpers/session-helpers";
import { waitForPaused, goAndWaitForPause } from "../helpers/wait-helpers";
import type { Page } from "@playwright/test";

interface CoverageFn {
  address: string;
  symbol: string;
  rva: number;
}

interface CoverageHit {
  address: string;
  hit_count: number;
  first_hit_seq: number;
  thread_ids: number[];
}

/** Continue until ntdll is loaded (only cmd.exe is present at the first pause)
 *  and return it. ntdll's loader code runs during startup, so arming coverage on
 *  it reliably produces hits on subsequent continues. */
async function continueUntilNtdll(page: Page, sessionId: string): Promise<ModuleData> {
  for (let i = 0; i < 8; i++) {
    const modules = (await invoke(page, "get_session_modules", { sessionId })) as ModuleData[];
    const ntdll = modules.find((m) => m.name.toLowerCase().includes("ntdll.dll"));
    if (ntdll) return ntdll;
    await goAndWaitForPause(page, sessionId, 20_000);
  }
  throw new Error("ntdll.dll never appeared in the module list");
}

test.describe("Code Explorer", () => {
  // Default stop settings (no configureMinimalStopSettings): the target pauses on
  // startup events, so we can arm coverage, continue to let ntdll loader code run,
  // and re-pause to read the counts back while the process is still alive.

  test("opens the Code Explorer panel", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Code Explorer Panel");
    try {
      await waitForPaused(page, sessionId);

      // code_explorer is in the default dock layout (the fixture resets any
      // persisted layout, so the default is what renders).
      const ceTab = page.locator("[id$='-tab-code_explorer']").first();

      // Activate the tab; rc-dock can re-assert the default active tab on
      // re-render, so click until aria-selected sticks.
      await expect(async () => {
        await ceTab.click({ force: true });
        await expect(ceTab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
      }).toPass({ timeout: 10_000 });

      // The panel's empty-state prompt should render.
      await expect(page.getByText(/Pick a module and click Start/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("arms coverage on a module and counts hits", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    const sessionId = await createAndStartSession(page, "Code Explorer Coverage");
    try {
      await waitForPaused(page, sessionId);
      const ntdll = await continueUntilNtdll(page, sessionId);

      // 1. Arm coverage on every ntdll function. hitLimit=1 = pure coverage
      //    (each breakpoint auto-removes on first hit, so the run stays fast).
      const functions = (await invoke(page, "start_code_coverage", {
        sessionId,
        moduleName: ntdll.name,
        hitLimit: 1,
      })) as CoverageFn[];

      expect(functions.length).toBeGreaterThan(100);
      const base = parseInt(ntdll.base_address, 16);
      // The armed table is well-formed: hex addresses inside the module, RVAs match.
      const sample = functions[0];
      expect(sample.symbol.length).toBeGreaterThan(0);
      const addrNum = parseInt(sample.address, 16);
      expect(addrNum).toBe(base + sample.rva);
      expect(addrNum).toBeGreaterThanOrEqual(base);
      expect(addrNum).toBeLessThan(base + ntdll.size);

      // 2. Continue past startup events so ntdll loader code executes; poll counts
      //    after each pause and stop once we've observed hits.
      let hits: CoverageHit[] = [];
      for (let i = 0; i < 8 && hits.length === 0; i++) {
        try {
          await goAndWaitForPause(page, sessionId, 20_000);
        } catch {
          break; // process may have exited — read whatever accrued
        }
        hits = (await invoke(page, "get_code_coverage", { sessionId })) as CoverageHit[];
      }

      expect(hits.length, "some ntdll functions should have been hit").toBeGreaterThan(0);
      // hitLimit=1 removes each breakpoint after its first hit, so every count is 1.
      for (const h of hits) expect(h.hit_count).toBe(1);
      // Every reported hit belongs to the armed set.
      const armed = new Set(functions.map((f) => f.address));
      for (const h of hits) expect(armed.has(h.address)).toBe(true);
      // First-hit sequence numbers are exactly the consecutive set 1..N (only
      // coverage first-hits advance the counter, and only ntdll is armed).
      const seqs = hits.map((h) => h.first_hit_seq).sort((a, b) => a - b);
      seqs.forEach((seq, i) => expect(seq).toBe(i + 1));
      // hitLimit=1 means a single hit per function, hence a single thread id.
      for (const h of hits) {
        expect(h.thread_ids.length).toBe(1);
        expect(h.thread_ids[0]).toBeGreaterThan(0);
      }

      // 3. Stop clears coverage; a subsequent poll returns nothing.
      await invoke(page, "stop_code_coverage", { sessionId });
      const afterStop = (await invoke(page, "get_code_coverage", { sessionId })) as CoverageHit[];
      expect(afterStop.length).toBe(0);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
