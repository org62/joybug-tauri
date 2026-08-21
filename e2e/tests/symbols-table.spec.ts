import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  invoke,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

interface SymbolStatus {
  module_path: string;
  status: string;
}

/**
 * Read the symbol names, in render order. `data-full-text` rather than the
 * rendered text: the cell middle-truncates to fit, and two names sharing a long
 * prefix can truncate to the same string — which would make a sort assertion
 * on the visible text meaningless.
 */
async function names(page: import("@playwright/test").Page): Promise<string[]> {
  return page
    .getByTestId("symbol-name")
    .evaluateAll((nodes) =>
      nodes.map((n) => (n.getAttribute("data-full-text") ?? n.textContent ?? "").trim()),
    );
}

/** Read the displayed addresses, in render order. */
async function addresses(page: import("@playwright/test").Page): Promise<bigint[]> {
  const texts = await page.getByTestId("symbol-address").allTextContents();
  return texts.map((t) => BigInt(t.trim()));
}

test.describe("Symbols table", () => {
  test("multi-token search, sortable and resizable columns", async ({
    tauriPage: page,
  }) => {
    // Cold ntdll PDB download can be slow.
    test.setTimeout(180_000);
    await configureMinimalStopSettings(page);

    let sessionId = "";
    try {
      sessionId = await createAndStartSession(page, "Symbols Table");
      await waitForPaused(page, sessionId);

      // ntdll symbols load in the background — the search needs them to resolve hits.
      await expect(async () => {
        const statuses = (await invoke(page, "get_session_symbol_status", {
          sessionId,
        })) as SymbolStatus[];
        const ntdll = statuses.find((s) =>
          s.module_path.toLowerCase().includes("ntdll"),
        );
        expect(ntdll?.status).toBe("loaded");
      }).toPass({ timeout: 60_000, intervals: [250, 500] });

      // Panel sizes carry over between specs (the page is never reloaded), and
      // the resize step below drags a grip that sits at the right edge of the
      // Address column — a left column narrowed by an earlier spec would clip it
      // out of view and the drag would land on whatever is behind it. Reset to
      // the default layout so the panel's width is deterministic.
      await page.getByRole("button", { name: "Windows" }).click();
      await page.getByRole("menuitem", { name: "Reset Layout" }).click();
      await page.keyboard.press("Escape");

      await goToWindow(page, "Symbols");
      const search = page.getByPlaceholder("Search symbols...");
      await search.waitFor({ state: "visible" });

      // --- Multi-token search -------------------------------------------------
      // Tokens are ANDed and order-independent, so the parts of the name may be
      // typed backwards.
      await search.fill("UnicodeString RtlInit");
      await expect(async () => {
        expect((await names(page)).some((n) => n.includes("RtlInitUnicodeString"))).toBe(true);
      }).toPass({ timeout: 20_000, intervals: [100, 250] });

      // A token may match the module name instead of the symbol name.
      await search.fill("ntdll LdrLoadDl");
      await expect(async () => {
        expect((await names(page)).some((n) => n.includes("LdrLoadDll"))).toBe(true);
      }).toPass({ timeout: 20_000, intervals: [100, 250] });

      // Every token has to match: one unmatchable token excludes everything.
      await search.fill("LdrLoadDll zzznosuchtoken");
      await expect(page.getByText("No symbols found")).toBeVisible({ timeout: 20_000 });

      // --- Sorting ------------------------------------------------------------
      // A term with enough hits for the order to be meaningful.
      await search.fill("NtCreate");
      const header = page.getByTestId("symbols-header");
      await expect(header).toBeVisible({ timeout: 20_000 });
      await expect(async () => {
        expect((await addresses(page)).length).toBeGreaterThan(3);
      }).toPass({ timeout: 20_000, intervals: [100, 250] });

      const addressHeader = header.getByRole("button", { name: "Address" });
      await addressHeader.click();
      await expect(async () => {
        const addrs = await addresses(page);
        expect(addrs.length).toBeGreaterThan(3);
        expect(addrs).toEqual([...addrs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // Clicking the active column flips the direction.
      await addressHeader.click();
      await expect(async () => {
        const addrs = await addresses(page);
        expect(addrs.length).toBeGreaterThan(3);
        expect(addrs).toEqual([...addrs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // A new column sorts ascending.
      await header.getByRole("button", { name: "Symbol" }).click();
      await expect(async () => {
        const shown = await names(page);
        expect(shown.length).toBeGreaterThan(3);
        const lowered = shown.map((n) => n.toLowerCase());
        expect(lowered).toEqual([...lowered].sort());
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // --- Column resize ------------------------------------------------------
      const widthsKey = "symbolsView.columnWidths";
      const grip = header.locator(".cursor-col-resize").first();
      let box = await grip.boundingBox();
      // The grip is a 4px strip at the column's right edge — assert it is really
      // the hit target before dragging, so a layout problem fails here with an
      // obvious message instead of as a silent no-op drag.
      await expect(async () => {
        box = await grip.boundingBox();
        expect(box).not.toBeNull();
        const onTop = await page.evaluate(
          ([x, y]: [number, number]) =>
            document.elementFromPoint(x, y)?.classList.contains("cursor-col-resize") ?? false,
          [box!.x + box!.width / 2, box!.y + box!.height / 2] as [number, number],
        );
        expect(onTop).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2, { steps: 5 });
      await page.mouse.up();

      // Persisted on drag end, and applied to the rows.
      await expect(async () => {
        const saved = await page.evaluate(
          (key: string) => localStorage.getItem(key),
          widthsKey,
        );
        expect(saved).not.toBeNull();
        expect(JSON.parse(saved!).address).toBeGreaterThan(190);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      const cellBox = await page.getByTestId("symbol-address").first().boundingBox();
      expect(cellBox!.width).toBeGreaterThan(190);

      // The width survives a fresh search (it is read back from localStorage).
      await search.fill("LdrLoadDl");
      await expect(async () => {
        const again = await page.getByTestId("symbol-address").first().boundingBox();
        expect(again!.width).toBeGreaterThan(190);
      }).toPass({ timeout: 20_000, intervals: [100, 250] });

      // --- Result limit + bulk guard -----------------------------------------
      // "nt" matches ntdll by module name, so this is well past the old 1000 cap.
      await search.fill("nt");
      const countText = page.getByText(/[\d,]+ found/);
      await expect(countText).toBeVisible({ timeout: 40_000 });
      await expect(async () => {
        const label = (await countText.textContent()) ?? "";
        const found = parseInt(label.replace(/[^\d]/g, ""), 10);
        expect(found).toBeGreaterThan(1000);
      }).toPass({ timeout: 40_000, intervals: [250, 500] });

      // Selecting them all and applying breakpoints must ask first rather than
      // silently arming thousands of them.
      await page.getByRole("button", { name: "Select All" }).click();
      await page.getByRole("button", { name: /^Set Breakpoints/ }).click();
      const confirm = page.getByRole("dialog");
      await expect(confirm).toBeVisible({ timeout: 10_000 });
      await expect(confirm.getByText(/Set [\d,]+ breakpoints\?/)).toBeVisible();
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toBeHidden({ timeout: 10_000 });

      // Nothing was armed.
      const session = (await invoke(page, "get_debug_session", { sessionId })) as {
        breakpoints: unknown[];
      };
      expect(session.breakpoints.length).toBe(0);

      // --- Search history -----------------------------------------------------
      // Enter is the commit gesture: it records the term and searches without
      // waiting out the debounce.
      await page.getByRole("button", { name: "Clear" }).click();
      await search.fill("LdrLoadDl");
      await search.press("Enter");
      await expect(async () => {
        const stored = await page.evaluate(() =>
          localStorage.getItem("input-history:symbol-search"),
        );
        expect(JSON.parse(stored ?? "[]")).toEqual(["LdrLoadDl"]);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });

      // ArrowUp on a cleared field recalls it and the results come back with it.
      await search.fill("");
      await search.press("ArrowUp");
      await expect(search).toHaveValue("LdrLoadDl");
      await expect(page.locator('[data-slot="history-dropdown"]')).toBeVisible();
      await search.press("Escape");
      await expect(page.locator('[data-slot="history-dropdown"]')).toHaveCount(0);
      await search.fill("LdrLoadDl");
      await expect(async () => {
        expect((await names(page)).some((n) => n.includes("LdrLoadDll"))).toBe(true);
      }).toPass({ timeout: 20_000, intervals: [100, 250] });
    } finally {
      // The page is never reloaded between specs, so a history entry left here
      // would follow the suite around.
      await page.evaluate(() => localStorage.removeItem("input-history:symbol-search"));
      await restoreDefaultSettings(page);
      if (sessionId) await cleanupSession(page, sessionId);
    }
  });
});
