import type { Locator } from "@playwright/test";
import { test, expect } from "../helpers/test-fixtures";
import { ASM_PANEL, ASM_ROW, PC_ROW } from "../helpers/selectors";
import { openPe } from "../helpers/pe-helpers";
import { fixtureExe } from "../helpers/session-helpers";

const ROW_TRACE = `${ASM_PANEL} [data-testid="asm-row-trace"]`;
const XREF_ROW = '[data-testid="pe-xref-row"]';
const IMPORT_ROW = '[data-testid="pe-import-row"]';

// A real PE32 with an import table the CRT startup calls through; every IAT
// entry the linker kept is referenced by code, so xrefs to an import exist.
const HELLO_C32 = () => fixtureExe("hello_c32");

/** First `0x…` token of a listing row: its address, formatted per the viewer's mode. */
async function rowAddress(row: Locator): Promise<string> {
  const text = await row.innerText();
  const m = text.match(/0x[0-9A-F]+/i);
  expect(m, `row has an address: ${text}`).not.toBeNull();
  return m![0];
}

test.describe("PE Viewer static analysis", () => {
  test("xrefs: the context menu picks a target, an import popover lists its call sites, rows navigate", async ({
    tauriPage: page,
  }) => {
    await openPe(page, HELLO_C32());

    // The Xrefs tab is part of the default layout.
    await expect(page.getByText("Xrefs", { exact: true }).first()).toBeVisible();

    // Right-click the first instruction → the Xrefs tab shows it as the target.
    const firstRow = page.locator(ASM_ROW).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    const entryAddr = await rowAddress(firstRow);
    await firstRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Xrefs to This Address" }).click();
    await expect(page.getByTestId("pe-xrefs-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pe-xrefs-target")).toHaveText(new RegExp(entryAddr, "i"));
    // The sweep finishes and reports a count (the entry point itself may well
    // have none — it is reached by the loader, not by code).
    await expect(page.getByTestId("pe-xrefs-count")).toHaveText(/^\d+$/, { timeout: 20_000 });

    // Imports: an IAT slot's address popover offers "Xrefs"; the slot of a
    // linked-in import is referenced by at least one `call/jmp [slot]`.
    await page.getByText("Structures", { exact: true }).first().click();
    // The page (and the tree's fold state) survives between tests, so only
    // expand the group when it is still collapsed.
    const importRows = page.locator(IMPORT_ROW);
    if (!(await importRows.first().isVisible())) {
      await page.getByText("Imports", { exact: false }).first().click();
    }
    await expect(importRows.first()).toBeVisible({ timeout: 10_000 });
    let referenced = false;
    const candidates = Math.min(await importRows.count(), 6);
    for (let i = 0; i < candidates && !referenced; i++) {
      await importRows.nth(i).locator("button").first().hover();
      await page.getByTestId("pe-addr-xrefs").click();
      await expect(page.getByTestId("pe-xrefs-count")).toHaveText(/^\d+$/, { timeout: 20_000 });
      referenced = parseInt(await page.getByTestId("pe-xrefs-count").innerText(), 10) > 0;
      if (!referenced) {
        await page.getByText("Structures", { exact: true }).first().click();
        await expect(importRows.first()).toBeVisible();
      }
    }
    expect(referenced, "some import is referenced from code").toBe(true);

    // Rows carry the referencing instruction and jump to it.
    const xref = page.locator(XREF_ROW).first();
    await expect(xref).toBeVisible();
    await expect(xref).toContainText(/call|jmp|mov|push|lea/i);
    const from = await rowAddress(xref);
    await xref.click();
    await expect(
      page.locator(ASM_ROW).filter({ hasText: new RegExp(from, "i") }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("emulate from here runs the file with no process and annotates the listing", async ({
    tauriPage: page,
  }) => {
    await openPe(page, HELLO_C32());

    const panel = page.locator(ASM_PANEL);
    const firstRow = page.locator(ASM_ROW).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    const origin = await rowAddress(firstRow);
    await firstRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Emulate from Here" }).click();

    // The origin plays the PC. Right-clicking selected it, and selection
    // outranks the PC tint, so move the selection to another row first.
    await page.locator(ASM_ROW).nth(3).click();
    await expect(page.locator(PC_ROW)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(PC_ROW)).toContainText(new RegExp(origin, "i"));

    // The fixture disables lightning for every other spec, and the PE page was
    // already mounted with that setting, so switch it on through the "…" menu
    // (the toggle only exists once the emulation footer is up).
    await panel.getByTestId("asm-more-menu").click();
    const lightningToggle = page.getByTestId("asm-lightning-toggle");
    await expect(lightningToggle).toBeVisible();
    if ((await lightningToggle.getAttribute("data-state")) !== "checked") {
      await lightningToggle.click();
    } else {
      await page.keyboard.press("Escape");
    }
    // The lightning run annotates the rows it executed. The CRT entry calls
    // away on its first instruction, so the origin row is the one in view
    // that ran: it keeps the PC tint (which outranks "executed") but carries
    // the per-row trace annotation.
    await expect(page.locator(ROW_TRACE).first()).toHaveText(/\S/, { timeout: 30_000 });
    // Anything else the run touched in view is tinted as executed — 0 or more
    // rows; never the PC row, which must keep its own highlight.
    await expect(page.locator(PC_ROW)).toHaveCount(1);

    // The module probe stops where the image is left: at the first import
    // call, reported as "dll!Function".
    // (The probe toggles live in the still-mounted page too: switch on only
    // when off.)
    const moduleToggle = panel.getByTestId("emu-toggle-module");
    if ((await moduleToggle.getAttribute("aria-pressed")) !== "true") {
      await moduleToggle.click();
    }
    const moduleRow = panel.getByTestId("emu-row-module");
    await expect(moduleRow).toBeVisible();
    await expect(moduleRow).not.toContainText("...", { timeout: 30_000 });
    await expect(moduleRow).toContainText(/\w+!\w+/);
  });
});
