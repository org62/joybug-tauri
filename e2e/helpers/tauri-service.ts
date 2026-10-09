// `@wdio/tauri-service` with its per-command hooks switched off.
//
// The service's `beforeCommand` runs "active window focus recovery" before
// every getTitle / findElement / $ / $$ / elementClick: it asks the optional
// `tauri-plugin-wdio` (which this app does not ship) for the window states
// and waits 5 s for a plugin that never answers — 5.4 s added to every such
// command. The app has one window and the suite never switches windows, so
// the recovery has nothing to do here. The launcher half (spawning
// tauri-driver, assigning ports, matching msedgedriver on Windows) is used
// unchanged — except for its shutdown on Windows, see `TauriLaunchService`.

import { execSync } from "child_process";
import TauriWorkerService, { launcher as UpstreamLaunchService } from "@wdio/tauri-service";

export class QuietTauriWorkerService extends TauriWorkerService {
  async beforeCommand(): Promise<void> {}
  async afterCommand(): Promise<void> {}
}

/** The launcher half. A class given to `services` is instantiated in both the
 *  launcher and the worker and answers only the hooks it defines, so the two
 *  halves are registered as two entries.
 *
 *  On Windows the service starts tauri-driver through a shell (`cmd.exe`) and
 *  stops it by killing that shell alone, which orphans tauri-driver and the
 *  msedgedriver it spawned — one pair left behind per run. Take the whole
 *  tree down before the service's own shutdown gets to the shell. */
export class TauriLaunchService extends UpstreamLaunchService {
  async onComplete(...args: Parameters<UpstreamLaunchService["onComplete"]>): Promise<void> {
    if (process.platform === "win32") {
      const pool = (this as unknown as { driverPool?: { getRunningPids?: () => number[] } }).driverPool;
      for (const pid of pool?.getRunningPids?.() ?? []) {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
    }
    await super.onComplete(...args);
  }
}
