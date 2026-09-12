import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  closeWindow,
  goToWindow,
  invoke,
  pcRegister,
  type BreakpointData,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  getPcAddress,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

const GROUP = "pasted-e2e";

/**
 * Bulk breakpoints from a pasted list. Every line goes through the same
 * expression grammar as the toolbar's single-address box, so one list can mix
 * raw addresses, `module!symbol` names and register math — and a line that
 * doesn't resolve is skipped and reported by line number instead of costing the
 * user the rest of the list.
 */
test.describe("Breakpoints from a pasted list", () => {
  test.afterEach(async ({ tauriPage: page }) => {
    await restoreDefaultSettings(page);
  });

  test("mixed addresses, symbols and expressions apply; bad lines are skipped and reported", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    // Unique launch command: breakpoints persist keyed by it, so a shared one
    // would carry rows in from another spec (or a retry) and skew the count.
    const sessionId = await createAndStartSession(
      page,
      "BP List",
      `cmd.exe /c echo bp_list_${Date.now()}`,
    );
    try {
      await waitForPaused(page, sessionId);
      const [pc, pcReg] = await Promise.all([
        getPcAddress(page, sessionId),
        pcRegister(page, sessionId), // rip on x64, pc on ARM64
      ]);
      expect(pc).not.toBeNull();

      await goToWindow(page, "Breakpoints");
      await page.getByTestId("breakpoints-add-list").click();
      await expect(page.getByTestId("breakpoint-list-dialog")).toBeVisible();

      const pcHex = `0x${pc!.toString(16)}`;
      await page.getByTestId("breakpoint-list-input").fill(
        [
          "# a comment is ignored",
          "",
          pcHex,
          "ntdll!NtClose",
          `${pcReg}+0x20`,
          pcHex, // duplicate of line 3 — collapsed, not an error
          "not_a_real_symbol_e2e",
        ].join("\n"),
      );
      await page.getByTestId("breakpoint-list-group").fill(GROUP);
      // Blank lines and the comment are not entries; the other six are.
      await expect(page.getByTestId("breakpoint-list-dialog")).toContainText("5 entries");

      await page.getByTestId("breakpoint-list-apply").click();

      // The bad line keeps the dialog open with the reason next to its line
      // number, so it can be fixed rather than hunted for in a toast.
      const report = page.getByTestId("breakpoint-list-report");
      await expect(report).toBeVisible({ timeout: 20_000 });
      await expect(report).toContainText("Set 3 breakpoints");
      await expect(report).toContainText("1 duplicate line collapsed");
      const rejected = page.getByTestId("breakpoint-list-rejected");
      await expect(rejected).toHaveCount(1);
      await expect(rejected).toContainText("line 7");
      await expect(rejected).toContainText("not_a_real_symbol_e2e");

      // The three that did resolve are real, grouped breakpoints.
      await expect(async () => {
        const session = (await invoke(page, "get_debug_session", { sessionId })) as {
          breakpoints: BreakpointData[];
        };
        const grouped = session.breakpoints.filter((b) => b.group === GROUP);
        expect(grouped).toHaveLength(3);
        expect(grouped.map((b) => b.address)).toContain(pc);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // A clean list closes the dialog instead of reporting.
      await page.getByTestId("breakpoint-list-input").fill(`${pcReg}+0x40`);
      await page.getByTestId("breakpoint-list-apply").click();
      await expect(page.getByTestId("breakpoint-list-dialog")).toBeHidden({ timeout: 20_000 });
    } finally {
      await cleanupSession(page, sessionId);
      await closeWindow(page, "Breakpoints");
    }
  });
});
