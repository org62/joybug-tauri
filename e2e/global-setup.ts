import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In release mode (CI) the Tauri app embeds the built frontend, so we test
// against target/release and skip the Vite dev server. Locally we use the
// debug binary served by Vite.
const RELEASE = process.env.JOYBUG_E2E_RELEASE === "1";
const TAURI_BINARY = path.resolve(
  __dirname,
  `../src-tauri/target/${RELEASE ? "release" : "debug"}/joybug-tauri.exe`,
);
const VITE_URL = "http://localhost:1420";
const CDP_URL = "http://localhost:9222/json/version";

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

async function globalSetup(): Promise<void> {
  // Build the source-debugging fixtures (hello_c.exe / hello_asm.exe) with MSVC.
  // Build-if-stale, so this is a fast no-op on repeated runs.
  try {
    execSync(`node "${path.join(__dirname, "fixtures", "build.mjs")}"`, {
      stdio: "inherit",
    });
  } catch (e) {
    console.error("[fixtures] build failed:", e);
    throw e;
  }

  // Check binary exists
  if (!existsSync(TAURI_BINARY)) {
    throw new Error(
      `Tauri binary not found at ${TAURI_BINARY}.\n` +
        `Run '${RELEASE ? "npm run tauri build" : "cd src-tauri && cargo build"}' first.`,
    );
  }

  // The release binary embeds the built frontend, so no dev server is needed.
  if (!RELEASE) {
    // Start Vite dev server
    const vite: ChildProcess = spawn("npm", ["run", "dev"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: "pipe",
      shell: true,
    });

    // Store PID for teardown
    process.env.VITE_PID = String(vite.pid);

    // Forward Vite errors to console for debugging
    vite.stderr?.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("error")) {
        console.error("[vite]", msg.trim());
      }
    });

    console.log("Waiting for Vite dev server...");
    await waitForUrl(VITE_URL, 30_000);
    console.log("Vite dev server ready.");
  }

  // On persistent (self-hosted) CI runners a crashed prior run can leave a
  // stray joybug-tauri.exe alive. Because WebView2 keys its browser process by
  // the shared user-data folder, a new instance would attach to the stale one
  // and never open the --remote-debugging-port, breaking CDP. Kill strays
  // first. Guarded to release/CI so it never kills a developer's running app.
  if (RELEASE && process.platform === "win32") {
    try {
      execSync("taskkill /IM joybug-tauri.exe /T /F", { stdio: "ignore" });
    } catch {
      // No stray process — nothing to kill.
    }
  }

  // Create isolated data directory so e2e tests don't touch user's real
  // settings, breakpoints, patches, or pinned addresses.
  const e2eDataDir = path.join(os.tmpdir(), "joybug-e2e-data");
  mkdirSync(e2eDataDir, { recursive: true });
  process.env.JOYBUG_E2E_DATA_DIR = e2eDataDir;

  // Launch Tauri binary with CDP enabled on WebView2
  const tauri: ChildProcess = spawn(TAURI_BINARY, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
      JOYBUG_DATA_DIR: e2eDataDir,
      // The app is launched once here and every test attaches to the page it's
      // already mounted, so a startup modal or network call happens before any
      // fixture could suppress it. Gate both at the source: the welcome dialog
      // would block every test, and the update check would make the suite
      // depend on api.github.com.
      JOYBUG_NO_WELCOME: "1",
      JOYBUG_NO_UPDATE_CHECK: "1",
    },
    stdio: "pipe",
  });

  process.env.TAURI_PID = String(tauri.pid);

  tauri.stderr?.on("data", (data) => {
    const msg = data.toString();
    if (msg.includes("ERROR") || msg.includes("panic")) {
      console.error("[tauri]", msg.trim());
    }
  });

  console.log("Waiting for CDP endpoint...");
  await waitForUrl(CDP_URL, 30_000);
  console.log("CDP endpoint ready.");
}

export default globalSetup;
