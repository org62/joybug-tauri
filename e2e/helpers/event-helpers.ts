import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Capture Tauri events into per-event buckets on the window, using the same
 * low-level plumbing (`transformCallback` + `plugin:event|listen`) the app's
 * `listen()` is built on. Tests poll the buckets: many backend commands are
 * fire-and-forget and deliver their results via events, not return values.
 *
 * A bucket captures ALL payloads for its event — including ones the app's own
 * views trigger concurrently — so callers should match by predicate rather
 * than by position.
 */
export async function installEventCapture(page: Page, events: string[]): Promise<void> {
  await page.evaluate((names) => {
    const I = (window as any).__TAURI_INTERNALS__;
    const w = window as any;
    w.__capturedEvents = w.__capturedEvents ?? {};
    return Promise.all(names.map((name: string) => {
      w.__capturedEvents[name] = [];
      const handler = I.transformCallback((e: any) => { w.__capturedEvents[name].push(e.payload); });
      return I.invoke("plugin:event|listen", { event: name, target: { kind: "Any" }, handler });
    }));
  }, events);
}

export async function getCapturedEvents(page: Page, event: string): Promise<any[]> {
  return page.evaluate((name) => (window as any).__capturedEvents?.[name] ?? [], event);
}

/** Clear a bucket so the next action's payload can be matched cleanly. */
export async function clearCapturedEvents(page: Page, event: string): Promise<void> {
  await page.evaluate((name) => { (window as any).__capturedEvents[name] = []; }, event);
}

/** Poll until a captured payload satisfies `predicate`, then return it. */
export async function waitForCapturedEvent(
  page: Page,
  event: string,
  predicate: (p: any) => boolean,
  timeout = 10_000,
): Promise<any> {
  let match: any;
  await expect(async () => {
    const all = await getCapturedEvents(page, event);
    match = all.find(predicate);
    expect(match).toBeTruthy();
  }).toPass({ timeout, intervals: [50, 100, 200] });
  return match;
}
