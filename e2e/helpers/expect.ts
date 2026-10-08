// Playwright-shaped assertions on top of expect-webdriverio's `expect` (which
// is Jest's `expect` under the hood, so `toBe`, `toEqual`, `toContain`, … are
// the real thing). The web-first matchers — `toBeVisible`, `toHaveCount`,
// `toContainText`, … — retry until they pass or `timeout` elapses, exactly
// as Playwright's do, and `toPass` / `expect.poll` keep the suite's polling
// idiom. `.not` is honoured by polling until the negated condition holds.

import { expect as baseExpect } from "@wdio/globals";
import { Locator, Page } from "./pw";

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_INTERVALS = [50, 100, 250];

interface Opts { timeout?: number; intervals?: number[] }

async function retry<T>(
  fn: () => Promise<T>,
  { timeout = DEFAULT_TIMEOUT, intervals = DEFAULT_INTERVALS }: Opts,
): Promise<T> {
  const start = Date.now();
  let i = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() - start >= timeout) throw e;
      await new Promise((r) => setTimeout(r, intervals[Math.min(i++, intervals.length - 1)]));
    }
  }
}

type MatcherResult = { pass: boolean; message: () => string };

/** Poll `check` until its `pass` equals what the matcher wants (true, or
 *  false under `.not`), then report. */
async function poll(
  ctx: { isNot?: boolean },
  opts: Opts | undefined,
  check: () => Promise<MatcherResult>,
): Promise<MatcherResult> {
  const want = !ctx.isNot;
  const { timeout = DEFAULT_TIMEOUT, intervals = DEFAULT_INTERVALS } = opts ?? {};
  const start = Date.now();
  let i = 0;
  let last: MatcherResult;
  for (;;) {
    last = await check();
    if (last.pass === want) return last;
    if (Date.now() - start >= timeout) return last;
    await new Promise((r) => setTimeout(r, intervals[Math.min(i++, intervals.length - 1)]));
  }
}

const textMatches = (actual: string, expected: string | RegExp, exact: boolean): boolean => {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  if (expected instanceof RegExp) return expected.test(norm(actual));
  return exact ? norm(actual) === norm(expected) : norm(actual).includes(norm(expected));
};

const describe = (received: unknown): string =>
  received instanceof Locator ? `locator(${received})` : String(received);

const locatorMatchers = {
  async toBeVisible(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const visible = await received.isVisible();
      return { pass: visible, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be visible` };
    });
  },
  async toBeHidden(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const visible = await received.isVisible();
      return { pass: !visible, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be hidden` };
    });
  },
  async toBeAttached(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const n = await received.count();
      return { pass: n > 0, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be attached` };
    });
  },
  async toHaveCount(this: { isNot?: boolean }, received: Locator, expected: number, opts?: Opts) {
    let actual = -1;
    return poll(this, opts, async () => {
      actual = await received.count();
      return { pass: actual === expected, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to have count ${expected}, got ${actual}` };
    });
  },
  async toHaveText(this: { isNot?: boolean }, received: Locator, expected: string | RegExp | (string | RegExp)[], opts?: Opts) {
    let actual: string | string[] = "";
    return poll(this, opts, async () => {
      if (Array.isArray(expected)) {
        actual = await received.allInnerTexts();
        const pass = actual.length === expected.length && expected.every((e, i) => textMatches((actual as string[])[i], e, true));
        return { pass, message: () => `expected texts ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
      }
      const els = await received.elements();
      actual = els.length ? await received.textContent() ?? "" : "";
      return { pass: els.length > 0 && textMatches(actual, expected, true), message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to have text ${String(expected)}, got ${JSON.stringify(actual)}` };
    });
  },
  async toContainText(this: { isNot?: boolean }, received: Locator, expected: string | RegExp, opts?: Opts) {
    let actual = "";
    return poll(this, opts, async () => {
      const els = await received.elements();
      actual = els.length ? await received.textContent() ?? "" : "";
      return { pass: els.length > 0 && textMatches(actual, expected, false), message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to contain text ${String(expected)}, got ${JSON.stringify(actual)}` };
    });
  },
  async toHaveAttribute(this: { isNot?: boolean }, received: Locator, name: string, expected?: string | RegExp | Opts, opts?: Opts) {
    // `toHaveAttribute(name)` — presence only — takes options as the third argument.
    if (expected !== undefined && typeof expected === "object" && !(expected instanceof RegExp)) { opts = expected; expected = undefined; }
    let actual: string | null = null;
    return poll(this, opts, async () => {
      const els = await received.elements();
      actual = els.length ? await els[0].getAttribute(name) : null;
      const pass = actual !== null && (expected === undefined || textMatches(actual, expected as string | RegExp, true));
      return { pass, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to have attribute ${name}${expected !== undefined ? `=${String(expected)}` : ""}, got ${JSON.stringify(actual)}` };
    });
  },
  async toHaveValue(this: { isNot?: boolean }, received: Locator, expected: string | RegExp, opts?: Opts) {
    let actual = "";
    return poll(this, opts, async () => {
      const els = await received.elements();
      actual = els.length ? await els[0].getValue() : "";
      return { pass: els.length > 0 && textMatches(actual, expected, true), message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to have value ${String(expected)}, got ${JSON.stringify(actual)}` };
    });
  },
  async toHaveClass(this: { isNot?: boolean }, received: Locator, expected: string | RegExp, opts?: Opts) {
    let actual: string | null = null;
    return poll(this, opts, async () => {
      const els = await received.elements();
      actual = els.length ? await els[0].getAttribute("class") : null;
      return { pass: actual !== null && textMatches(actual, expected, expected instanceof RegExp ? true : false), message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to have class ${String(expected)}, got ${JSON.stringify(actual)}` };
    });
  },
  async toBeEnabled(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const els = await received.elements();
      const enabled = els.length > 0 && (await els[0].isEnabled());
      return { pass: enabled, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be enabled` };
    });
  },
  async toBeDisabled(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const els = await received.elements();
      const disabled = els.length > 0 && !(await els[0].isEnabled());
      return { pass: disabled, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be disabled` };
    });
  },
  async toBeChecked(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const els = await received.elements();
      const checked = els.length > 0 && (await received.isChecked());
      return { pass: checked, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be checked` };
    });
  },
  async toBeFocused(this: { isNot?: boolean }, received: Locator, opts?: Opts) {
    return poll(this, opts, async () => {
      const focused = (await received.count()) > 0 && (await received.evaluate((el) => el === document.activeElement));
      return { pass: focused, message: () => `expected ${describe(received)} ${this.isNot ? "not " : ""}to be focused` };
    });
  },
  async toHaveURL(this: { isNot?: boolean }, received: Page, expected: string | RegExp, opts?: Opts) {
    let actual = "";
    return poll(this, opts, async () => {
      actual = await received.url();
      const pass = expected instanceof RegExp ? expected.test(actual) : actual === expected;
      return { pass, message: () => `expected page ${this.isNot ? "not " : ""}to have URL ${String(expected)}, got ${actual}` };
    });
  },
  /** `expect(async () => { … }).toPass({ timeout, intervals })` — retry the
   *  callback until it stops throwing. */
  async toPass(this: { isNot?: boolean }, received: () => Promise<unknown> | unknown, opts?: Opts) {
    try {
      await retry(async () => { await received(); }, opts ?? {});
      return { pass: true, message: () => "expected callback to keep failing" };
    } catch (e) {
      return { pass: false, message: () => `toPass: ${(e as Error)?.message ?? e}` };
    }
  },
};

baseExpect.extend(locatorMatchers);

/** `expect.poll(fn, opts).toBe(x)` etc.: re-evaluate `fn` until the plain
 *  matcher passes. */
function pollMatchers(fn: () => Promise<unknown> | unknown, opts: Opts = {}): Record<string, (...a: unknown[]) => Promise<void>> {
  return new Proxy({}, {
    get(_t, name: string) {
      return async (...args: unknown[]) => {
        await retry(async () => {
          const value = await fn();
          (baseExpect(value) as unknown as Record<string, (...a: unknown[]) => void>)[name](...args);
        }, opts);
      };
    },
  }) as Record<string, (...a: unknown[]) => Promise<void>>;
}
(baseExpect as unknown as { poll: typeof pollMatchers }).poll = pollMatchers;


/** Typed surface of the extended `expect`. Like Playwright's, every matcher is
 *  offered on every receiver (the runtime checks the receiver); the second
 *  argument is an optional failure message, accepted and ignored. */
export interface LocatorAssertions {
  toBeVisible(opts?: Opts): Promise<void>;
  toBeHidden(opts?: Opts): Promise<void>;
  toBeAttached(opts?: Opts): Promise<void>;
  toHaveCount(n: number, opts?: Opts): Promise<void>;
  toHaveText(expected: string | RegExp | (string | RegExp)[], opts?: Opts): Promise<void>;
  toContainText(expected: string | RegExp, opts?: Opts): Promise<void>;
  toHaveAttribute(name: string, expected?: string | RegExp | Opts, opts?: Opts): Promise<void>;
  toHaveValue(expected: string | RegExp, opts?: Opts): Promise<void>;
  toHaveClass(expected: string | RegExp, opts?: Opts): Promise<void>;
  toBeEnabled(opts?: Opts): Promise<void>;
  toBeDisabled(opts?: Opts): Promise<void>;
  toBeChecked(opts?: Opts): Promise<void>;
  toBeFocused(opts?: Opts): Promise<void>;
  toHaveURL(expected: string | RegExp, opts?: Opts): Promise<void>;
  toPass(opts?: Opts): Promise<void>;
}
type JestMatchers<T> = ReturnType<typeof baseExpect<T>>;
export type Assertions<T> = Omit<JestMatchers<T>, "not"> & LocatorAssertions & {
  not: Omit<JestMatchers<T>, "not"> & LocatorAssertions;
};

interface PwExpect {
  <T>(received: T, message?: string): Assertions<T>;
  poll(fn: () => Promise<unknown> | unknown, opts?: Opts): {
    toBe(v: unknown): Promise<void>;
    toEqual(v: unknown): Promise<void>;
    toBeTruthy(): Promise<void>;
    toBeFalsy(): Promise<void>;
    toBeGreaterThan(v: number): Promise<void>;
    toBeGreaterThanOrEqual(v: number): Promise<void>;
    toBeLessThan(v: number): Promise<void>;
    toBeLessThanOrEqual(v: number): Promise<void>;
    toContain(v: unknown): Promise<void>;
    toMatch(v: string | RegExp): Promise<void>;
    toHaveLength(n: number): Promise<void>;
  };
  stringContaining(s: string): unknown;
  stringMatching(s: string | RegExp): unknown;
  objectContaining(o: object): unknown;
  arrayContaining(a: unknown[]): unknown;
  any(c: unknown): unknown;
  anything(): unknown;
}

// Playwright's `expect(value, "message")` carries an optional failure message
// that Jest's `expect` rejects ("Expect takes at most one argument"); accept
// and drop it. The static helpers (`poll`, `stringContaining`, ...) come along.
function pwExpect(received: unknown, _message?: string) {
  return baseExpect(received);
}
Object.assign(pwExpect, baseExpect);
export const expect = pwExpect as unknown as PwExpect;
