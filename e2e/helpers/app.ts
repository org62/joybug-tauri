// How the suite reaches the app, in one place: the binary tauri-driver
// launches (debug by default, release with JOYBUG_E2E_RELEASE=1), the origin
// its frontend is served from, the Vite dev server that the debug binary
// loads it from, and "the app is mounted".
//
// The app runs in its real webview on every OS — WebKitGTK on Linux, WebView2
// on Windows — with WebDriver as the transport (`tauri-driver` in front of
// WebKitWebDriver / msedgedriver). One app process per spec file.

import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { IS_WINDOWS } from "./launch-commands";
import type { Page } from "./pw";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// In release mode (CI) the Tauri app embeds the built frontend, so we test
// against target/release and skip the Vite dev server. Locally we use the
// debug binary served by Vite.
export const RELEASE = process.env.JOYBUG_E2E_RELEASE === "1";
export const TAURI_BINARY = path.join(
  ROOT,
  "src-tauri/target",
  RELEASE ? "release" : "debug",
  `joybug-tauri${IS_WINDOWS ? ".exe" : ""}`,
);
const VITE_URL = "http://localhost:1420";
/** The origin the frontend is served from: Vite in debug, the embedded
 *  custom protocol in release (`http://tauri.localhost` on Windows — WebView2
 *  has no custom schemes — `tauri://localhost` elsewhere). */
export const APP_ORIGIN = RELEASE ? (IS_WINDOWS ? "http://tauri.localhost" : "tauri://localhost") : VITE_URL;

/** Environment the app must start with. Inherited through tauri-driver and
 *  the native driver, so it is put on the process environment of whichever
 *  process spawns them. */
/** Isolated data directory so e2e tests don't touch the user's real
 *  settings, breakpoints, patches, or pinned addresses. Deterministic, so
 *  `dataDir()` in launch-commands.ts (which reads JOYBUG_E2E_DATA_DIR) and the
 *  app (JOYBUG_DATA_DIR) agree. */
export const E2E_DATA_DIR = path.join(os.tmpdir(), "joybug-e2e-data");

export const APP_ENV: Record<string, string> = {
  JOYBUG_DATA_DIR: E2E_DATA_DIR,
  JOYBUG_E2E_DATA_DIR: E2E_DATA_DIR,
  // A startup modal would block every test, and the update check would make
  // the suite depend on api.github.com.
  JOYBUG_NO_WELCOME: "1",
  JOYBUG_NO_UPDATE_CHECK: "1",
  // No debuginfod downloads for stripped ELF modules: the suite must not
  // depend on the network (installed debug packages still resolve).
  DEBUGINFOD_URLS: "",
  // WebKitGTK's DMA-BUF renderer stalls the automation webview's frame clock
  // (requestAnimationFrame fires once, seconds late, then never): every
  // command that waits for a paint — clicks on focusable elements, pointer
  // actions, screenshots — then hangs or times out. Harmless on Windows.
  WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  // GTK picks Wayland over X11 whenever WAYLAND_DISPLAY is set, which would put
  // the window on the developer's desktop instead of the DISPLAY the run was
  // given (xvfb-run); X11 also lets the harness size the window. No-op on
  // Windows.
  GDK_BACKEND: "x11",
};

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}

let vite: ChildProcess | null = null;

/** Everything the run needs before the first app launch: fixtures, binary,
 *  Vite (debug mode), the data dir. Runs once, in the launcher. */
export async function prepareRun(): Promise<void> {
  // Build the debuggee fixtures (hello_c, echo_c, sleeper_c, ...) — MSVC on
  // Windows, cc elsewhere. Build-if-stale, so this is a fast no-op on repeated
  // runs.
  execSync(`node "${path.join(ROOT, "e2e/fixtures/build.mjs")}"`, { stdio: "inherit" });

  if (!existsSync(TAURI_BINARY)) {
    throw new Error(
      `Tauri binary not found at ${TAURI_BINARY}.\n` +
        `Run '${RELEASE ? "npm run tauri build" : "cd src-tauri && cargo build"}' first.`,
    );
  }

  // The release binary embeds the built frontend, so no dev server is needed.
  if (!RELEASE) {
    // POSIX: its own process group, so teardown can kill the npm→vite tree.
    vite = spawn("npm", ["run", "dev"], {
      cwd: ROOT,
      stdio: "pipe",
      shell: true,
      detached: !IS_WINDOWS,
    });
    vite.stderr?.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("error")) console.error("[vite]", msg.trim());
    });
    console.log("Waiting for Vite dev server...");
    await waitForUrl(VITE_URL, 30_000);
    console.log("Vite dev server ready.");
  }

  // On persistent (self-hosted) CI runners a crashed prior run can leave a
  // stray joybug-tauri.exe alive; WebView2 keys its browser process by the
  // shared user-data folder, so a new instance would attach to the stale one.
  // Guarded to release/CI so it never kills a developer's running app.
  if (RELEASE && IS_WINDOWS) {
    try {
      execSync("taskkill /IM joybug-tauri.exe /T /F", { stdio: "ignore" });
    } catch {
      // No stray process — nothing to kill.
    }
  }

  mkdirSync(E2E_DATA_DIR, { recursive: true });
}

/** Undo `prepareRun`. */
export function finishRun(): void {
  if (vite?.pid) killTree(vite.pid);
  vite = null;
  try {
    rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Non-fatal — the OS cleans the temp dir eventually
  }
}

/** Kill a process tree started by `prepareRun`. */
function killTree(pid: number): void {
  try {
    if (IS_WINDOWS) {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } else {
      // Spawned detached, so it leads its own process group: a negative pid
      // signals the whole group (npm → vite).
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Process may already have exited
  }
}

/**
 * Wait for the React app to mount (`#root` has children). On a fresh Vite dev
 * server the first page load transforms the whole module graph, which has
 * been measured at ~35s — the per-file `before` hook pays for that with its
 * own budget so no test's clock starts on a cold page.
 */
export async function waitForAppMount(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.getElementById("root");
    return !!root && root.children.length > 0;
  }, undefined, { timeout });
}
