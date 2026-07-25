import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { invoke } from "../helpers/session-helpers";

/**
 * Update-check UI. Deliberately network-free — the app is launched with
 * JOYBUG_NO_UPDATE_CHECK/JOYBUG_NO_WELCOME (see global-setup.ts), so nothing
 * here depends on api.github.com being reachable. Clicking "Check for updates"
 * would make a real request, so these tests only assert the control exists.
 */
test.describe("Updates", () => {
  const autoUpdateSwitch = "Automatically check for updates";

  test("welcome dialog stays suppressed", async ({ tauriPage: page }) => {
    // Guards the env gating in global-setup.ts: if it regresses, this modal
    // appears at mount and blocks every other spec in the suite.
    await navigateTo(page, "/");
    await expect(page.getByTestId("welcome-dialog")).toHaveCount(0);
    await expect(page.getByTestId("update-dialog")).toHaveCount(0);
  });

  test("about page offers update and repository links", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/about");
    await expect(
      page.getByRole("button", { name: "Check for updates" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "joybug-tauri" })).toBeVisible();
    await expect(page.getByRole("button", { name: "joybug-core" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Report an issue" })).toBeVisible();
  });

  test("auto update check defaults on and persists when toggled", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/settings?tab=general");
    const toggle = page.getByRole("switch", { name: autoUpdateSwitch });
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute("data-state", "checked");

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    // The switch flips optimistically and persists in the background, so wait
    // for the backend to actually hold the new value before navigating —
    // otherwise the remount below can refetch ahead of the write.
    await expect(async () => {
      const s = await invoke(page, "get_debug_settings");
      expect(s.auto_update_check).toBe(false);
    }).toPass({ intervals: [50, 100], timeout: 5_000 });

    // Round-trip through update_debug_settings: leave the page, come back, and
    // the value must be re-read from the backend rather than local state.
    await navigateTo(page, "/about");
    await navigateTo(page, "/settings?tab=general");
    const reloaded = page.getByRole("switch", { name: autoUpdateSwitch });
    await expect(reloaded).toBeVisible({ timeout: 5_000 });
    await expect(reloaded).toHaveAttribute("data-state", "unchecked");

    // Restore, so the default-on assertion above holds on a re-run even though
    // the fixture's restoreSettings() also covers this.
    await reloaded.click();
    await expect(reloaded).toHaveAttribute("data-state", "checked");
  });
});
