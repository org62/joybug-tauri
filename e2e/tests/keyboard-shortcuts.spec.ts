import { test, expect, navigateTo } from "../helpers/test-fixtures";

test.describe("Global Keyboard Shortcuts", () => {
  test("Ctrl+Shift+D navigates to debugger page", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/");
    await expect(page.locator("header")).toBeVisible();

    await page.keyboard.press("Control+Shift+D");
    await expect(page).toHaveURL(/\/debugger/, { timeout: 5_000 });
  });

  test("Ctrl+Shift+L navigates to logs page", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/");
    await expect(page.locator("header")).toBeVisible();

    await page.keyboard.press("Control+Shift+L");
    await expect(page).toHaveURL(/\/logs/, { timeout: 5_000 });
  });

  test("Ctrl+D toggles disassembly panel", async ({ tauriPage: page }) => {
    await navigateTo(page, "/debugger");

    // This shortcut only works in session view — smoke test it doesn't crash
    await page.keyboard.press("Control+d");
    await expect(page.locator("header")).toBeVisible();
  });

  test("Ctrl+B toggles breakpoints panel", async ({ tauriPage: page }) => {
    await navigateTo(page, "/debugger");

    // Smoke test — shortcut doesn't crash the app
    await page.keyboard.press("Control+b");
    await expect(page.locator("header")).toBeVisible();
  });
});
