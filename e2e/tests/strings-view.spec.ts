import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow, type ModuleData } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  clearCapturedEvents,
  waitForCapturedEvent,
} from "../helpers/event-helpers";
import type { Page } from "@playwright/test";

interface StringEntry {
  address: string;
  encoding: string;
  length: number;
  text: string;
  truncated: boolean;
}

const RESULTS_EVENT = "string-scan-results";

/** Install capture for the scan events and locate the scan target (cmd.exe). */
async function setupStringScan(page: Page, sessionId: string): Promise<{ base: number; size: number }> {
  await installEventCapture(page, [
    "string-scan-start-result",
    RESULTS_EVENT,
    "string-scan-error",
  ]);
  const modules = (await invoke(page, "get_session_modules", { sessionId })) as ModuleData[];
  // cmd.exe (the default target) has plentiful embedded strings.
  const mainModule = modules.find((m) => m.name.toLowerCase().includes("cmd.exe")) ?? modules[0];
  expect(mainModule).toBeTruthy();
  return { base: parseInt(mainModule.base_address, 16), size: mainModule.size };
}

test.describe("Strings View", () => {
  test("scans a module, filters, and sorts strings", async ({ tauriPage: page }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Strings View");
      await waitForPaused(page, sessionId);

      const { base, size } = await setupStringScan(page, sessionId);
      expect(size).toBeGreaterThan(0);

      // 1. Start the scan; the start-result event carries the results path + count.
      await invoke(page, "request_string_scan_start", {
        sessionId,
        startAddress: base,
        size,
        minLength: 5,
        regionFilter: "readable",
        encodings: "both",
        contains: "",
      });

      const start = await waitForCapturedEvent(page, "string-scan-start-result", () => true, 15_000);
      expect(start.match_count).toBeGreaterThan(0);
      const resultsPath = start.results_path as string;

      // 2. Fetch the first page (address-sorted) and assert strings lie in range.
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath, offset: 0, count: 200, filter: "", sortKey: "address", ascending: true,
      });
      let res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) => (p.strings?.length ?? 0) > 0);
      const firstPage = res.strings as StringEntry[];
      const sample = firstPage[0];
      expect(sample.text.length).toBeGreaterThan(0);
      const addrNum = parseInt(sample.address, 16);
      expect(addrNum).toBeGreaterThanOrEqual(base);
      expect(addrNum).toBeLessThan(base + size);
      // Address sort is ascending.
      const addrs = firstPage.map((s) => parseInt(s.address, 16));
      for (let i = 1; i < addrs.length; i++) expect(addrs[i]).toBeGreaterThanOrEqual(addrs[i - 1]);

      // 3. Filter by a substring taken from a real hit; every match must contain it.
      // Match the payload whose strings all contain the needle (the app's own view
      // may emit an unfiltered payload concurrently — pick ours by predicate).
      const needle = sample.text.slice(0, Math.min(4, sample.text.length)).toLowerCase();
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath, offset: 0, count: 200, filter: needle, sortKey: "address", ascending: true,
      });
      res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) =>
        (p.strings?.length ?? 0) > 0 &&
        (p.strings as StringEntry[]).every((s) => s.text.toLowerCase().includes(needle)),
      );
      expect(res.total_count).toBeGreaterThanOrEqual(1);

      // 4. Sort by value: results are lexicographically non-descending. Pick the
      // payload that is actually value-sorted (an unfiltered address-sorted payload
      // from the app view would not be, so the predicate skips it).
      const isNonDescending = (strings: StringEntry[]) => {
        const v = strings.map((s) => s.text.toLowerCase());
        for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1]) return false;
        return true;
      };
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath, offset: 0, count: 200, filter: "", sortKey: "value", ascending: true,
      });
      res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) =>
        (p.strings?.length ?? 0) > 1 && isNonDescending(p.strings as StringEntry[]),
      );
      expect((res.strings as StringEntry[]).length).toBeGreaterThan(1);

      // 5. Sort by length: ascending then descending.
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath, offset: 0, count: 200, filter: "", sortKey: "length", ascending: true,
      });
      const lengthsSorted = (strings: StringEntry[], asc: boolean) => {
        for (let i = 1; i < strings.length; i++) {
          if (asc ? strings[i].length < strings[i - 1].length : strings[i].length > strings[i - 1].length) return false;
        }
        return true;
      };
      res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) =>
        (p.strings?.length ?? 0) > 1 && lengthsSorted(p.strings as StringEntry[], true),
      );
      expect((res.strings as StringEntry[]).length).toBeGreaterThan(1);

      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath, offset: 0, count: 200, filter: "", sortKey: "length", ascending: false,
      });
      res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) =>
        (p.strings?.length ?? 0) > 1 && lengthsSorted(p.strings as StringEntry[], false),
      );
      // The longest strings come first; cmd.exe surely has one > 5 chars.
      expect((res.strings as StringEntry[])[0].length).toBeGreaterThan(5);

      // 6. UI smoke: opening the Strings window mounts its toolbar ("Min len" is
      // unique to this view). Not in the default layout, so ask for it.
      await goToWindow(page, "Strings");
      await expect(page.getByText("Min len", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

      await invoke(page, "request_string_scan_reset", { sessionId, resultsPath });
      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("scans with scope, encoding, and contains options", async ({ tauriPage: page }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Strings Scopes");
      await waitForPaused(page, sessionId);

      const { base, size } = await setupStringScan(page, sessionId);

      // 1. ASCII-only module scan: every stored entry is ascii.
      await invoke(page, "request_string_scan_start", {
        sessionId, startAddress: base, size, minLength: 5,
        regionFilter: "readable", encodings: "ascii", contains: "",
      });
      let start = await waitForCapturedEvent(page, "string-scan-start-result", () => true, 15_000);
      expect(start.match_count).toBeGreaterThan(0);
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath: start.results_path, offset: 0, count: 200,
        filter: "", sortKey: "address", ascending: true,
      });
      let res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) => (p.strings?.length ?? 0) > 0);
      for (const s of res.strings as StringEntry[]) expect(s.encoding).toBe("ascii");
      await invoke(page, "request_string_scan_reset", { sessionId, resultsPath: start.results_path });

      // 2. Scan-time contains filter: only strings containing the needle are stored.
      const needle = "microsoft"; // cmd.exe embeds Microsoft copyright/version strings
      await clearCapturedEvents(page, "string-scan-start-result");
      await invoke(page, "request_string_scan_start", {
        sessionId, startAddress: base, size, minLength: 5,
        regionFilter: "readable", encodings: "both", contains: needle,
      });
      start = await waitForCapturedEvent(page, "string-scan-start-result", () => true, 15_000);
      expect(start.match_count).toBeGreaterThan(0);
      await clearCapturedEvents(page, RESULTS_EVENT);
      await invoke(page, "request_string_scan_get_results", {
        sessionId, resultsPath: start.results_path, offset: 0, count: 200,
        filter: "", sortKey: "address", ascending: true,
      });
      res = await waitForCapturedEvent(page, RESULTS_EVENT, (p) => (p.strings?.length ?? 0) > 0);
      for (const s of res.strings as StringEntry[]) {
        expect(s.text.toLowerCase()).toContain(needle);
      }
      await invoke(page, "request_string_scan_reset", { sessionId, resultsPath: start.results_path });

      // 3. Writable memory across the whole address space (null span bounds):
      // environment strings etc. live in writable pages, so hits exist, and
      // some lie outside the main module.
      await clearCapturedEvents(page, "string-scan-start-result");
      await invoke(page, "request_string_scan_start", {
        sessionId, startAddress: null, size: null, minLength: 5,
        regionFilter: "writable", encodings: "both", contains: "",
      });
      start = await waitForCapturedEvent(page, "string-scan-start-result", () => true, 30_000);
      expect(start.match_count).toBeGreaterThan(0);
      await invoke(page, "request_string_scan_reset", { sessionId, resultsPath: start.results_path });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
