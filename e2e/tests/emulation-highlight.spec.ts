import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW, PC_ROW } from "../helpers/selectors";

const EXECUTED_ROW = `${ASM_ROW}[data-highlight="executed"]`;
const GHOST_PC_ROW = `${ASM_ROW}[data-highlight="ghost-pc"]`;
const ROW_TRACE = `${ASM_PANEL} [data-testid="asm-row-trace"]`;
const TRACE_LISTING_ROW = `${ASM_PANEL} [data-testid="emulation-trace-row"]`;

test.describe("Emulation", () => {
  test("lightning trace annotates the disassembly on every pause", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    // The fixture disables lightning for every other spec; this one tests it.
    await page.evaluate(() => localStorage.removeItem("assembly-lightning-disabled"));

    try {
      const sessionId = await createAndStartSession(page, "Emu Lightning");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // The lightning run fires by itself (no footer interaction): executed
      // rows get the coverage tint and per-row annotations.
      await expect(page.locator(EXECUTED_ROW).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(ROW_TRACE).first()).toHaveText(/\S/, { timeout: 10_000 });

      // The PC row keeps its PC highlight — the executed wash must never win
      // over it. (The trace may or may not include the PC address itself: at
      // an initial breakpoint the emulator starts from the thread's RIP,
      // which is already past the int3.)
      await expect(page.locator(PC_ROW)).toHaveCount(1);

      // Where the run stopped is marked as a ghost PC. It may sit beyond the
      // loaded window, so accept 0 or 1 — but never more than one.
      expect(await page.locator(GHOST_PC_ROW).count()).toBeLessThanOrEqual(1);

      // The "…" menu switches lightning off (annotations vanish at once) and
      // back on (a fresh run re-annotates).
      const panel = page.locator(ASM_PANEL);
      await panel.getByTestId("asm-more-menu").click();
      await page.getByTestId("asm-lightning-toggle").click();
      await expect(page.locator(EXECUTED_ROW)).toHaveCount(0);
      await expect(page.locator(ROW_TRACE)).toHaveCount(0);

      await panel.getByTestId("asm-more-menu").click();
      await page.getByTestId("asm-lightning-toggle").click();
      await expect(page.locator(EXECUTED_ROW).first()).toBeVisible({ timeout: 30_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("quick emulation probes toggle independently", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    // Nothing asserted here depends on trace length, so keep each probe's
    // emulation short rather than running the 10,000-instruction default.
    await page.evaluate(() =>
      localStorage.setItem("assembly-quick-emulation-max-instructions", "200"),
    );

    try {
      const sessionId = await createAndStartSession(page, "Emu Toggles");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const panel = page.locator(ASM_PANEL);
      const syscallToggle = panel.getByTestId("emu-toggle-syscall");
      const moduleToggle = panel.getByTestId("emu-toggle-module");
      const instructionsToggle = panel.getByTestId("emu-toggle-instructions");
      const syscallRow = panel.getByTestId("emu-row-syscall");
      const moduleRow = panel.getByTestId("emu-row-module");

      // All probes start off: no summary rows, no listing.
      await expect(syscallRow).toHaveCount(0);
      await expect(moduleRow).toHaveCount(0);
      await expect(page.locator(TRACE_LISTING_ROW)).toHaveCount(0);

      // Syscall alone.
      await syscallToggle.click();
      await expect(syscallToggle).toHaveAttribute("aria-pressed", "true");
      await expect(syscallRow).toBeVisible();
      await expect(syscallRow).not.toContainText("...", { timeout: 30_000 });
      await expect(moduleRow).toHaveCount(0);

      // Instructions adds the table (header + rows) without touching the others.
      await instructionsToggle.click();
      await expect(page.locator(TRACE_LISTING_ROW).first()).toBeVisible({ timeout: 30_000 });
      for (const col of ["index", "address", "asm", "values"]) {
        await expect(panel.getByTestId(`emu-col-${col}`)).toBeVisible();
      }
      await expect(syscallRow).toBeVisible();
      await expect(moduleRow).toHaveCount(0);

      // Sub-mode cycles Per instruction → Basic blocks → Calls; Calls is a
      // view over the instruction trace, listing call/ret destinations.
      const modeButton = panel.getByRole("button", { name: "Per instruction" });
      await modeButton.click();
      await expect(panel.getByRole("button", { name: "Basic blocks" })).toBeVisible();
      await panel.getByRole("button", { name: "Basic blocks" }).click();
      await expect(panel.getByRole("button", { name: "Calls" })).toBeVisible();
      await expect(page.locator(TRACE_LISTING_ROW).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(TRACE_LISTING_ROW).first()).toContainText(/call|ret/);
      await panel.getByRole("button", { name: "Calls" }).click();
      await expect(panel.getByRole("button", { name: "Per instruction" })).toBeVisible();

      // Module adds its row.
      await moduleToggle.click();
      await expect(moduleRow).toBeVisible();
      await expect(moduleRow).not.toContainText("...", { timeout: 30_000 });

      // Turning syscall off removes only its row.
      await syscallToggle.click();
      await expect(syscallToggle).toHaveAttribute("aria-pressed", "false");
      await expect(syscallRow).toHaveCount(0);
      await expect(moduleRow).toBeVisible();
      await expect(page.locator(TRACE_LISTING_ROW).first()).toBeVisible();

      // Turning instructions off removes the listing; module stays.
      await instructionsToggle.click();
      await expect(page.locator(TRACE_LISTING_ROW)).toHaveCount(0);
      await expect(moduleRow).toBeVisible();

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
