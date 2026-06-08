import { execSync } from "child_process";
import { rmSync } from "fs";

async function globalTeardown(): Promise<void> {
  const tauriPid = process.env.TAURI_PID;
  const vitePid = process.env.VITE_PID;

  if (tauriPid) {
    try {
      execSync(`taskkill /pid ${tauriPid} /T /F`, { stdio: "ignore" });
    } catch {
      // Process may already have exited
    }
  }

  if (vitePid) {
    try {
      execSync(`taskkill /pid ${vitePid} /T /F`, { stdio: "ignore" });
    } catch {
      // Process may already have exited
    }
  }

  // Clean up isolated e2e data directory
  const e2eDataDir = process.env.JOYBUG_E2E_DATA_DIR;
  if (e2eDataDir) {
    try {
      rmSync(e2eDataDir, { recursive: true, force: true });
    } catch {
      // Non-fatal — OS will clean up temp dir eventually
    }
  }
}

export default globalTeardown;
