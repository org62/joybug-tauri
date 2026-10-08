// WebdriverIO configuration: the E2E suite against the app's real webview on
// every OS, through tauri-driver (WebKitWebDriver on Linux, msedgedriver /
// WebView2 on Windows). One app process per spec file; Mocha; the Playwright-
// shaped `test`/`expect`/`Page` of e2e/helpers.
//
//   npm run test:e2e                      # whole suite (xvfb-run -a … on a headless host)
//   npx wdio run e2e/wdio.conf.ts --spec e2e/tests/stepping.spec.ts
//   JOYBUG_E2E_RELEASE=1 npm run test:e2e # the built binary (CI)

import path from "path";
import { browser } from "@wdio/globals";
import { fileURLToPath } from "url";
import { APP_ENV, TAURI_BINARY, finishRun, prepareRun } from "./helpers/app";
import { IS_WINDOWS } from "./helpers/launch-commands";
import { QuietTauriWorkerService, TauriLaunchService } from "./helpers/tauri-service";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The app's environment, inherited by tauri-driver → native driver → app.
// Set at module level: this file is evaluated in the launcher and in every
// worker, and the service spawns the driver from the worker.
Object.assign(process.env, APP_ENV);

/**
 * Specs that are Windows-only by nature (PE reader/viewer, WOW64, drag-drop of
 * system PEs, PDB persistence, the ntdll-types spec). Everything else runs on
 * both OSes; a spec that is Linux-only by nature (`signals`, `linux-platform`)
 * skips itself on Windows.
 */
const WINDOWS_ONLY_SPECS = [
  "drag-drop.spec.ts",
  "overlapping-instructions.spec.ts",
  "pe-anchor-labels.spec.ts",
  "pe-reader.spec.ts",
  "pe-static-analysis.spec.ts",
  "pe-viewer-session.spec.ts",
  "wow64.spec.ts",
];

const TAURI_SERVICE_OPTIONS = {
  // The cargo-installed tauri-driver in front of the OS's WebDriver; on
  // Windows the matching msedgedriver is downloaded automatically.
  driverProvider: "external" as const,
  autoInstallTauriDriver: false,
  autoDownloadEdgeDriver: true,
  tauriDriverPort: 4444,
  startTimeout: 60_000,
  // The app's environment, through the driver (see also the process.env
  // assignment above, for the worker itself).
  env: APP_ENV,
};

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/**/*.spec.ts"],
  exclude: IS_WINDOWS ? [] : WINDOWS_ONLY_SPECS.map((f) => `./tests/${f}`),
  // One app at a time: the debug sessions it runs are host processes.
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      maxInstances: 1,
      "tauri:options": {
        application: TAURI_BINARY,
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [
    // The Tauri service minus its per-command plugin probing (see tauri-service.ts).
    [TauriLaunchService as unknown as string, TAURI_SERVICE_OPTIONS],
    [QuietTauriWorkerService as unknown as string, TAURI_SERVICE_OPTIONS],
  ],
  logLevel: "warn",
  outputDir: path.join(HERE, "results/logs"),
  // Element waits: the suite polls fast (backend answers in <50ms).
  waitforTimeout: 5_000,
  waitforInterval: 50,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 1,
  // Zero tolerance for flaky tests: a retry would only hide one.
  specFileRetries: 0,
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000,
    retries: 0,
  },
  reporters: [
    "spec",
    ["junit", { outputDir: path.join(HERE, "results/junit"), outputFileFormat: (o: { cid: string }) => `results-${o.cid}.xml` }],
  ],

  onPrepare: async () => {
    await prepareRun();
  },
  // Per spec file, once the app is up: a fixed window size so layout-dependent
  // steps (dock panel widths, operand links in truncated rows, context-menu
  // placement) see the same geometry on every host. The X screen must be
  // larger than this: `xvfb-run -s "-screen 0 1920x1080x24"`.
  before: async () => {
    await browser.setWindowSize(1600, 1000);
  },
  onComplete: async () => {
    finishRun();
  },
};
