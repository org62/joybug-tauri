// The `test` the specs were written against, on Mocha: `test(name, async
// ({ tauriPage: page }) => …)`, `test.describe`, `test.beforeEach`,
// `test.skip(condition, reason)`, `test.setTimeout(ms)`. The per-test setup and
// cleanup the Playwright fixture did (`lifecycle.ts`) runs around each test
// here — once per test, whichever of the spec's `beforeEach` or the test body
// reaches the page first.

import path from "path";
import { mkdirSync, writeFileSync } from "fs";
import { page, Page } from "./pw";
import { afterTest, beforeTest } from "./lifecycle";

export interface Fixtures { tauriPage: Page }
export interface TestInfo {
  title: string;
  workerIndex: number;
  repeatEachIndex: number;
  /** The spec file's base name, for naming artifacts. */
  file: string;
}
type Body = (fixtures: Fixtures, info: TestInfo) => Promise<void> | void;
type HookBody = (fixtures: Fixtures) => Promise<void> | void;

const RESULTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../results");

let current: Mocha.Context | null = null;
let prepared = false;

function infoOf(ctx: Mocha.Context): TestInfo {
  const t = ctx.currentTest ?? ctx.test;
  return {
    title: t?.title ?? "",
    workerIndex: 0,
    repeatEachIndex: 0,
    file: path.basename(t?.file ?? "spec").replace(/\.spec\.ts$/, ""),
  };
}

async function prepare(ctx: Mocha.Context): Promise<void> {
  current = ctx;
  if (prepared) return;
  prepared = true;
  await beforeTest(page);
}

async function finish(ctx: Mocha.Context, failed: boolean): Promise<void> {
  prepared = false;
  if (failed) {
    // A screenshot and a DOM snapshot (URL + markup), each on a short leash
    // so a wedged driver can't eat the rest of the budget.
    const info = infoOf(ctx);
    const name = `${info.file}__${info.title}`.replace(/[^\w.-]+/g, "_").slice(0, 150);
    const leash = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
    try {
      await leash(page.screenshot(path.join(RESULTS_DIR, "screenshots", `${name}.png`)), 8_000);
    } catch { /* page may be gone */ }
    try {
      const snapshot = await leash(page.evaluate(() => `<!-- ${location.href} -->\n${document.documentElement.outerHTML}`), 3_000);
      mkdirSync(path.join(RESULTS_DIR, "dom"), { recursive: true });
      writeFileSync(path.join(RESULTS_DIR, "dom", `${name}.html`), snapshot);
    } catch { /* page may be gone */ }
  }
  try { await afterTest(page); } catch { /* best effort */ }
  current = null;
}

export function test(name: string, body: Body): void {
  it(name, async function () {
    await prepare(this);
    try {
      await body({ tauriPage: page }, infoOf(this));
    } catch (e) {
      // A `this.skip()` inside the body surfaces as Mocha's Pending; not a failure.
      const pending = (e as { pending?: boolean })?.pending === true || String((e as Error)?.message ?? e).includes("sync skip");
      await finish(this, !pending);
      throw e;
    }
    await finish(this, false);
  });
}

test.describe = function (name: string, body: () => void): void {
  describe(name, body);
};
test.beforeEach = function (body: HookBody): void {
  beforeEach(async function () {
    await prepare(this);
    await body({ tauriPage: page });
  });
};
test.afterEach = function (body: HookBody): void {
  afterEach(async function () {
    await body({ tauriPage: page });
  });
};
/** Skip the running test when `condition` holds (or unconditionally). */
test.skip = function (condition: boolean | string = true, _reason?: string): void {
  if (typeof condition === "string" || condition) current?.skip();
};
/** Extend the running test's budget. */
test.setTimeout = function (ms: number): void {
  current?.timeout(ms);
};

export { expect } from "./expect";
