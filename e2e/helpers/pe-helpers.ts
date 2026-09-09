import { expect, Page } from "@playwright/test";
import { navigateTo } from "./test-fixtures";

/** Open a PE in the standalone viewer by deep link and wait for its tree. */
export async function openPe(page: Page, path: string): Promise<void> {
  // Leave the PE route first so the page remounts: its component state (the
  // active dock tab, the tree's fold state, emulation/xref picks) otherwise
  // carries over from the previous test. The open file itself is kept by the
  // page's module-level snapshot, so re-opening the same path is instant.
  if (page.url().includes("/pe")) await navigateTo(page, "/");
  await navigateTo(page, "/pe?path=" + encodeURIComponent(path));
  // The snapshot shows the previously opened file until the deep link's load
  // lands, so "DOS Header" alone is not proof: wait for this file's name in
  // the toolbar, which only changes when the new summary is in.
  const fileName = path.split(/[\\/]/).pop()!;
  await expect(page.getByText(fileName, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

/** A structure-tree leaf row, located by its label. */
export function leaf(page: Page, label: string) {
  return page.locator(`[data-testid="pe-leaf"][data-label="${label}"]`).first();
}

/** The address link of a structure-tree leaf row. */
export function leafLink(page: Page, label: string) {
  return leaf(page, label).locator("button").first();
}

/** Choose an option in one of the PE viewer's selects. */
export async function pick(page: Page, testId: string, option: string | RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}
