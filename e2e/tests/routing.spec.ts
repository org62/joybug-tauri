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
    // Scope to main content — "Settings" also appears as a nav link in the
    // header, which would make a bare getByText ambiguous (strict-mode).
    await expect(
      page.getByRole("main").getByText("Settings"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("about page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/about");
    await expect(page.getByText("Powered by an Amazing Stack")).toBeVisible({
      timeout: 5_000,
    });
  });
});
