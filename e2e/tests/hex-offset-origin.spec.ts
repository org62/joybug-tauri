import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
} from "../helpers/session-helpers";
import { waitForPaused } from "../helpers/wait-helpers";

/**
 * The hex view's offset origin: double-clicking a row's address in the gutter
 * makes every address render as a signed distance from it, and double-clicking
 * that same row again puts absolute addresses back.
 *
 * The origin lives in a module-level Map in useHexEditor that survives the whole
 * suite (the page is never reloaded) — but it is keyed by session id, and each
 * spec creates its own session, so nothing leaks between specs. Don't "fix" that
 * by reaching for a reset here.
 */
const HEX_PANEL = '[data-testid="hex-panel"]';
const HEX_ADDRESS = '[data-testid="hex-address"]';
const OFFSET_ORIGIN = '[data-testid="hex-offset-origin"]';

test.describe("Hex offset origin", () => {
  test("double-clicking an address measures the gutter from it", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(60_000);

    const sessionId = await createAndStartSession(page, "Hex Offset Origin");
    try {
      await waitForPaused(page, sessionId);
      await goToWindow(page, "Memory");

      // The view opens empty; give it an address so there are rows to click.
      // Scope to the visible panel: rc-dock keeps hidden panels mounted, and
      // the disassembly view has an identical address input.
      const memPanel = page
        .locator(".absolute.inset-0", { hasText: "No memory loaded" })
        .filter({ visible: true })
        .last();
      const gotoInput = memPanel.getByPlaceholder(/^Address/);
      await gotoInput.waitFor({ state: "visible", timeout: 10_000 });
      await gotoInput.fill("rsp");
      await gotoInput.press("Enter");

      const hex = page.locator(HEX_PANEL);
      await expect(hex).toBeVisible({ timeout: 15_000 });
      const gutter = hex.locator(HEX_ADDRESS);
      const header = hex.locator("span").filter({ hasText: /^(Address|Offset)$/ }).first();
      const originLabel = hex.locator(OFFSET_ORIGIN);

      await expect(async () => {
        expect(await gutter.count()).toBeGreaterThan(4);
      }).toPass({ timeout: 15_000, intervals: [50, 100] });

      // --- Absolute by default ------------------------------------------------
      await expect(header).toHaveText("Address");
      await expect(originLabel).toHaveCount(0);
      const absolute = (await gutter.first().innerText()).trim();
      expect(absolute).toMatch(/^0x[0-9A-F]{16}$/);

      // --- Set the origin -----------------------------------------------------
      // Identify the row by its address, not its index: the list is virtualized
      // and finishes scrolling to the goto target asynchronously, so which rows
      // are mounted at which index keeps changing for a moment after the read.
      const targetAddress = await gutter.nth(2).getAttribute("data-address");
      const originRow = hex.locator(`${HEX_ADDRESS}[data-address="${targetAddress}"]`);
      const originAbsolute = (await originRow.innerText()).trim();

      await originRow.dblclick();

      await expect(originRow).toHaveText("0x0", { timeout: 10_000 });
      await expect(header).toHaveText("Offset");
      await expect(originLabel).toHaveText(`relative to ${originAbsolute}`);

      // Neighbours read as one row's distance either side of the origin.
      const offsets = (await gutter.allInnerTexts()).map((t) => t.trim());
      const zeroAt = offsets.indexOf("0x0");
      expect(offsets.filter((t) => t === "0x0")).toHaveLength(1);
      expect(offsets[zeroAt - 1]).toBe("-0x10");
      expect(offsets[zeroAt + 1]).toBe("+0x10");
      expect(offsets.every((t) => /^(0x0|[-+]0x[0-9A-F]+)$/.test(t))).toBe(true);

      // --- Clear it -----------------------------------------------------------
      await originRow.dblclick();

      await expect(originRow).toHaveText(originAbsolute, { timeout: 10_000 });
      await expect(header).toHaveText("Address");
      await expect(originLabel).toHaveCount(0);
    } finally {
      await cleanupSession(page, sessionId);
      // The Memory tab this spec opened would otherwise stay open for every
      // later spec, mounting its view (and its fetches) before they start.
      await page.getByRole("main").getByRole("button", { name: "Windows" }).click();
      await page.getByRole("menuitem", { name: "Reset Layout" }).click();
      await page.keyboard.press("Escape");
    }
  });
});
