import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, fixtureExe } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
  goAndWaitForPause,
  waitForStatus,
  setArmedBreakpoint,
} from "../helpers/wait-helpers";
import { installEventCapture, getCapturedEvents, waitForCapturedEvent } from "../helpers/event-helpers";

interface WatchpointAccessRow {
  accessor: string;
  raw_rip: string;
  symbol: string | null;
  disasm: string | null;
  hit_count: number;
  first_seq: number;
  thread_ids: number[];
}

// The core silent-collect behavior is proven by the joybug2 jlua test
// (tests/lua/breakpoints/watchpoint_trace.lua). This spec verifies the Tauri
// command wiring + breakpoint model end to end through the real backend:
// arm → the target runs freely and collects accessors → poll → stop retains
// nothing server-side. Uses the watch_c fixture, whose access_loop reads/writes
// g_watch_target in a loop.
test.describe("Access Trace (hardware watchpoint)", () => {
  test("collects what reads/writes an address, then stops", async ({ tauriPage: page }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Access Trace", fixtureExe("watch_c"));
    try {
      await waitForPaused(page, sessionId);
      await installEventCapture(page, ["symbols-updated", "breakpoints-updated"]);

      // Resolve a symbol's VA, polling the symbol search until the exe's PDB has
      // finished loading in the background.
      const resolveVa = async (pattern: string): Promise<string> => {
        let va = "";
        await expect(async () => {
          await invoke(page, "search_session_symbols", { sessionId, pattern, limit: 20 });
          const events = await getCapturedEvents(page, "symbols-updated");
          const hit = events
            .flatMap((e: any) => e.symbols ?? [])
            .find((s: any) => typeof s.name === "string" && s.name.includes(pattern) && s.va);
          expect(hit, `${pattern} symbol should resolve`).toBeTruthy();
          va = hit.va;
        }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
        return va;
      };

      // Arm the watchpoint at a normal code breakpoint INSIDE the process (as the
      // jlua test does), not at the very early initial system breakpoint — debug
      // registers armed that early don't reliably stick to the thread that later
      // runs the loop. Break at access_loop's entry, then arm on the global.
      const loopVa = await resolveVa("access_loop");
      // Confirm the breakpoint is armed before continuing — arming otherwise
      // races the resume and the target can run past access_loop's entry.
      await setArmedBreakpoint(page, sessionId, loopVa);
      await goAndWaitForPause(page, sessionId, 20_000);

      const watchAddr = await resolveVa("g_watch_target");
      await invoke(page, "start_watchpoint_trace", {
        sessionId,
        address: watchAddr,
        hwType: "ReadWrite",
        hwSize: 4,
      });

      // A watchpoint breakpoint appears in the model, armed (the UI derives
      // "tracing" from bp_kind === "watchpoint" && is_active).
      const bpEvent = await waitForCapturedEvent(
        page,
        "breakpoints-updated",
        (p: any) => p.session_id === sessionId && (p.breakpoints ?? []).some((b: any) => b.bp_kind === "watchpoint"),
        10_000,
      );
      const wp = bpEvent.breakpoints.find((b: any) => b.bp_kind === "watchpoint");
      expect(wp.hw_type).toBe("ReadWrite");
      expect(wp.hw_size).toBe(4);
      expect(wp.is_active).toBe(true);

      // Run: the target executes access_loop freely (the watchpoint must NOT break
      // in) and reaches the Sleep, staying alive as "Running".
      await continueSession(page, sessionId);
      await waitForStatus(page, sessionId, "Running", 15_000);

      // Poll until accessors are collected. The loop reads and writes the global,
      // so at least one distinct accessing instruction with a positive hit count
      // must appear.
      let rows: WatchpointAccessRow[] = [];
      await expect(async () => {
        rows = (await invoke(page, "poll_watchpoint_accesses", { sessionId, address: watchAddr })) as WatchpointAccessRow[];
        expect(rows.length, "at least one accessor collected").toBeGreaterThan(0);
      }).toPass({ timeout: 20_000, intervals: [100, 200, 400] });

      // Collected rows are well-formed: real instruction address, resolved
      // disassembly, and repeated hits from the loop.
      const first = rows[0];
      expect(parseInt(first.accessor, 16)).toBeGreaterThan(0);
      expect(first.disasm && first.disasm.length).toBeTruthy();
      const totalHits = rows.reduce((n, r) => n + r.hit_count, 0);
      expect(totalHits, "loop should produce repeated accesses").toBeGreaterThanOrEqual(2);

      // Stop the trace: the server-side accessors are cleared (the UI keeps its
      // last poll). A fresh poll returns nothing.
      await invoke(page, "stop_watchpoint_trace", { sessionId, breakpointId: wp.id });
      await expect(async () => {
        const after = (await invoke(page, "poll_watchpoint_accesses", { sessionId, address: watchAddr })) as WatchpointAccessRow[];
        expect(after.length).toBe(0);
      }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });

      // Teardown stops/deletes the session while the target is still running —
      // this also regression-guards that stopping a running session is prompt
      // (terminates the target, doesn't hang on background OOB polls).
    } finally {
      await restoreDefaultSettings(page);
      await cleanupSession(page, sessionId);
    }
  });
});
