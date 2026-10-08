import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, fixtureExe, invoke, moduleBase } from "../helpers/session-helpers";
import { waitForPaused, waitForModuleSymbols, waitForSymbolVa, configureMinimalStopSettings, restoreDefaultSettings } from "../helpers/wait-helpers";
import { installEventCapture, waitForCapturedEvent } from "../helpers/event-helpers";
import type { Page } from "../helpers/test-fixtures";

/**
 * The memory-analysis commands against the hello_c fixture's own globals:
 * the value scanner (first scan + next scan after a write), the byte-pattern
 * memory search, dereferencing a pointer chain and the pointer scanner.
 * Everything here goes through the OOB client over the paused target, the
 * same path on Windows and Linux.
 */

/** VA of a symbol in hello_c, through the session's symbol search. */
async function symbolVa(page: Page, sessionId: string, name: string): Promise<bigint> {
  return BigInt(await waitForSymbolVa(page, sessionId, "hello_c", name));
}

const hex = (v: bigint) => `0x${v.toString(16)}`;

test.describe("Memory analysis", () => {
  test("value scan, memory search, dereference and pointer scan find the fixture's globals", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Memory Scan", `${fixtureExe("hello_c")} memscan`);
    try {
      await waitForPaused(page, sessionId);
      await waitForModuleSymbols(page, sessionId, "hello_c", { minSymbolCount: 1, timeout: 20_000 });
      const wordVa = await symbolVa(page, sessionId, "g_word"); // union Word g_word = { 7 }
      const shapeVa = await symbolVa(page, sessionId, "g_shape"); // struct Shape; .name at +16 -> "shape"
      await installEventCapture(page, [
        "scan-memory-start-result", "scan-memory-next-result", "scan-memory-results", "scan-memory-error",
        "memory-search-result", "memory-search-error",
        "dereference-updated", "dereference-error",
        "pointer-scan-start-result", "pointer-scan-results", "pointer-scan-error",
      ]);

      // --- Value scan: every writable U32 equal to 7 includes g_word. ---
      await invoke(page, "request_scan_memory_start", {
        sessionId, valueType: "U32", compareType: "Exact", value: "7", value2: null,
        alignment: 4, floatTolerance: null, writableOnly: true,
      });
      const start = await waitForCapturedEvent(page, "scan-memory-start-result", (p) => p.session_id === sessionId, 30_000);
      const scanId: number = start.scan_id;
      expect(start.match_count).toBeGreaterThan(0);
      const page1 = await (async () => {
        await invoke(page, "request_scan_memory_get_results", { sessionId, scanId, offset: 0, count: 100000 });
        return waitForCapturedEvent(page, "scan-memory-results", (p) => p.session_id === sessionId && p.scan_id === scanId, 30_000);
      })();
      expect((page1.addresses as string[]).map((a) => BigInt(a))).toContain(wordVa);

      // Change the value in the target and narrow the scan: g_word survives,
      // the unrelated 7s drop out.
      await invoke(page, "request_memory_write", { sessionId, address: Number(wordVa), data: [9, 0, 0, 0] });
      await invoke(page, "request_scan_memory_next", {
        sessionId, scanId, valueType: "U32", compareType: "Exact", value: "9", value2: null, floatTolerance: null,
      });
      const next = await waitForCapturedEvent(page, "scan-memory-next-result", (p) => p.session_id === sessionId, 30_000);
      expect(next.match_count).toBeGreaterThan(0);
      await invoke(page, "request_scan_memory_get_results", { sessionId, scanId, offset: 0, count: 1000 });
      const page2 = await waitForCapturedEvent(page, "scan-memory-results", (p) => p.session_id === sessionId && p.scan_id === scanId && (p.addresses as string[]).some((a) => BigInt(a) === wordVa), 30_000);
      expect((page2.addresses as string[]).map((a) => BigInt(a))).toContain(wordVa);
      expect(page2.total_count).toBeLessThanOrEqual(page1.total_count);
      await invoke(page, "request_scan_memory_reset", { sessionId, scanId });

      // --- Memory search: the fixture's marker string lives in its image. ---
      const needle = Array.from(Buffer.from("hello_c_marker result"));
      await invoke(page, "request_memory_search", { sessionId, pattern: needle, maxResults: 100 });
      const search = await waitForCapturedEvent(page, "memory-search-result", (p) => p.session_id === sessionId, 30_000);
      const base = BigInt((await moduleBase(page, sessionId, "hello_c"))!);
      const found = (search.addresses as string[]).map((a) => BigInt(a));
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((a) => a >= base && a < base + 0x100000n), "a hit inside hello_c").toBe(true);

      // --- Dereference: g_shape.name is a pointer to the "shape" string. ---
      const nameSlot = shapeVa + 16n;
      await invoke(page, "request_dereference", { sessionId, address: hex(nameSlot), count: 1 });
      const deref = await waitForCapturedEvent(page, "dereference-updated", (p) => p.session_id === sessionId && BigInt(p.base_address) === nameSlot, 30_000);
      const chain = deref.entries[0].chain as { type: string; address?: string; value?: string }[];
      expect(chain[0].type).toBe("Pointer");
      expect(chain.some((c) => c.type === "String" && (c.value ?? "").includes("shape")), JSON.stringify(chain)).toBe(true);
      const stringVa = BigInt(chain[0].address!);

      // --- Pointer scan: who points at the "shape" string? g_shape.name. ---
      // All readable regions: the string sits in read-only data, and a scan
      // limited to writable memory treats a value outside its regions as not
      // a pointer at all.
      await invoke(page, "request_pointer_scan_start", {
        sessionId, targetAddress: Number(stringVa), maxOffset: 0x100, maxDepth: 1, maxResults: null, modules: null, writableOnly: false,
      });
      const pstart = await waitForCapturedEvent(page, "pointer-scan-start-result", (p) => p.session_id === sessionId, 60_000);
      expect(pstart.match_count).toBeGreaterThan(0);
      await invoke(page, "request_pointer_scan_get_results", { sessionId, resultsPath: pstart.results_path, offset: 0, count: 200, offsetFilter: [] });
      const paths = await waitForCapturedEvent(page, "pointer-scan-results", (p) => p.session_id === sessionId, 30_000);
      const viaShape = (paths.paths as { module_base: string; base_offset: string; offsets: string[] }[]).some((p) => {
        const slot = BigInt(p.module_base) + BigInt(p.base_offset);
        return slot === nameSlot || (slot === shapeVa && p.offsets.length === 1 && BigInt(p.offsets[0]) === 16n);
      });
      expect(viaShape, JSON.stringify(paths.paths.slice(0, 5))).toBe(true);
      await invoke(page, "request_pointer_scan_reset", { sessionId, resultsPath: pstart.results_path });
    } finally {
      await restoreDefaultSettings(page);
      await cleanupSession(page, sessionId);
    }
  });
});
