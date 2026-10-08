import { test, expect, navigateTo } from "../helpers/test-fixtures";

test.describe("Routing", () => {
  test("home page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/");
    await expect(page.locator("header")).toBeVisible();
  });

  test("debugger page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/debugger");
    await expect(
      page.getByRole("heading", { name: "Debug Sessions", exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("logs page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/logs");
    await expect(
      page.getByRole("heading", { name: "Application Logs" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("settings page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/settings");
    // Something only the Settings page renders. The word "Settings" is not
    // it: the header nav link and the Home page's "Settings" card both carry
    // it, and React Router keeps the previous page on screen while the lazy
    // Settings chunk loads — so a page that starts on Home would pass (or trip
    // strict mode) before the route has actually changed.
    await expect(
      page.getByRole("main").getByRole("tab", { name: "Keyboard Shortcuts" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("about page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/about");
    await expect(page.getByText("Powered by an Amazing Stack")).toBeVisible({
      timeout: 5_000,
    });
  });
});
