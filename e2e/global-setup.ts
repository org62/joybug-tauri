import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TAURI_BINARY = path.resolve(
  __dirname,
  "../src-tauri/target/debug/joybug-tauri.exe",
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
  // Check binary exists
  if (!existsSync(TAURI_BINARY)) {
    throw new Error(
      `Tauri binary not found at ${TAURI_BINARY}.\n` +
        `Run 'cd src-tauri && cargo build' first.`,
    );
  }

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

  // Launch Tauri binary with CDP enabled on WebView2
  const tauri: ChildProcess = spawn(TAURI_BINARY, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
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
