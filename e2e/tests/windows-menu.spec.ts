import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, goToWindow, clickWindowsMenuItem } from "../helpers/session-helpers";
import { waitForPaused } from "../helpers/wait-helpers";
import type { Page } from "@playwright/test";

/** Dock tab ids currently present in the layout. */
async function openTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[id*='-tab-']"))
      .map((el) => el.id.split("-tab-")[1])
      .filter(Boolean),
  );
}

/** True when the panel holding `tabId` also holds `siblingTabId`. */
async function sharesPanelWith(page: Page, tabId: string, siblingTabId: string): Promise<boolean> {
  return page.evaluate(({ a, b }) => {
    const tab = document.querySelector(`[id$='-tab-${a}']`);
    const panel = tab?.closest(".dock-panel");
    return !!panel?.querySelector(`[id$='-tab-${b}']`);
  }, { a: tabId, b: siblingTabId });
}

const DEFAULT_TABS = ["modules", "threads", "disassembly", "memory", "registers", "callstack"];

test.describe("Windows: navigation, grouping, and reset", () => {
  test("default layout is the bare minimum", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Default");
    try {
      await waitForPaused(page, sessionId);

      await expect(async () => {
        expect((await openTabIds(page)).sort()).toEqual([...DEFAULT_TABS].sort());
      }).toPass({ timeout: 10_000 });

      await expect(page.locator("[id$='-tab-disassembly']").first())
        .toHaveAttribute("aria-selected", "true");
      // Everything else opens on demand.
      await expect(page.locator("[id$='-tab-strings']")).toHaveCount(0);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a window opens into its home panel, not the first panel", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Home");
    try {
      await waitForPaused(page, sessionId);

      // Symbols' home is the left-top panel, alongside Modules.
      await goToWindow(page, "Symbols");
      await expect(async () => {
        expect(await sharesPanelWith(page, "symbols", "modules")).toBe(true);
      }).toPass({ timeout: 5_000 });

      // Memory Scanner's home is the center panel, alongside Disassembly.
      await goToWindow(page, "Memory Scanner");
      await expect(async () => {
        expect(await sharesPanelWith(page, "memory_scanner", "disassembly")).toBe(true);
      }).toPass({ timeout: 5_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("'Go to' never closes an open window", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows GoTo");
    try {
      await waitForPaused(page, sessionId);

      await goToWindow(page, "Strings");
      const tab = page.locator("[id$='-tab-strings']").first();
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

      // Asking again keeps it open and active — this is the whole point of the
      // rename from "Toggle" to "Go to".
      await goToWindow(page, "Strings");
      await expect(tab).toHaveCount(1);
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("'Go to' focuses the view's primary input", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Focus");
    try {
      await waitForPaused(page, sessionId);

      // Catches the palette's dialog restoring focus on close, which would
      // otherwise silently steal it back from the panel.
      await goToWindow(page, "Symbols");
      await expect(page.locator("input:focus")).toHaveAttribute(
        "placeholder", /symbol/i, { timeout: 5_000 },
      );
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("the Windows menu still toggles a window closed", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Toggle");
    try {
      await waitForPaused(page, sessionId);

      await clickWindowsMenuItem(page, "Debug", "User Patches");
      await expect(page.locator("[id$='-tab-patches']")).toHaveCount(1, { timeout: 5_000 });

      // Unchecking is the one affordance that closes a window.
      await clickWindowsMenuItem(page, "Debug", "User Patches");
      await expect(page.locator("[id$='-tab-patches']")).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("Reset Layout returns to the bare minimum", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Reset");
    try {
      await waitForPaused(page, sessionId);

      await goToWindow(page, "Strings");
      await goToWindow(page, "Symbols");
      await goToWindow(page, "Breakpoints");
      await expect(async () => {
        expect((await openTabIds(page)).length).toBeGreaterThan(DEFAULT_TABS.length);
      }).toPass({ timeout: 5_000 });

      await page.getByRole("button", { name: "Windows" }).click();
      await page.getByRole("menuitem", { name: "Reset Layout" }).click();
      await page.keyboard.press("Escape");

      await expect(async () => {
        expect((await openTabIds(page)).sort()).toEqual([...DEFAULT_TABS].sort());
      }).toPass({ timeout: 10_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("a panel chord shows without closing", async ({ tauriPage: page }) => {
    const sessionId = await createAndStartSession(page, "Windows Chord");
    try {
      await waitForPaused(page, sessionId);

      // Ctrl+D twice used to open then close; it now just navigates. Ctrl+W is
      // the way to dismiss a tab.
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Control+d");
      await expect(page.locator("[id$='-tab-disassembly']")).toHaveCount(1);
      await expect(page.locator("[id$='-tab-disassembly']").first())
        .toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
