import { writeFileSync } from "fs";
import path from "path";
import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke, goToWindow } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";

const BOOKMARKS_FILE = process.env.JOYBUG_E2E_DATA_DIR
  ? path.join(process.env.JOYBUG_E2E_DATA_DIR, "bookmarks.json")
  : path.join(process.env.LOCALAPPDATA || "", "JoybugTauri", "bookmarks.json");

type Page = import("@playwright/test").Page;

async function getBookmarks(page: Page, sessionId: string): Promise<any[]> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  return s?.bookmarks ?? [];
}

async function getCurrentAddress(page: Page, sessionId: string): Promise<string> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  const address = s?.current_event?.address;
  if (address == null) throw new Error("No current address (session not paused?)");
  return `0x${address.toString(16).toUpperCase()}`;
}

test.describe("Bookmarks", () => {
  // Clear persisted bookmarks before each test to avoid cross-test contamination.
  test.beforeEach(() => {
    try {
      writeFileSync(BOOKMARKS_FILE, "{}", "utf-8");
    } catch {
      // File may not exist yet — fine.
    }
  });

  test("add a value bookmark, lock/unlock it, then remove it", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Bookmark Create");
      await waitForPaused(page, sessionId);

      const address = await getCurrentAddress(page, sessionId);

      expect(await getBookmarks(page, sessionId)).toHaveLength(0);

      // Add a U32 value bookmark at the current (module) address.
      await invoke(page, "add_bookmark", {
        sessionId,
        kind: "value",
        address,
        valueType: "U32",
        name: "hp",
      });

      await expect(async () => {
        const bms = await getBookmarks(page, sessionId);
        expect(bms).toHaveLength(1);
      }).toPass({ timeout: 5_000 });

      let [bm] = await getBookmarks(page, sessionId);
      expect(bm.kind).toBe("value");
      expect(bm.name).toBe("hp");
      expect(bm.value_type).toBe("U32");
      expect(bm.is_resolved).toBe(true);
      expect(bm.module_name).toBeTruthy();
      // Round-trips through module-relative storage back to the same address.
      expect(parseInt(bm.resolved_address, 16)).toBe(parseInt(address, 16));

      // Lock (server-side freeze) — must succeed while paused.
      await invoke(page, "toggle_bookmark_lock", { sessionId, id: bm.id, locked: true });
      await expect(async () => {
        [bm] = await getBookmarks(page, sessionId);
        expect(bm.locked).toBe(true);
      }).toPass({ timeout: 5_000 });

      // Unlock.
      await invoke(page, "toggle_bookmark_lock", { sessionId, id: bm.id, locked: false });
      await expect(async () => {
        [bm] = await getBookmarks(page, sessionId);
        expect(bm.locked).toBe(false);
      }).toPass({ timeout: 5_000 });

      // Remove.
      await invoke(page, "remove_bookmark", { sessionId, id: bm.id });
      await expect(async () => {
        expect(await getBookmarks(page, sessionId)).toHaveLength(0);
      }).toPass({ timeout: 5_000 });

      // UI: changed-value highlighting. Bookmark a writable data address (the
      // PEB), open the Bookmarks tab, then change the value — the value cell
      // renders neutral at first (the old always-green styling is gone) and
      // gets the shared `data-changed` marker on change.
      const { peb } = await invoke(page, "get_session_teb_peb", { sessionId });
      expect(peb).toBeTruthy();
      await invoke(page, "add_bookmark", {
        sessionId,
        kind: "value",
        address: peb,
        valueType: "U32",
        name: "e2e-val",
      });
      await goToWindow(page, "Bookmarks");
      const valueSpan = page.locator('span[title="Click to edit value"]').first();
      await expect(valueSpan).toBeVisible({ timeout: 10_000 });
      await expect(valueSpan).not.toHaveClass(/text-green-500/);
      await expect(valueSpan).not.toHaveAttribute("data-changed");

      const [pebBm] = await getBookmarks(page, sessionId);
      const oldPlain = parseInt(pebBm.current_value, 10);
      const newValue = String(oldPlain === 1 ? 2 : 1);
      await invoke(page, "set_bookmark_value", { sessionId, id: pebBm.id, value: newValue });
      await expect(valueSpan).toHaveAttribute("data-changed", "true", { timeout: 10_000 });

      await invoke(page, "remove_bookmark", { sessionId, id: pebBm.id });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("bookmarks persist across session restart", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Bookmark Persist");
      await waitForPaused(page, sessionId);

      const address = await getCurrentAddress(page, sessionId);
      await invoke(page, "add_bookmark", { sessionId, kind: "value", address, valueType: "U32", name: "score" });

      await expect(async () => {
        expect(await getBookmarks(page, sessionId)).toHaveLength(1);
      }).toPass({ timeout: 5_000 });

      const [created] = await getBookmarks(page, sessionId);
      const moduleName = created.module_name;
      const moduleOffset = created.module_offset;

      // Let the process run to completion.
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Bookmark stays in state (kept across reset).
      await expect(async () => {
        const bms = await getBookmarks(page, sessionId);
        expect(bms).toHaveLength(1);
        expect(bms[0].module_name).toBe(moduleName);
        expect(bms[0].module_offset).toBe(moduleOffset);
        expect(bms[0].name).toBe("score");
      }).toPass({ timeout: 5_000 });

      // Restart the same session; it pauses again at the initial breakpoint
      // (a value bookmark doesn't alter code), and the bookmark persists.
      await invoke(page, "start_debug_session", { sessionId });
      await waitForPaused(page, sessionId);

      await expect(async () => {
        const bms = await getBookmarks(page, sessionId);
        expect(bms).toHaveLength(1);
        expect(bms[0].module_name).toBe(moduleName);
        expect(bms[0].module_offset).toBe(moduleOffset);
        expect(bms[0].is_resolved).toBe(true);
      }).toPass({ timeout: 10_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
