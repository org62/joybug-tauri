import { writeFileSync } from "fs";
import path from "path";
import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  goToWindow,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
  getPcAddress,
  setArmedBreakpoint,
} from "../helpers/wait-helpers";
import { ASM_PANEL } from "../helpers/selectors";
// The literal the panels render — imported so the test can't drift from the UI.
import { NO_PROCESS_HINT } from "../../src/components/ui/empty-state";

type Page = import("@playwright/test").Page;

const dataFile = (name: string) =>
  process.env.JOYBUG_E2E_DATA_DIR
    ? path.join(process.env.JOYBUG_E2E_DATA_DIR, name)
    : path.join(process.env.LOCALAPPDATA || "", "JoybugTauri", name);


async function session(page: Page, sessionId: string): Promise<any> {
  return invoke(page, "get_debug_session", { sessionId });
}

/**
 * What "Stopped" means across the UI (see the policy table in
 * src/lib/sessionHelpers.ts): live views clear to a neutral state — never a red
 * error box or a toast — while persisted config (breakpoints, bookmarks) stays
 * visible and metadata-editable through a state-only backend path.
 */
test.describe("Session stopped", () => {
  test.beforeEach(() => {
    for (const f of ["breakpoints.json", "bookmarks.json"]) {
      try { writeFileSync(dataFile(f), "{}", "utf-8"); } catch { /* may not exist */ }
    }
  });

  test("process exit with no exit break shows neutral panels, no error or toast", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(page, "Stopped Neutral", 'cmd.exe /c "exit /b 0"');
      await waitForPaused(page, sessionId);
      await goToWindow(page, "Disassembly");
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Run to completion: the session ends without a pause.
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      const asm = page.locator(ASM_PANEL).filter({ visible: true }).last();
      await expect(asm.getByText("Disassembly unavailable")).toBeVisible({ timeout: 10_000 });
      await expect(asm.getByText(NO_PROCESS_HINT)).toBeVisible();
      await expect(asm.getByText("Error loading disassembly")).toHaveCount(0);
      await expect(asm.locator(".text-syn-invalid")).toHaveCount(0);
      await expect(page.getByText(/Failed to request disassembly/)).toHaveCount(0);
      await expect(page.getByText(/Session is stopped/)).toHaveCount(0);

      // The goto box and refresh are disabled without a process.
      await expect(asm.getByPlaceholder(/^Address/)).toBeDisabled();

      // Other live panels show the same neutral state.
      await goToWindow(page, "Registers");
      await expect(page.getByText("Registers unavailable")).toBeVisible({ timeout: 10_000 });
      await goToWindow(page, "Stack");
      await expect(page.getByText("Call stack unavailable")).toBeVisible({ timeout: 10_000 });
      await goToWindow(page, "Memory");
      await expect(page.getByText("Memory unavailable").first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });

  test("breakpoints and bookmarks stay editable while stopped", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(page, "Stopped Edits");
      await waitForPaused(page, sessionId);

      const pcNum = await getPcAddress(page, sessionId);
      const pc = `0x${pcNum!.toString(16).toUpperCase()}`;
      await setArmedBreakpoint(page, sessionId, pc);
      await invoke(page, "add_bookmark", { sessionId, kind: "value", address: pc, valueType: "U32", name: "bm" });
      await expect(async () => {
        expect((await session(page, sessionId!)).bookmarks).toHaveLength(1);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Stop from Paused.
      await invoke(page, "stop_debug_session", { sessionId });
      await waitForStopped(page, sessionId);

      // Rows survive the stop, deactivated (the backend emits the list on exit).
      let s = await session(page, sessionId);
      expect(s.breakpoints).toHaveLength(1);
      expect(s.breakpoints[0].is_active).toBe(false);
      expect(s.bookmarks).toHaveLength(1);
      const bpId: string = s.breakpoints[0].id;
      const bmId: string = s.bookmarks[0].id;

      await goToWindow(page, "Breakpoints");
      const bpPanel = page.locator(".absolute.inset-0", { has: page.getByTestId("breakpoints-offline-hint") }).filter({ visible: true }).last();
      await expect(bpPanel.getByTestId("breakpoints-offline-hint")).toBeVisible({ timeout: 10_000 });
      await expect(bpPanel.getByPlaceholder(/^Address/)).toBeDisabled();

      // Metadata edits go through the state-only path: no error toast.
      await invoke(page, "update_breakpoint", { sessionId, breakpointId: bpId, name: "renamed", group: "g1" });
      await invoke(page, "enable_breakpoint", { sessionId, breakpointId: bpId, enabled: false });
      await expect(async () => {
        const bp = (await session(page, sessionId!)).breakpoints[0];
        expect(bp.name).toBe("renamed");
        expect(bp.group).toBe("g1");
        expect(bp.enabled).toBe(false);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      await expect(bpPanel.getByText("renamed")).toBeVisible({ timeout: 10_000 });

      await invoke(page, "update_bookmark", { sessionId, id: bmId, name: "bm2", comment: null, group: null, valueType: null });
      await expect(async () => {
        expect((await session(page, sessionId!)).bookmarks[0].name).toBe("bm2");
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Process-touching ops are refused as a benign state error, never crash.
      await expect(invoke(page, "set_bookmark_value", { sessionId, id: bmId, value: "1" })).rejects.toBeTruthy();
      await expect(page.getByText(/Failed to set bookmark value/)).toHaveCount(0);

      await invoke(page, "remove_bookmark", { sessionId, id: bmId });
      await expect(async () => {
        expect((await session(page, sessionId!)).bookmarks).toHaveLength(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Restart: the disabled breakpoint stays disabled (not re-armed).
      await invoke(page, "start_debug_session", { sessionId });
      await waitForPaused(page, sessionId);
      s = await session(page, sessionId);
      expect(s.breakpoints).toHaveLength(1);
      expect(s.breakpoints[0].enabled).toBe(false);
      expect(s.breakpoints[0].is_active).toBe(false);

      // Re-enable (with a process: real arm), remove while stopped after a
      // stop-from-Running, which must also deactivate the rows.
      await invoke(page, "enable_breakpoint", { sessionId, breakpointId: s.breakpoints[0].id, enabled: true });
      await expect(async () => {
        expect((await session(page, sessionId!)).breakpoints[0].is_active).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      // Go to exit: the session goes Running → Stopped with no pause between.
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);
      await expect(async () => {
        const bp = (await session(page, sessionId!)).breakpoints[0];
        expect(bp.is_active).toBe(false);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      await invoke(page, "remove_breakpoint", { sessionId, breakpointId: s.breakpoints[0].id });
      await expect(async () => {
        expect((await session(page, sessionId!)).breakpoints).toHaveLength(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
    } finally {
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });
});
