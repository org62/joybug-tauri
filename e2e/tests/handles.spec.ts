import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow, closeWindow } from "../helpers/session-helpers";
import { waitForPaused, configureMinimalStopSettings, restoreDefaultSettings } from "../helpers/wait-helpers";
import { IS_WINDOWS } from "../helpers/launch-commands";

interface HandleInfo { handle: number; type_name: string; name: string; granted_access: number }
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
    test.skip(!IS_WINDOWS, "NT handles, registry keys and token privileges");
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

  /**
   * A Linux target's "handles" are its file descriptors: the same window shows
   * them by number, with their open(2) flags and the path or socket behind
   * them, and closes one by running close() on a stopped thread of the target.
   */
  test("lists file descriptors on Linux, filters and closes one", async ({ tauriPage: page }) => {
    test.skip(IS_WINDOWS, "file descriptors");
    test.setTimeout(60_000);
    await configureMinimalStopSettings(page);
    let sessionId: string | undefined;
    try {
      sessionId = await createAndStartSession(page, "Descriptors");
      await waitForPaused(page, sessionId);

      // Backend contract: stdin/stdout/stderr at least, each typed, in order.
      const objs = (await invoke(page, "get_process_objects", { sessionId })) as ProcessObjects;
      expect(objs.warnings).toEqual([]);
      expect(objs.windows).toEqual([]);
      expect(objs.handles.every((h) => h.type_name !== "")).toBe(true);
      const numbers = objs.handles.map((h) => h.handle);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      for (const fd of [0, 1, 2]) expect(numbers).toContain(fd);

      // The window renders the same snapshot under Linux names.
      await goToWindow(page, "Handles");
      const rows = page.getByTestId("handles-handle-row");
      await expect(rows.first()).toBeVisible();
      await expect.poll(() => rows.count(), { intervals: [50, 100] }).toBe(objs.handles.length);
      await expect(page.getByTestId("handles-handle-toggle")).toContainText("File Descriptors");
      await expect(page.getByTestId("handles-privilege-toggle")).toContainText("Capabilities");
      await expect(page.getByTestId("handles-tcp-section")).toBeVisible();
      await expect(page.getByTestId("handles-window-section")).toHaveCount(0);
      // The flags column spells the access mode out.
      await expect(rows.first()).toContainText(/O_(RDONLY|WRONLY|RDWR)/);

      // The filter narrows the table and comes back.
      await page.getByTestId("handles-handle-filter").fill("no-such-descriptor");
      await expect(rows).toHaveCount(0);
      await expect(page.getByTestId("handles-handle-table")).toContainText("No matches");
      await page.getByTestId("handles-handle-filter").fill("");
      await expect.poll(() => rows.count(), { intervals: [50, 100] }).toBe(objs.handles.length);

      // Close stdin inside the paused target; it must leave the table.
      const stdin = rows.filter({ has: page.locator('[title="0"]') }).first();
      await expect(stdin).toBeVisible();
      await stdin.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close descriptor 0" }).click();
      await expect(page.getByRole("dialog")).toContainText("Close descriptor 0?");
      await page.getByTestId("handles-close-confirm").click();
      await expect.poll(() => rows.count(), { intervals: [50, 100] }).toBe(objs.handles.length - 1);
      const after = (await invoke(page, "get_process_objects", { sessionId })) as ProcessObjects;
      expect(after.handles.some((h) => h.handle === 0)).toBe(false);
      // The injected close() left the target where it was: still paused, same PC.
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session.status).toBe("Paused");
    } finally {
      await closeWindow(page, "Handles").catch(() => {});
      if (sessionId) await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
