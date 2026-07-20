import { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { cleanupSession, invoke } from "../helpers/session-helpers";
import {
  configureMinimalStopSettings,
  restoreDefaultSettings,
  waitForPaused,
} from "../helpers/wait-helpers";

// A dependency-free 64-bit system DLL that always exists on the test host.
const NTDLL = "C:\\Windows\\System32\\ntdll.dll";
const CMD = "C:\\Windows\\System32\\cmd.exe";

// These tests exercise the drop-handling logic through the
// `joybug:test-file-drop` seam in useFileDrop: native OS drag-drop cannot be
// synthesized over CDP (the paths originate in the WebView2/Tauri native drop
// handler). The Tauri onDragDropEvent subscription itself and the overlay
// visuals are covered by manual testing only.
async function dropFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((p: string[]) => {
    window.dispatchEvent(
      new CustomEvent("joybug:test-file-drop", { detail: { paths: p } }),
    );
  }, paths);
}

test.describe("Drag-drop file open", () => {
  test("dropping a PE file on the PE viewer opens it", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/pe");
    // Ensure the page (and its drop hook) is mounted before dispatching.
    await expect(page.getByText("No PE file open").first()).toBeVisible({
      timeout: 5_000,
    });

    await dropFiles(page, [NTDLL]);

    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("ntdll.dll", { exact: false }).first()).toBeVisible();

    // Close the file: the PE viewer's open file intentionally survives
    // navigation (module-level snapshot), so leaving it open would break
    // later specs that expect the empty-page placeholder.
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText("No PE file open").first()).toBeVisible({ timeout: 5_000 });
  });

  test("dropping a non-PE file on the PE viewer shows an error", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/pe");
    await expect(page.getByText(/No PE file open|ntdll\.dll/).first()).toBeVisible({
      timeout: 5_000,
    });

    await dropFiles(page, ["C:\\Windows\\System32\\drivers\\etc\\hosts"]);

    await expect(page.getByText(/Not a PE file/).first()).toBeVisible({ timeout: 5_000 });
  });

  test("dropping an .exe on the Debugger creates and starts a local-run session", async ({
    tauriPage: page,
  }) => {
    let sessionId: string | null = null;
    try {
      await configureMinimalStopSettings(page);
      await navigateTo(page, "/debugger");
      await expect(page.getByText("Debug Sessions").first()).toBeVisible({
        timeout: 5_000,
      });

      await dropFiles(page, [CMD]);

      // The drop navigates straight into the session view.
      await page.waitForURL(/\/session\//, { timeout: 15_000 });
      sessionId = page.url().match(/\/session\/(.+)$/)![1];

      await waitForPaused(page, sessionId);

      // Dropped sessions are local runs (embedded server) named after the exe.
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session.is_local_run).toBe(true);
      expect(session.name).toBe("cmd");
      expect(session.launch_command).toBe(CMD);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

  test("dropping a non-exe on the Debugger is rejected without creating a session", async ({
    tauriPage: page,
  }) => {
    await navigateTo(page, "/debugger");
    await expect(page.getByText("Debug Sessions").first()).toBeVisible({
      timeout: 5_000,
    });

    await dropFiles(page, [NTDLL]);

    await expect(page.getByText(/Only \.exe files can be launched/).first()).toBeVisible({ timeout: 5_000 });
    expect(page.url()).not.toMatch(/\/session\//);
    const sessions = await invoke(page, "get_debug_sessions");
    expect(sessions).toHaveLength(0);
  });
});
