// `@wdio/tauri-service` with its per-command hooks switched off.
//
// The service's `beforeCommand` runs "active window focus recovery" before
// every getTitle / findElement / $ / $$ / elementClick: it asks the optional
// `tauri-plugin-wdio` (which this app does not ship) for the window states
// and waits 5 s for a plugin that never answers — 5.4 s added to every such
// command. The app has one window and the suite never switches windows, so
// the recovery has nothing to do here. The launcher half (spawning
// tauri-driver, assigning ports, matching msedgedriver on Windows) is used
// unchanged.

import TauriWorkerService, { launcher as TauriLaunchService } from "@wdio/tauri-service";

export class QuietTauriWorkerService extends TauriWorkerService {
  async beforeCommand(): Promise<void> {}
  async afterCommand(): Promise<void> {}
}

/** The launcher half, unchanged. A class given to `services` is instantiated
 *  in both the launcher and the worker and answers only the hooks it defines,
 *  so the two halves are registered as two entries. */
export { TauriLaunchService };
