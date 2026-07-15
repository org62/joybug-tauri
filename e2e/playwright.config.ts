import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: 1,
  reporter: process.env.CI ? "html" : "list",
  timeout: 60_000,
  use: {
    trace: "on-first-retry",
  },
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  // Run fast tests first to absorb Vite warmup penalty (~10s) on cheap tests
  testMatch: [
    "routing.spec.ts",
    "keyboard-shortcuts.spec.ts",
    "patches.spec.ts",
    "bookmarks.spec.ts",
    "disassembly.spec.ts",
    "symbol-status.spec.ts",
    "types.spec.ts",
    "registers.spec.ts",
    "session-lifecycle.spec.ts",
    "stepping.spec.ts",
    "source-view.spec.ts",
    "attach-detach.spec.ts",
    "non-invasive.spec.ts",
    "strings-view.spec.ts",
  ],
});
