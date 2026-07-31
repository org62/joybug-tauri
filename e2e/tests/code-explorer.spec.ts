import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow, type ModuleData } from "../helpers/session-helpers";
import { waitForPaused, goAndWaitForPause } from "../helpers/wait-helpers";
import type { Page } from "@playwright/test";

interface CoverageFn {
  address: string;
  symbol: string;
  rva: number;
  source: "pdata" | "symbol" | "validated" | "custom";
}

interface CoverageStartResult {
  functions: CoverageFn[];
  unresolved: string[];
}

/** Every enumeration tier — the panel's default with both switches on. */
const ALL_SOURCES = ["pdata", "symbol", "validated"];

/**
 * Arm coverage the way the panel does. `sources` lists the enumeration tiers to
 * draw from (empty = enumerate nothing, leaving `customEntries` to supply the
 * targets); the two are additive.
 */
function startCoverage(
  page: Page,
  sessionId: string,
  moduleName: string,
  opts: { hitLimit?: number; sources?: string[]; customEntries?: string[] } = {},
) {
  return invoke(page, "start_code_coverage", {
    sessionId,
    moduleName,
    hitLimit: opts.hitLimit ?? 1,
    sources: opts.sources ?? ALL_SOURCES,
    customEntries: opts.customEntries ?? [],
  }) as Promise<CoverageStartResult>;
}

interface CoverageHit {
  address: string;
  hit_count: number;
  first_hit_seq: number;
  first_hit_us: number;
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

      // Code Explorer is not in the default layout — open it on demand.
      await goToWindow(page, "Code Explorer");
      const ceTab = page.locator("[id$='-tab-code_explorer']").first();
      await expect(ceTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

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
      const { functions } = await startCoverage(page, sessionId, ntdll.name);

      expect(functions.length).toBeGreaterThan(100);
      const base = parseInt(ntdll.base_address, 16);
      // The armed table is well-formed: hex addresses inside the module, RVAs match.
      const sample = functions[0];
      expect(sample.symbol.length).toBeGreaterThan(0);
      const addrNum = parseInt(sample.address, 16);
      expect(addrNum).toBe(base + sample.rva);
      expect(addrNum).toBeGreaterThanOrEqual(base);
      expect(addrNum).toBeLessThan(base + ntdll.size);

      // Targets are the union of .pdata and symbols. ntdll always has an
      // exception directory, so .pdata-sourced rows must be present even when no
      // PDB is available — that union is what makes coverage work on binaries
      // whose PDB marks nothing as a function.
      for (const f of functions) {
        expect(["pdata", "symbol", "validated"]).toContain(f.source);
      }
      expect(functions.filter((f) => f.source === "pdata").length).toBeGreaterThan(0);

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
      // The timestamp is stamped on the same 0 -> 1 transition as the sequence
      // number, so walking the run in execution order must never go back in time.
      const byOrder = [...hits].sort((a, b) => a.first_hit_seq - b.first_hit_seq);
      let previousUs = 0;
      for (const h of byOrder) {
        expect(h.first_hit_us).toBeGreaterThanOrEqual(previousUs);
        previousUs = h.first_hit_us;
      }
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

  test("restricting target sources narrows the armed set", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    const sessionId = await createAndStartSession(page, "Code Explorer Sources");
    try {
      await waitForPaused(page, sessionId);
      const ntdll = await continueUntilNtdll(page, sessionId);

      // Opting out of the heuristic tier must never *add* targets, and
      // .pdata-only must be a subset of .pdata + PDB functions.
      const all = await startCoverage(page, sessionId, ntdll.name);
      await invoke(page, "stop_code_coverage", { sessionId });
      const noHeuristics = await startCoverage(page, sessionId, ntdll.name, {
        sources: ["pdata", "symbol"],
      });
      await invoke(page, "stop_code_coverage", { sessionId });
      const pdataOnly = await startCoverage(page, sessionId, ntdll.name, { sources: ["pdata"] });
      await invoke(page, "stop_code_coverage", { sessionId });

      expect(pdataOnly.functions.length).toBeGreaterThan(100);
      expect(pdataOnly.functions.length).toBeLessThanOrEqual(noHeuristics.functions.length);
      expect(noHeuristics.functions.length).toBeLessThanOrEqual(all.functions.length);
      // The narrow modes contain nothing from the tier they excluded.
      for (const f of pdataOnly.functions) expect(f.source).toBe("pdata");
      for (const f of noHeuristics.functions) expect(["pdata", "symbol"]).toContain(f.source);

      const wide = new Set(all.functions.map((f) => f.address));
      for (const f of pdataOnly.functions) expect(wide.has(f.address)).toBe(true);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a custom list arms exactly the named functions", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    const sessionId = await createAndStartSession(page, "Code Explorer Custom List");
    try {
      await waitForPaused(page, sessionId);
      const ntdll = await continueUntilNtdll(page, sessionId);

      // Pick real targets to name, then ask for exactly those plus a raw
      // address, a comment, and a name that cannot resolve.
      const { functions: available } = await startCoverage(page, sessionId, ntdll.name);
      await invoke(page, "stop_code_coverage", { sessionId });
      const named = available.filter((f) => !f.symbol.startsWith("sub_")).slice(0, 3);
      expect(named.length).toBeGreaterThan(0);
      const rawAddress = available[0].address;

      const result = await startCoverage(page, sessionId, ntdll.name, {
        sources: [], // list only — nothing enumerated
        customEntries: [
          ...named.map((f) => f.symbol),
          rawAddress,
          "# a comment line",
          "definitely_not_a_real_symbol_xyzzy",
        ],
      });

      expect(result.unresolved).toEqual(["definitely_not_a_real_symbol_xyzzy"]);
      // Only what was asked for — nothing from enumeration leaks in.
      expect(result.functions.length).toBeLessThanOrEqual(named.length + 1);
      for (const f of result.functions) expect(f.source).toBe("custom");
      const armed = new Set(result.functions.map((f) => f.address));
      expect(armed.has(rawAddress)).toBe(true);
      for (const f of named) expect(armed.has(f.address)).toBe(true);

      await invoke(page, "stop_code_coverage", { sessionId });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a session restart clears the armed scan instead of leaving it live", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    const sessionId = await createAndStartSession(page, "Code Explorer Restart");
    try {
      await waitForPaused(page, sessionId);
      await goToWindow(page, "Code Explorer");

      // Scope to the panel: the session header has its own Start/Stop controls,
      // and matching those makes every assertion here pass vacuously.
      const panel = page
        .locator(".absolute.inset-0")
        .filter({ hasText: "Exception directory" })
        .first();

      // Arm through the panel, so what's under test is the panel's own state.
      await panel.getByRole("button", { name: /^Start$/ }).click();
      await expect(panel.getByRole("button", { name: /^Stop$/ })).toBeVisible({ timeout: 20_000 });

      // A restart keeps the session id but replaces the process, so every armed
      // breakpoint is gone with the old one. The panel must not keep claiming to
      // be live over a table that now instruments nothing.
      await invoke(page, "restart_debug_session", { sessionId });
      await waitForPaused(page, sessionId);

      await expect(panel.getByRole("button", { name: /^Start$/ })).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByRole("button", { name: /^Stop$/ })).toHaveCount(0);
      await expect(page.getByText(/Pick a module and click Start/i)).toBeVisible();
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a list combines with the other sources instead of replacing them", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    const sessionId = await createAndStartSession(page, "Code Explorer Combined");
    try {
      await waitForPaused(page, sessionId);
      const ntdll = await continueUntilNtdll(page, sessionId);

      // The switches are independent, so .pdata + a list must arm the union.
      const pdataOnly = await startCoverage(page, sessionId, ntdll.name, { sources: ["pdata"] });
      await invoke(page, "stop_code_coverage", { sessionId });

      // An address .pdata does not cover, so the union is strictly larger.
      const symbolOnly = await startCoverage(page, sessionId, ntdll.name, {
        sources: ["symbol", "validated"],
      });
      await invoke(page, "stop_code_coverage", { sessionId });
      const armedByPdata = new Set(pdataOnly.functions.map((f) => f.address));
      const extra = symbolOnly.functions.find((f) => !armedByPdata.has(f.address));
      test.skip(!extra, "no symbol-only address available in this ntdll build");

      const combined = await startCoverage(page, sessionId, ntdll.name, {
        sources: ["pdata"],
        customEntries: [extra!.address],
      });
      expect(combined.functions.length).toBe(pdataOnly.functions.length + 1);
      const armed = new Set(combined.functions.map((f) => f.address));
      expect(armed.has(extra!.address)).toBe(true);
      for (const f of pdataOnly.functions) expect(armed.has(f.address)).toBe(true);

      await invoke(page, "stop_code_coverage", { sessionId });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
