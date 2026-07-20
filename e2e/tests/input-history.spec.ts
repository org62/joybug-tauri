import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  getPcAddress,
} from "../helpers/wait-helpers";
import { ASM_PANEL } from "../helpers/selectors";

const DROPDOWN = '[data-slot="history-dropdown"]';
const STORAGE_KEY = "input-history:disasm-goto";

test.describe("Input History", () => {
  test("goto input records submissions and recalls them with arrows", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    const expectHistory = (expected: string[]) =>
      expect(async () => {
        const stored = await page.evaluate(
          (k) => localStorage.getItem(k),
          STORAGE_KEY,
        );
        expect(JSON.parse(stored ?? "[]")).toEqual(expected);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

    try {
      const sessionId = await createAndStartSession(page, "Input History");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Use real addresses near the PC so both submissions resolve and navigate.
      const pc = await getPcAddress(page, sessionId);
      expect(pc).not.toBeNull();
      const addrA = "0x" + pc!.toString(16);
      const addrB = "0x" + (pc! + 8).toString(16);

      const input = page.locator(ASM_PANEL).getByPlaceholder(/Address, symbol/);

      // Submit A — the expression lands in history (push happens on successful parse).
      await input.fill(addrA);
      await input.press("Enter");
      await expectHistory([addrA]);

      // ArrowUp on a cleared input recalls the last submission and opens the dropdown.
      await input.fill("");
      await input.press("ArrowUp");
      await expect(input).toHaveValue(addrA);
      await expect(page.locator(DROPDOWN)).toBeVisible();
      await expect(
        page.locator(DROPDOWN).getByRole("button", { name: addrA }),
      ).toBeVisible();

      // Escape restores the draft (empty) and closes the dropdown, without
      // bubbling to any host Escape handling.
      await input.press("Escape");
      await expect(input).toHaveValue("");
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      // Idle ArrowDown opens the dropdown in browse mode: list visible, draft untouched.
      await input.press("ArrowDown");
      await expect(page.locator(DROPDOWN)).toBeVisible();
      await expect(input).toHaveValue("");

      // Clicking a row fills the input and closes the list (Enter would submit).
      await page.locator(DROPDOWN).getByRole("button", { name: addrA }).click();
      await expect(input).toHaveValue(addrA);
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      // Submit B, then re-submit A: MRU order, deduped.
      await input.fill(addrB);
      await input.press("Enter");
      await input.fill(addrA);
      await input.press("Enter");
      await expectHistory([addrA, addrB]);

      // Shell-style cycling: Up→A, Up→B (older), Down→A, Down→draft + closed.
      await input.fill("");
      await input.press("ArrowUp");
      await expect(input).toHaveValue(addrA);
      await input.press("ArrowUp");
      await expect(input).toHaveValue(addrB);
      await input.press("ArrowDown");
      await expect(input).toHaveValue(addrA);
      await input.press("ArrowDown");
      await expect(input).toHaveValue("");
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
