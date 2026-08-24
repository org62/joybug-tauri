import { chromium, Browser, Page } from "@playwright/test";

/**
 * How the suite reaches the running app, in one place. Both entry points need
 * it — global setup (to pay for the cold mount before any test's clock starts)
 * and the `tauriPage` fixture (once per test) — and two definitions of "the
 * app is up" would drift apart silently.
 */
export const CDP_PORT = 9222;
export const CDP_ENDPOINT = `http://localhost:${CDP_PORT}`;
export const CDP_VERSION_URL = `${CDP_ENDPOINT}/json/version`;

/** Attach to the already-running app and return its page. */
export async function connectToApp(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());
  return { browser, page };
}

/**
 * Wait for the React app to mount (a connect/load may arrive before render).
 * `timeoutMs` is the caller's budget: a warm page mounts in milliseconds, but
 * the first load against a fresh Vite dev server transforms the whole module
 * graph and has been measured at ~35s.
 */
export async function waitForAppMount(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      return !!root && root.children.length > 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
}
