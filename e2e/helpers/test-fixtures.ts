import { test as base, chromium, Page, TestInfo } from "@playwright/test";
import { rmSync } from "fs";
import path from "path";

// Persisted stores keyed by launch_command. Most tests share the default
// `cmd.exe /c echo e2e_test` command, so a breakpoint/patch/bookmark one test
// leaves behind reloads into the next same-command session and corrupts it
// (e.g. a leaked breakpoint re-arms and pauses a "run to exit" test). The
// backend only rewrites these on a session's own state change, so deleting them
// between tests — while no session is active — is safe and isolates every test.
// The "persist across restart" specs create and reload their own state within a
// single test, so a pre-test wipe leaves them unaffected.
const PERSISTED_STORES = ["breakpoints.json", "patches.json", "bookmarks.json"];

function clearPersistedStores(): void {
  const dir = process.env.JOYBUG_E2E_DATA_DIR;
  if (!dir) return;
  for (const file of PERSISTED_STORES) {
    try {
      rmSync(path.join(dir, file), { force: true });
    } catch {
      // Transient lock (the backend rewriting the store) — skip this round;
      // `force` already swallows the missing-file case.
    }
  }
}

/** Wait for the React app to mount (a connect/load may arrive before render). */
async function waitForAppMount(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      return !!root && root.children.length > 0;
    },
    { timeout: 15_000 },
  );
}

const CDP_ENDPOINT = "http://localhost:9222";
// In release mode the app serves its frontend over the Tauri custom protocol
// (tauri.localhost); in dev it's the Vite dev server (localhost:1420).
const APP_ORIGIN =
  process.env.JOYBUG_E2E_RELEASE === "1"
    ? "http://tauri.localhost"
    : "http://localhost:1420";

type TestFixtures = {
  tauriPage: Page;
};

export const test = base.extend<TestFixtures>({
  tauriPage: async ({}, use, testInfo: TestInfo) => {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    await waitForAppMount(page);

    // Pin theme in localStorage so next-themes doesn't re-detect system
    // preference on each CDP reconnect (which causes dark↔light flicker),
    // then clear everything else so each test starts from default UI state
    // (a dock layout persisted from before a feature existed would otherwise
    // hide that feature's default tabs).
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
      // Disable quick emulation in disassembly view — it consumes CPU without
      // being tested by e2e and can slow down / interfere with other tests.
      localStorage.setItem("assembly-quick-emulation-collapsed", "true");
    });

    // Clean up any existing sessions and restore settings before test
    await cleanupAllSessions(page);
    await restoreSettings(page);
    // Wipe persisted per-target stores so no prior test's breakpoints/patches/
    // bookmarks leak into this test's same-command session.
    clearPersistedStores();

    await use(page);

    // Capture a screenshot on failure only (connectOverCDP doesn't support
    // Playwright's built-in screenshot timeline). Passing tests skip it —
    // ~100-200ms per test that nobody looks at.
    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        const screenshot = await page.screenshot();
        await testInfo.attach("screenshot", {
          body: screenshot,
          contentType: "image/png",
        });
      } catch {
        // Screenshot may fail if page crashed
      }
    }

    // Clean up after test
    try {
      await cleanupAllSessions(page);
      await restoreSettings(page);
      // Clear localStorage but preserve theme preference to avoid dark/light flicker
      await page.evaluate(() => {
        const theme = localStorage.getItem("theme");
        localStorage.clear();
        if (theme) localStorage.setItem("theme", theme);
      });
    } catch {
      // Page may have navigated away or crashed
    }

    // Disconnect CDP (does NOT kill Tauri)
    await browser.close();
  },
});

async function cleanupAllSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;

    let sessions: any[];
    try {
      sessions = await invoke("get_debug_sessions");
    } catch {
      return;
    }

    // If all sessions are already stopped, skip straight to deletion
    if (sessions.every((s: any) => s.status === "Stopped")) {
      // fall through to delete
    } else {
      // Stop all non-stopped sessions
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

    // Delete all sessions
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

async function restoreSettings(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      await (window as any).__TAURI_INTERNALS__?.invoke(
        "update_debug_settings",
        {
          newSettings: {
            stop_on_thread_create: true,
            stop_on_thread_exit: false,
            stop_on_dll_load: true,
            stop_on_dll_unload: true,
            stop_on_initial_breakpoint: true,
            stop_on_process_create: true,
          },
        },
      );
    });
  } catch {
    // Settings restore failed — non-fatal
  }
}

/**
 * Client-side navigation via React Router — avoids full page reload
 * so next-themes doesn't flash light→dark.
 * Falls back to page.goto() if pushState fails (e.g. context destroyed).
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  const currentUrl = page.url();
  // If the app isn't loaded yet (e.g. blank tab), do a full navigation once
  if (!currentUrl.startsWith(APP_ORIGIN)) {
    await page.goto(`${APP_ORIGIN}${path}`);
    return;
  }
  try {
    await page.evaluate((p: string) => {
      window.history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  } catch {
    // Context destroyed — fall back to full navigation
    await page.goto(`${APP_ORIGIN}${path}`);
  }
}

/**
 * Open the PE viewer from a full document load. The PeReader caches its open
 * file in a module-level variable that survives client-side navigation (so
 * switching tabs keeps the file open), and that cache is invisible to the
 * fixture's per-test cleanup. A soft navigation would therefore restore a PE
 * opened — and left open — by an earlier test, hiding the empty-state
 * placeholder. A full load resets the module state, so any test that asserts
 * the fresh-start empty view must reach `/pe` this way.
 */
export async function gotoFreshPe(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/pe`);
  await waitForAppMount(page);
}

export { expect } from "@playwright/test";
export { APP_ORIGIN };
