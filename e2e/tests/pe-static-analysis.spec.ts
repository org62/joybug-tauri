import type { Locator } from "../helpers/test-fixtures";
import { test, expect } from "../helpers/test-fixtures";
import { ASM_PANEL, ASM_ROW, PC_ROW, SELECTED_ROW } from "../helpers/selectors";
import { openPe, leafLink, pick } from "../helpers/pe-helpers";
import { fixtureExe, rowAddress } from "../helpers/session-helpers";

const ROW_TRACE = '[data-testid="asm-row-trace"]';
const XREF_ROW = '[data-testid="pe-xref-row"]';
const IMPORT_ROW = '[data-testid="pe-import-row"]';

// A real PE32 with an import table the CRT startup calls through; every IAT
// entry the linker kept is referenced by code, so xrefs to an import exist.
const HELLO_C32 = () => fixtureExe("hello_c32");

/** The first hex token in an xref row is its source VA when VA mode is selected. */
async function xrefSourceVa(row: Locator): Promise<bigint> {
  const text = await row.innerText();
  const m = text.match(/0x[0-9A-F]+/i);
  expect(m, `row has an address: ${text}`).not.toBeNull();
  return BigInt(m![0]);
}

test.describe("PE Viewer static analysis", () => {
  test("xrefs: the context menu picks a target, an import popover lists its call sites, rows navigate", async ({
    tauriPage: page,
  }) => {
    await openPe(page, HELLO_C32());
    await pick(page, "pe-addr-mode", "VA");
    const entryVa = (await leafLink(page, "AddressOfEntryPoint").innerText()).trim();

    // The Xrefs tab is part of the default layout.
    await expect(page.getByText("Xrefs", { exact: true }).first()).toBeVisible();

    // Right-click the instruction at the actual image entry.
    const entryRow = page.locator(`${ASM_ROW}[data-address="${rowAddress(BigInt(entryVa))}"]`);
    await expect(entryRow).toBeVisible({ timeout: 15_000 });
    await entryRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Xrefs to This Address" }).click();
    await expect(page.getByTestId("pe-xrefs-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("pe-xrefs-target")).toHaveText(entryVa);
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
    const from = await xrefSourceVa(xref);
    await xref.click();
    await expect(page.locator(SELECTED_ROW)).toHaveAttribute("data-address", rowAddress(from), { timeout: 10_000 });
  });

  test("emulate from here runs the file with no process and annotates the listing", async ({
    tauriPage: page,
  }) => {
    await openPe(page, HELLO_C32());
    await pick(page, "pe-addr-mode", "VA");

    const panel = page.locator(ASM_PANEL);
    const origin = rowAddress(BigInt((await leafLink(page, "AddressOfEntryPoint").innerText()).trim()));
    const entryRow = page.locator(`${ASM_ROW}[data-address="${origin}"]`);
    await expect(entryRow).toBeVisible({ timeout: 15_000 });
    await entryRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Emulate from Here" }).click();

    // The origin plays the PC. Right-clicking selected it, and selection
    // outranks the PC tint, so move the selection to another row first.
    const nextAddress = await page.locator(ASM_ROW).evaluateAll((rows, entry) => {
      const index = rows.findIndex((row) => row.dataset.address === entry);
      return index >= 0 ? rows[index + 1]?.dataset.address : undefined;
    }, origin);
    expect(nextAddress).toBeDefined();
    await page.locator(`${ASM_ROW}[data-address="${nextAddress}"]`).click();
    await expect(page.locator(PC_ROW)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(PC_ROW)).toHaveAttribute("data-address", origin);

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
    await expect(entryRow.locator(ROW_TRACE)).toHaveText(/\S/, { timeout: 30_000 });
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
