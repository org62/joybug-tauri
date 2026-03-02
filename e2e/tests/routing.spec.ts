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
    await expect(page.getByText("Application Settings")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("about page loads", async ({ tauriPage: page }) => {
    await navigateTo(page, "/about");
    await expect(page.getByText("Powered by an Amazing Stack")).toBeVisible({
      timeout: 5_000,
    });
  });
});
