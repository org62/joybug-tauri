import { Page, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { navigateTo } from "./test-fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to a built source-debugging fixture exe (see e2e/fixtures/build.mjs). */
export function fixtureExe(name: "hello_c" | "hello_asm"): string {
  return path.resolve(__dirname, "..", "fixtures", "bin", `${name}.exe`);
}

/**
 * Create and start a debug session via the UI dialog.
 * Uses `cmd.exe /c "echo hello world"` as the debug target.
 *
 * Steps:
 * 1. Navigate to /debugger
 * 2. Click "Create Process"
 * 3. Fill session name
 * 4. Click "Create & Start"
 * 5. Wait for navigation to /session/:id
 *
 * Returns the session ID extracted from the URL.
 */
export async function createAndStartSession(
  page: Page,
  name = "E2E Test Session",
  launchCommand = "cmd.exe /c echo e2e_test",
): Promise<string> {
  await navigateTo(page, "/debugger");

  // Click "Create Process" button (header trigger; .first() avoids the
  // empty-state button that shares the label when no sessions exist)
  await page.getByRole("button", { name: /Create Process/i }).first().click();

  // Fill session name
  await page.getByLabel("Session Name").fill(name);

  // Use a unique launch command to avoid loading persisted breakpoints
  // from previous manual debugging sessions
  await page.getByLabel("Launch Command").fill(launchCommand);

  // Click "Create & Start"
  await page.getByRole("button", { name: "Create & Start" }).click();

  // Wait for navigation to session page
  await page.waitForURL(/\/session\//, { timeout: 10_000 });

  // Extract session ID from URL
  const url = page.url();
  const match = url.match(/\/session\/(.+)$/);
  if (!match) {
    throw new Error(`Expected URL to contain /session/:id, got: ${url}`);
  }

  return match[1];
}

/**
 * Create a session (without starting it) via the UI dialog.
 * Returns the session ID.
 */
export async function createSession(
  page: Page,
  name = "E2E Test Session",
): Promise<string> {
  // Click "Create Process" button (header trigger)
  await page.getByRole("button", { name: /Create Process/i }).first().click();

  // Fill session name
  await page.getByLabel("Session Name").fill(name);

  // Click "Create Session" (not "Create & Start")
  await page.getByRole("button", { name: "Create Session", exact: true }).click();

  // Wait for dialog to close and session card to appear
  await expect(page.getByText(name)).toBeVisible({ timeout: 5_000 });

  // Get the session ID from the backend
  const sessionId = await page.evaluate(async (sessionName: string) => {
    const sessions = await (window as any).__TAURI_INTERNALS__.invoke(
      "get_debug_sessions",
    );
    const session = sessions.find((s: any) => s.name === sessionName);
    return session?.id;
  }, name);

  if (!sessionId) {
    throw new Error(`Could not find session with name: ${name}`);
  }

  return sessionId;
}

/**
 * Clean up a specific session by stopping and deleting it.
 */
export async function cleanupSession(
  page: Page,
  sessionId: string,
): Promise<void> {
  await page.evaluate(async (id: string) => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;

    try {
      await invoke("stop_debug_session", { sessionId: id });
    } catch {
      // May already be stopped
    }

    // Poll until stopped instead of hardcoded sleep
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const s = await invoke("get_debug_session", { sessionId: id });
        if (s.status === "Stopped") break;
      } catch {
        break; // Session may not exist
      }
      await new Promise((r) => setTimeout(r, 50 + attempt * 50));
    }

    try {
      await invoke("delete_debug_session", { sessionId: id });
    } catch {
      // May already be deleted
    }
  }, sessionId);
}
