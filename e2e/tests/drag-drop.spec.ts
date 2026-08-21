import { Page } from "@playwright/test";
import { test, expect, navigateTo, gotoFreshPe } from "../helpers/test-fixtures";
import { cleanupSession, invoke } from "../helpers/session-helpers";
import {
  configureMinimalStopSettings,
  restoreDefaultSettings,
  waitForPaused,
} from "../helpers/wait-helpers";

// A dependency-free 64-bit system DLL that always exists on the test host.
const NTDLL = "C:\\Windows\\System32\\ntdll.dll";
const CMD = "C:\\Windows\\System32\\cmd.exe";
// Always present, never a PE — used to exercise the reject path.
const NOT_PE = "C:\\Windows\\System32\\drivers\\etc\\hosts";

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

/**
 * Park the app on a page that does NOT handle drops itself, so the provider's
 * Debug / PE Viewer fallback is what sees the next drop. Waits for the page to
 * actually be on screen: the outgoing route only releases its claim on unmount,
 * so dropping mid-transition would still hit the previous page's handler.
 */
async function gotoNeutralPage(page: Page): Promise<void> {
  await navigateTo(page, "/settings");
  await expect(page.getByPlaceholder("Search settings...")).toBeVisible({ timeout: 10_000 });
}

test.describe("Drag-drop file open", () => {
  test("dropping a PE file on the PE viewer opens it", async ({
    tauriPage: page,
  }) => {
    // Full load resets the PE reader's module-level open-file cache so an earlier
    // test's leaked PE can't hide the placeholder this test opens from.
    await gotoFreshPe(page);
    await expect(page.getByText("No PE file open").first()).toBeVisible({
      timeout: 10_000,
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

    await dropFiles(page, [NOT_PE]);

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

  // Routes that don't handle drops themselves (Settings here, but equally Home,
  // Logs, About or an open session) fall back to the Debug / PE Viewer chooser.
  test("dropping an .exe on a page that doesn't handle drops offers both actions", async ({
    tauriPage: page,
  }) => {
    await gotoNeutralPage(page);

    await dropFiles(page, [CMD]);

    const choice = page.getByTestId("file-drop-choice");
    await expect(choice).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("file-drop-choice-debug")).toBeVisible();
    await expect(page.getByTestId("file-drop-choice-pe")).toBeVisible();

    await page.getByTestId("file-drop-choice-pe").click();

    await expect(choice).toBeHidden({ timeout: 5_000 });
    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("cmd.exe", { exact: false }).first()).toBeVisible();

    // The PE viewer's open file survives navigation — leave the page empty.
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText("No PE file open").first()).toBeVisible({ timeout: 5_000 });
  });

  test("choosing Debug in the chooser launches the dropped executable", async ({
    tauriPage: page,
  }) => {
    let sessionId: string | null = null;
    try {
      await configureMinimalStopSettings(page);
      await gotoNeutralPage(page);

      await dropFiles(page, [CMD]);
      await expect(page.getByTestId("file-drop-choice")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("file-drop-choice-debug").click();

      await page.waitForURL(/\/session\//, { timeout: 15_000 });
      sessionId = page.url().match(/\/session\/(.+)$/)![1];
      await waitForPaused(page, sessionId);

      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session.is_local_run).toBe(true);
      expect(session.name).toBe("cmd");
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

  test("dropping a non-launchable PE elsewhere goes straight to the PE viewer", async ({
    tauriPage: page,
  }) => {
    await gotoNeutralPage(page);

    // A .dll can't be launched, so there is nothing to choose between.
    await dropFiles(page, [NTDLL]);

    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("ntdll.dll", { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId("file-drop-choice")).toHaveCount(0);

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText("No PE file open").first()).toBeVisible({ timeout: 5_000 });
  });

  test("dropping a non-PE file elsewhere shows an error and stays put", async ({
    tauriPage: page,
  }) => {
    await gotoNeutralPage(page);

    await dropFiles(page, [NOT_PE]);

    await expect(page.getByText(/Not a PE file/).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("file-drop-choice")).toHaveCount(0);
    expect(page.url()).toMatch(/\/settings/);
  });

  test("a page that handles drops keeps them: .exe on the PE viewer opens, no chooser", async ({
    tauriPage: page,
  }) => {
    await gotoFreshPe(page);
    await expect(page.getByText("No PE file open").first()).toBeVisible({ timeout: 10_000 });

    await dropFiles(page, [CMD]);

    await expect(page.getByText("cmd.exe", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("file-drop-choice")).toHaveCount(0);

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText("No PE file open").first()).toBeVisible({ timeout: 5_000 });
  });
});
