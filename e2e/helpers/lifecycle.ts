// What happens around every test: the app is launched once per spec file by
// tauri-driver, so each test starts by putting it back into a known state
// (no sessions, default settings, empty persisted stores, default UI state,
// an empty navigation trail) and leaves it that way.

import { existsSync, rmSync } from "fs";
import path from "path";
import { Page } from "./pw";
import { APP_ORIGIN, waitForAppMount } from "./app";
import { dataDir } from "./launch-commands";

/** Before each test: the resets the Playwright fixture used to do. */
export async function beforeTest(page: Page): Promise<void> {
  await waitForAppMount(page);

  // Pin theme in localStorage so next-themes doesn't re-detect system
  // preference on each app start (which causes dark↔light flicker), then clear
  // everything else so each test starts from default UI state (a dock layout
  // persisted from before a feature existed would otherwise hide that
  // feature's default tabs).
  await page.evaluate(() => {
    if (!localStorage.getItem("theme")) {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      localStorage.setItem("theme", isDark ? "dark" : "light");
    }
    const theme = localStorage.getItem("theme");
    localStorage.clear();
    if (theme) localStorage.setItem("theme", theme);
    // Disable the always-on lightning emulation in the disassembly view — it
    // costs an emulator run per pause without being tested here and could
    // slow down / interfere with other tests. The Quick Emulation footer
    // probes default to off. emulation-highlight.spec.ts clears this.
    localStorage.setItem("assembly-lightning-disabled", "true");
  });

  // The app-wide back/forward history (lib/navHistory.ts) would otherwise
  // carry the previous test's page trail into this one.
  await page.evaluate(() => window.dispatchEvent(new Event("joybug:reset-nav-history")));

  // A failed test can leave a dialog or the command palette open; the page is
  // shared within a spec file, so close it (Escape, up to twice) rather than
  // let every later test trip over it.
  for (let i = 0; i < 2 && (await page.getByRole("dialog").count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 1_000 }).catch(() => {});
  }

  await cleanupAllSessions(page);
  await restoreSettings(page);
  // Wipe persisted per-target stores so no prior test's breakpoints/patches/
  // bookmarks leak into this test's same-command session.
  clearPersistedStores();
}

/** After each test. */
export async function afterTest(page: Page): Promise<void> {
  await cleanupAllSessions(page);
  await restoreSettings(page);
  await page.evaluate(() => {
    const theme = localStorage.getItem("theme");
    localStorage.clear();
    if (theme) localStorage.setItem("theme", theme);
  });
}

export async function cleanupAllSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;

    let sessions: any[];
    try {
      sessions = await invoke("get_debug_sessions");
    } catch {
      return;
    }

    if (!sessions.every((s: any) => s.status === "Stopped")) {
      for (const s of sessions) {
        if (s.status !== "Stopped") {
          try {
            await invoke("stop_debug_session", { sessionId: s.id });
          } catch {
            // May already be stopped
          }
        }
      }
      // Poll until all sessions are stopped (up to 10s)
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          sessions = await invoke("get_debug_sessions");
          if (sessions.every((s: any) => s.status === "Stopped")) break;
        } catch {
          break;
        }
      }
    }

    try {
      sessions = await invoke("get_debug_sessions");
    } catch {
      return;
    }
    for (const s of sessions) {
      try {
        await invoke("delete_debug_session", { sessionId: s.id });
      } catch {
        // May already be deleted
      }
    }
  });
}

export async function restoreSettings(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      await (window as any).__TAURI_INTERNALS__?.invoke("update_debug_settings", {
        newSettings: {
          stop_on_thread_create: true,
          stop_on_thread_exit: false,
          stop_on_dll_load: true,
          stop_on_dll_unload: true,
          stop_on_initial_breakpoint: true,
          stop_on_process_create: true,
        },
      });
    });
  } catch {
    // Settings restore failed — non-fatal
  }
}

/** Delete the per-target stores the app persists under its data dir. */
export function clearPersistedStores(): void {
  for (const file of ["breakpoints.json", "patches.json", "bookmarks.json"]) {
    const p = path.join(dataDir(), file);
    if (existsSync(p)) {
      try { rmSync(p); } catch { /* best effort */ }
    }
  }
}

/**
 * Client-side navigation via React Router — avoids a full page reload so
 * next-themes doesn't flash light→dark. Falls back to a full navigation when
 * the app isn't loaded (blank page) or the script fails.
 */
export async function navigateTo(page: Page, routePath: string): Promise<void> {
  const currentUrl = await page.url();
  if (!currentUrl.startsWith(APP_ORIGIN)) {
    await page.goto(`${APP_ORIGIN}${routePath}`);
    return;
  }
  try {
    await page.evaluate((p: string) => {
      window.history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, routePath);
  } catch {
    await page.goto(`${APP_ORIGIN}${routePath}`);
  }
}

/**
 * Open the PE viewer from a full document load. The PeReader caches its open
 * file in a module-level variable that survives client-side navigation (so
 * switching tabs keeps the file open), and that cache is invisible to the
 * per-test cleanup. A soft navigation would therefore restore a PE opened —
 * and left open — by an earlier test, hiding the empty-state placeholder. A
 * full load resets the module state, so any test that asserts the fresh-start
 * empty view must reach `/pe` this way.
 */
export async function gotoFreshPe(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/pe`);
  await waitForAppMount(page);
}
