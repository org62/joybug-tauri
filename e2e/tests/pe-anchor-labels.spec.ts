import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  goToWindow,
  fixtureExe,
  type BreakpointData,
  type ModuleData,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  goAndWaitForPause,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_LABEL_ROW } from "../helpers/selectors";

/**
 * A module's entry point and TLS callbacks are named by its PE headers even
 * when nothing names them in the symbols — and that is exactly when an
 * unlabelled disassembly row is least useful, because a "Module Entry"
 * breakpoint has just dropped the user there.
 *
 * The test reaches the no-symbols state the way a user would: unload the
 * module's symbols, then look at the address its entry-point breakpoint sits
 * on. The label must read `hello_c.EntryPoint` — the dot marking it as derived
 * from headers, not resolved from a PDB — and it must behave like any other
 * symbol, so the same name has to appear wherever an address is symbolized:
 * the disassembly, the call stack and the thread's start address.
 */
test.describe("PE anchor labels", () => {
  test.afterEach(async ({ tauriPage: page }) => {
    await restoreDefaultSettings(page);
  });

  test("entry point is labelled from the PE headers when symbols are gone", async ({
    tauriPage: page,
  }) => {
    // The fixture is not in System32, so the user-scope toggle is the one that
    // plants its entry-point row — which is where the entry address comes from.
    await configureMinimalStopSettings(page, { break_on_user_module_entry: true });
    const sessionId = await createAndStartSession(page, "PE Anchors", fixtureExe("hello_c"));
    try {
      await waitForPaused(page, sessionId);

      // The row is planted at ProcessCreated, before the initial break, and is
      // still armed here: the initial break is in ntdll, long before the image
      // entry runs.
      let entryAddress = 0;
      await expect(async () => {
        const session = await invoke(page, "get_debug_session", { sessionId });
        const row = (session.breakpoints as BreakpointData[]).find(
          (bp) => bp.group === "Module Entry" && bp.module_name.toLowerCase().includes("hello_c"),
        );
        expect(row, "entry-point breakpoint planted for the main image").toBeTruthy();
        entryAddress = row!.address;
      }).toPass({ timeout: 20_000, intervals: [50, 100] });

      const modules: ModuleData[] = await invoke(page, "get_session_modules", { sessionId });
      const main = modules.find((m) => m.name.toLowerCase().includes("hello_c"));
      expect(main, "main image is in the module list").toBeTruthy();

      await invoke(page, "unload_module_symbols", {
        sessionId,
        moduleBase: main!.base_address,
      });

      await goToWindow(page, "Disassembly");
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const goto = page.locator(ASM_PANEL).getByPlaceholder(/Address, symbol/);
      await goto.fill(`0x${entryAddress.toString(16)}`);
      await goto.press("Enter");

      await expect(
        page.locator(ASM_LABEL_ROW, { hasText: "hello_c.EntryPoint" }),
      ).toBeVisible({ timeout: 15_000 });

      // Run into the entry breakpoint so the pseudo-symbol has to stand in for
      // a real one on the two surfaces that name an address rather than a row.
      await goAndWaitForPause(page, sessionId);

      // Call stack: the innermost frame is the entry point itself. Without the
      // pseudo-symbol this frame reads `hello_c+0x2301`.
      await goToWindow(page, "Stack");
      await expect(
        page
          .locator('[data-testid="callstack-panel"] [data-testid="callstack-frame"]')
          .first(),
      ).toContainText("hello_c.EntryPoint", { timeout: 15_000 });

      // Threads panel: a process's first thread starts at the image entry point.
      await goToWindow(page, "Threads");
      await expect(
        page.locator('[data-testid="thread-row"]', { hasText: "hello_c.EntryPoint" }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
