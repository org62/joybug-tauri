import { spawn, ChildProcess } from "child_process";
import { IS_WINDOWS, fixtureExe } from "./launch-commands";

/**
 * Spawn a long-lived target process to attach to or open non-invasively.
 * Windows: `ping` loops for ~999 seconds without needing stdin. Linux: the
 * `sleeper_c` fixture, which also allows a non-ancestor to ptrace it (Yama).
 * Its image name is `ATTACH_TARGET_IMAGE`.
 */
export function spawnTarget(): ChildProcess {
  return IS_WINDOWS
    ? spawn("ping", ["127.0.0.1", "-n", "999"], { stdio: "ignore", windowsHide: true })
    : spawn(fixtureExe("sleeper_c"), [], { stdio: "ignore" });
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
