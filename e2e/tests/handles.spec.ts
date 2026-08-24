import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow, closeWindow } from "../helpers/session-helpers";
import { waitForPaused, configureMinimalStopSettings, restoreDefaultSettings } from "../helpers/wait-helpers";

interface HandleInfo { handle: number; type_name: string; name: string }
interface PrivilegeInfo { name: string; state: string }
interface ProcessObjects {
  handles: HandleInfo[];
  privileges: PrivilegeInfo[];
  windows: unknown[];
  tcp_connections: unknown[];
  warnings: string[];
}

test.describe("Handles window", () => {
  test("lists handles and privileges, filters, toggles a privilege and closes a handle", async ({ tauriPage: page }) => {
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);
    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(page, "Handles");
      await waitForPaused(page, sessionId);

      // Backend contract first: the snapshot is complete and typed.
      const objs = (await invoke(page, "get_process_objects", { sessionId })) as ProcessObjects;
      expect(objs.warnings).toEqual([]);
      expect(objs.handles.length).toBeGreaterThan(0);
      expect(objs.handles.every((h) => h.type_name !== "")).toBe(true);
      const key = objs.handles.find((h) => h.type_name === "Key" && h.name.startsWith("\\REGISTRY"));
      expect(key, "a named \\REGISTRY key handle").toBeTruthy();
      const changeNotify = objs.privileges.find((p) => p.name === "SeChangeNotifyPrivilege");
      expect(changeNotify?.state).toBe("EnabledByDefault");

      // The window renders the same snapshot.
      await goToWindow(page, "Handles");
      const handleRows = page.getByTestId("handles-handle-row");
      await expect(handleRows.first()).toBeVisible();
      await expect.poll(() => handleRows.count(), { intervals: [50, 100] }).toBe(objs.handles.length);
      await expect(page.getByTestId("handles-privilege-row").filter({ hasText: "SeChangeNotifyPrivilege" })).toContainText("Enabled (default)");
      await expect(page.getByTestId("handles-tcp-section")).toBeVisible();
      await expect(page.getByTestId("handles-window-section")).toBeVisible();

      // Filter narrows the handle table to the registry keys.
      await page.getByTestId("handles-handle-filter").fill("\\REGISTRY");
      const keyCount = objs.handles.filter((h) => h.name.includes("\\REGISTRY")).length;
      await expect.poll(() => handleRows.count(), { intervals: [50, 100] }).toBe(keyCount);
      await expect(handleRows.first()).toContainText("\\REGISTRY");

      // Privilege toggle through the context menu, round-tripped to the token.
      const privRow = page.getByTestId("handles-privilege-row").filter({ hasText: "SeChangeNotifyPrivilege" });
      await privRow.click({ button: "right" });
      await page.getByTestId("handles-privilege-menu-toggle").click();
      await expect(privRow).toContainText("Disabled");
      await privRow.click({ button: "right" });
      await page.getByTestId("handles-privilege-menu-toggle").click();
      await expect(privRow).toContainText("Enabled (default)");

      // Close the named key handle; it must leave the table after the re-snapshot.
      const victimHex = `0x${key!.handle.toString(16).toUpperCase()}`;
      const victimRow = handleRows.filter({ has: page.locator(`[title="${victimHex}"]`) }).first();
      await expect(victimRow).toBeVisible();
      await victimRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: /Close handle/ }).click();
      await page.getByTestId("handles-close-confirm").click();
      await expect(handleRows.filter({ has: page.locator(`[title="${victimHex}"]`) })).toHaveCount(0);
      const after = (await invoke(page, "get_process_objects", { sessionId })) as ProcessObjects;
      expect(after.handles.some((h) => h.handle === key!.handle)).toBe(false);
    } finally {
      // The page is never reloaded between specs: leave the tab open and every
      // later spec re-enumerates handles on each pause.
      await closeWindow(page, "Handles").catch(() => {});
      if (sessionId) await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
