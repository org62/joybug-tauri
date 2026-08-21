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
      // The chevron lives inside this input's wrapper; scoping through the
      // wrapper keeps it apart from the assemble editor's own history input.
      const trigger = page
        .locator(ASM_PANEL)
        .locator('[data-slot="history-input"]')
        .filter({ has: page.getByPlaceholder(/Address, symbol/) })
        .locator('[data-slot="history-trigger"]');

      // No history yet, so there is nothing to offer and no affordance for it.
      await expect(trigger).toHaveCount(0);

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

      // Idle ArrowDown opens the list on the newest value too — either arrow is
      // a recall gesture, so neither one merely toggles the list open.
      await input.press("ArrowDown");
      await expect(page.locator(DROPDOWN)).toBeVisible();
      await expect(input).toHaveValue(addrA);
      await input.press("Escape");
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      // The chevron browses instead: it opens the list and leaves the draft alone.
      await input.fill(addrB);
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(page.locator(DROPDOWN)).toBeVisible();
      await expect(input).toHaveValue(addrB);
      // Clicking it again closes the list.
      await trigger.click();
      await expect(page.locator(DROPDOWN)).toHaveCount(0);
      await expect(input).toHaveValue(addrB);

      // Clicking a row fills the input and closes the list (Enter would submit).
      await input.fill("");
      await input.press("ArrowDown");
      await page.locator(DROPDOWN).getByRole("button", { name: addrA }).click();
      await expect(input).toHaveValue(addrA);
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      // Submit B, then re-submit A: MRU order, deduped.
      await input.fill(addrB);
      await input.press("Enter");
      await input.fill(addrA);
      await input.press("Enter");
      await expectHistory([addrA, addrB]);

      // Combobox cycling: the highlight moves the way the key points, and the
      // list renders newest-first, so Down walks into older entries.
      await input.fill("");
      await input.press("ArrowUp");
      await expect(input).toHaveValue(addrA);
      await input.press("ArrowDown");
      await expect(input).toHaveValue(addrB);
      await input.press("ArrowUp");
      await expect(input).toHaveValue(addrA);
      // Past the newest entry is the draft that recall interrupted.
      await input.press("ArrowUp");
      await expect(input).toHaveValue("");
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      // The list does not wrap: ArrowDown at the oldest entry stays put.
      await input.press("ArrowDown");
      await expect(input).toHaveValue(addrA);
      await input.press("ArrowDown");
      await expect(input).toHaveValue(addrB);
      await input.press("ArrowDown");
      await expect(input).toHaveValue(addrB);
      await input.press("Escape");
      await expect(page.locator(DROPDOWN)).toHaveCount(0);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
