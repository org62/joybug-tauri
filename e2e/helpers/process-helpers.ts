import { spawn, ChildProcess } from "child_process";

/**
 * Spawn a long-lived target process to attach to or open non-invasively.
 * `ping` loops for ~999 seconds without needing stdin, so it stays alive for
 * the whole test.
 */
export function spawnTarget(): ChildProcess {
  return spawn("ping", ["127.0.0.1", "-n", "999"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** True if a PID is still running (signal 0 is a liveness probe, not a kill). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we can't signal it — still alive.
    return e?.code === "EPERM";
  }
}

export function killQuietly(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}
