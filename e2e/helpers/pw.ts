// A Playwright-shaped façade over WebdriverIO: `Page` and `Locator` with the
// subset of the Playwright API the specs use (getBy*, locator, filter, first,
// click, fill, evaluate, keyboard, mouse …), implemented on the WebDriver
// session `tauri-driver` opens into the app's real webview (WebKitGTK on
// Linux, WebView2 on Windows). The specs and helpers were written against
// Playwright; keeping its vocabulary here is what lets them run unchanged
// against the native webviews.
//
// A `Locator` is lazy: it records a chain of steps (css / test id / role /
// text / filter / nth) and resolves them in the page in one round trip, so
// every action and assertion sees the live DOM. Resolution runs through
// `$$(fn)` with the chain baked into the function's source — WebdriverIO then
// re-runs it whenever an element goes stale.

import { browser, $$ } from "@wdio/globals";
import { Key } from "webdriverio";
import { mkdirSync } from "fs";
import path from "path";

// ---- Locator chain steps and the in-page resolver ----

type Step =
  | { kind: "css"; selector: string }
  | { kind: "testid"; id: string }
  | { kind: "role"; role: string; name?: string | { re: string; flags: string }; exact?: boolean }
  | { kind: "text"; text: string | { re: string; flags: string }; exact?: boolean }
  | { kind: "placeholder"; text: string | { re: string; flags: string }; exact?: boolean }
  | { kind: "label"; text: string | { re: string; flags: string }; exact?: boolean }
  | { kind: "title"; text: string | { re: string; flags: string }; exact?: boolean }
  | { kind: "filter"; hasText?: string | { re: string; flags: string }; has?: Step[]; visible?: boolean; textIs?: string }
  | { kind: "nth"; index: number }; // -1 = last

type TextMatch = string | { re: string; flags: string };

function toMatch(value: string | RegExp): TextMatch {
  return value instanceof RegExp ? { re: value.source, flags: value.flags } : value;
}

/**
 * Runs inside the page. Self-contained (no closures): WebdriverIO ships its
 * source. Mirrors Playwright's selector engines closely enough for this
 * suite: `getByText` matches the innermost elements whose normalized text
 * matches (substring, case-insensitive; `exact` = whole string, case-
 * sensitive); `getByRole` matches explicit `role=` and the implicit roles of
 * the common tags, by accessible name (`aria-labelledby` → `aria-label` →
 * text → `title`; label/placeholder for text inputs), and skips hidden
 * elements — rc-dock keeps inactive panels mounted, so this matters.
 */
function resolveChain(steps: Step[], roots?: (Element | Document)[]): Element[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const matchText = (text: string, m: TextMatch | undefined, exact: boolean | undefined): boolean => {
    if (m === undefined) return true;
    const t = norm(text);
    if (typeof m !== "string") return new RegExp(m.re, m.flags).test(t);
    const want = norm(m);
    return exact ? t === want : t.toLowerCase().includes(want.toLowerCase());
  };
  const isHidden = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.getAttribute("aria-hidden") === "true") return true;
    }
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return true;
    return el.getClientRects().length === 0;
  };
  const isVisible = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden";
  };
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    switch (tag) {
      case "button": return "button";
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "main": return "main";
      case "nav": return "navigation";
      case "dialog": return "dialog";
      case "option": return "option";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "img": return "img";
      case "table": return "table";
      case "tr": return "row";
      case "td": return "cell";
      case "th": return "columnheader";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "input":
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "hidden") return null;
        return "textbox";
      default: return null;
    }
  };
  const labelText = (el: Element): string => {
    const byId = el.getAttribute("aria-labelledby");
    if (byId) {
      const parts = byId.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "");
      return parts.join(" ");
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return label.textContent ?? "";
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping !== el) return wrapping.textContent ?? "";
    return "";
  };
  const accessibleName = (el: Element, role: string): string => {
    const label = labelText(el);
    if (label) return label;
    if (role === "textbox" || role === "combobox" || role === "spinbutton" || role === "searchbox") {
      return el.getAttribute("placeholder") || el.getAttribute("title") || "";
    }
    if (role === "img") return el.getAttribute("alt") || el.getAttribute("title") || "";
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return text || el.getAttribute("title") || "";
  };
  const descendants = (root: Element | Document, selector: string): Element[] =>
    Array.from(root.querySelectorAll(selector));
  const allDescendants = (root: Element | Document): Element[] => descendants(root, "*");

  let current: (Element | Document)[] = roots ?? [document];
  for (const step of steps) {
    const next: Element[] = [];
    const seen = new Set<Element>();
    const push = (els: Element[]) => {
      for (const el of els) if (!seen.has(el)) { seen.add(el); next.push(el); }
    };
    switch (step.kind) {
      case "css": {
        // `:focus` / `:focus-within` are evaluated against document.activeElement:
        // without a focused toplevel (xvfb has no window manager) WebKit's
        // own pseudo-class never matches, while the element is focused.
        const focusWithin = step.selector.includes(":focus-within");
        const focus = !focusWithin && step.selector.includes(":focus");
        const sel = step.selector.replace(/:focus-within|:focus/g, "");
        for (const root of current) {
          let found = descendants(root, sel || "*");
          if (focus) found = found.filter((el) => el === document.activeElement);
          if (focusWithin) found = found.filter((el) => el.contains(document.activeElement));
          push(found);
        }
        break;
      }
      case "testid":
        for (const root of current) push(descendants(root, `[data-testid="${CSS.escape(step.id)}"]`));
        break;
      case "role":
        for (const root of current) {
          push(allDescendants(root).filter((el) => {
            if (roleOf(el) !== step.role) return false;
            if (isHidden(el)) return false;
            return matchText(accessibleName(el, step.role), step.name, step.exact);
          }));
        }
        break;
      case "text":
        for (const root of current) {
          // Innermost match: an element is skipped when a child element matches too.
          const candidates = allDescendants(root).filter((el) =>
            !["SCRIPT", "STYLE"].includes(el.tagName) && matchText(el.textContent ?? "", step.text, step.exact));
          const set = new Set(candidates);
          push(candidates.filter((el) => !Array.from(el.children).some((c) => set.has(c) || Array.from(c.querySelectorAll("*")).some((d) => set.has(d)))));
        }
        break;
      case "placeholder":
        for (const root of current) {
          push(descendants(root, "[placeholder]").filter((el) => matchText(el.getAttribute("placeholder") ?? "", step.text, step.exact)));
        }
        break;
      case "label":
        for (const root of current) {
          push(descendants(root, "input, textarea, select, [role=textbox], [role=switch], [role=checkbox], [role=combobox]")
            .filter((el) => matchText(labelText(el), step.text, step.exact)));
        }
        break;
      case "title":
        for (const root of current) {
          push(descendants(root, "[title]").filter((el) => matchText(el.getAttribute("title") ?? "", step.text, step.exact)));
        }
        break;
      case "filter":
        for (const root of current) {
          if (!(root instanceof Element)) continue;
          if (step.hasText !== undefined && !matchText(root.textContent ?? "", step.hasText, false)) continue;
          if (step.textIs !== undefined && norm(root.textContent ?? "") !== norm(step.textIs)) continue;
          if (step.visible !== undefined && isVisible(root) !== step.visible) continue;
          // `has`: the sub-chain must match within this element.
          if (step.has && resolveChain(step.has, [root]).length === 0) continue;
          push([root]);
        }
        break;
      case "nth": {
        const els = current.filter((r): r is Element => r instanceof Element);
        const pick = step.index < 0 ? els[els.length + step.index] : els[step.index];
        if (pick) push([pick]);
        break;
      }
    }
    current = next;
  }
  return current.filter((r): r is Element => r instanceof Element);
}

const RESOLVER_SRC = resolveChain.toString();

// Function sources shipped to the page were transpiled by tsx/esbuild, which
// wraps nested functions in its `__name(fn, "name")` keep-names helper; the
// page has no such helper, so a no-op one is defined before they run.
const DEFINE_NAME_HELPER = 'if (typeof globalThis.__name !== "function") globalThis.__name = function (f) { return f; };';

/** A `$$`-compatible function selector with the chain baked in. */
function chainSelector(steps: Step[]): () => HTMLElement[] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${DEFINE_NAME_HELPER} return (${RESOLVER_SRC})(${JSON.stringify(steps)});`) as () => HTMLElement[];
}

export interface LocatorOptions {
  hasText?: string | RegExp;
  has?: Locator;
  visible?: boolean;
}

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  force?: boolean;
  timeout?: number;
}

const ACTION_TIMEOUT = 5_000;

/** Playwright's visibility: a non-empty bounding box and no `visibility:
 *  hidden`. Evaluated in the page — WebDriver's own `isDisplayed` atom
 *  reports elements inside an animating dialog as hidden. */
async function elementVisible(el: WebdriverIO.Element): Promise<boolean> {
  try {
    return await browser.execute((e: Element) => {
      if (!e || !e.isConnected) return false;
      if (e.getClientRects().length === 0) return false;
      return getComputedStyle(e).visibility !== "hidden";
    }, el as unknown as Element);
  } catch (e) {
    // Re-rendered away between resolve and check: not visible any more.
    if (/stale element|not found/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

async function pollUntil<T>(fn: () => Promise<T | undefined>, timeout: number, what: string): Promise<T> {
  const start = Date.now();
  let delay = 50;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 250);
  }
}

export class Locator {
  constructor(readonly steps: Step[]) {}

  private chain(step: Step): Locator {
    return new Locator([...this.steps, step]);
  }

  // ---- composition ----
  locator(selector: string, opts?: LocatorOptions): Locator {
    // Playwright's `:text-is("x")` pseudo-class: the CSS part, filtered to
    // elements whose whole text is exactly "x".
    const textIs = /^(.*?):text-is\("((?:[^"\\]|\\.)*)"\)$/.exec(selector);
    // Playwright's `text=` engine: `text=/re/flags` or `text=substring`.
    const textEngine = /^text=(.*)$/.exec(selector);
    let l: Locator;
    if (textIs) {
      l = this.chain({ kind: "css", selector: textIs[1] || "*" }).chain({ kind: "filter", textIs: textIs[2] });
    } else if (textEngine) {
      const re = /^\/(.*)\/([a-z]*)$/.exec(textEngine[1]);
      l = this.chain({ kind: "text", text: re ? { re: re[1], flags: re[2] } : textEngine[1] });
    } else {
      l = this.chain({ kind: "css", selector });
    }
    if (opts) l = l.filter(opts);
    return l;
  }
  getByTestId(id: string): Locator { return this.chain({ kind: "testid", id }); }
  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return this.chain({ kind: "role", role, name: opts.name === undefined ? undefined : toMatch(opts.name), exact: opts.exact });
  }
  getByText(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.chain({ kind: "text", text: toMatch(text), exact: opts.exact });
  }
  getByPlaceholder(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.chain({ kind: "placeholder", text: toMatch(text), exact: opts.exact });
  }
  getByLabel(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.chain({ kind: "label", text: toMatch(text), exact: opts.exact });
  }
  getByTitle(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.chain({ kind: "title", text: toMatch(text), exact: opts.exact });
  }
  filter(opts: LocatorOptions): Locator {
    return this.chain({
      kind: "filter",
      hasText: opts.hasText === undefined ? undefined : toMatch(opts.hasText),
      has: opts.has?.steps,
      visible: opts.visible,
    });
  }
  first(): Locator { return this.chain({ kind: "nth", index: 0 }); }
  last(): Locator { return this.chain({ kind: "nth", index: -1 }); }
  nth(index: number): Locator { return this.chain({ kind: "nth", index }); }

  toString(): string {
    return this.steps.map((s) => {
      switch (s.kind) {
        case "css": return s.selector;
        case "testid": return `testid=${s.id}`;
        case "role": return `role=${s.role}${s.name !== undefined ? `[name=${JSON.stringify(s.name)}]` : ""}`;
        case "text": return `text=${JSON.stringify(s.text)}`;
        case "placeholder": return `placeholder=${JSON.stringify(s.text)}`;
        case "label": return `label=${JSON.stringify(s.text)}`;
        case "title": return `title=${JSON.stringify(s.text)}`;
        case "filter": return `filter(${JSON.stringify(s)})`;
        case "nth": return `nth=${s.index}`;
      }
    }).join(" >> ");
  }

  // ---- resolution ----
  /** All matching elements, right now. */
  async elements(): Promise<WebdriverIO.Element[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const arr = await $$(chainSelector(this.steps) as unknown as string);
        return Array.from(arr as unknown as WebdriverIO.Element[]);
      } catch (e) {
        // A node removed while the driver was creating its reference: resolve again.
        if (attempt >= 3 || !/stale element|not found/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
  }
  /** The first match, waiting up to `timeout` for one to exist. */
  async element(timeout = ACTION_TIMEOUT): Promise<WebdriverIO.Element> {
    return pollUntil(async () => (await this.elements())[0], timeout, `${this}`);
  }
  /** The first match that is displayed (and enabled when `enabled`). */
  private async actionable(timeout: number, enabled = false): Promise<WebdriverIO.Element> {
    return pollUntil(async () => {
      try {
        for (const el of await this.elements()) {
          if (!(await elementVisible(el))) continue;
          if (enabled && !(await el.isEnabled())) continue;
          return el;
        }
      } catch (e) {
        // The DOM moved under us (a re-render between resolve and check): resolve again.
        if (!/stale element|not found/i.test(String((e as Error)?.message ?? e))) throw e;
      }
      return undefined;
    }, timeout, `${this} to be actionable`);
  }

  /** Wait for the locator to reach `state` (default: visible). */
  async waitFor(opts: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number } = {}): Promise<void> {
    const state = opts.state ?? "visible";
    await pollUntil(async () => {
      const els = await this.elements();
      switch (state) {
        case "attached": return els.length > 0 ? true : undefined;
        case "detached": return els.length === 0 ? true : undefined;
        case "visible": return els.length > 0 && (await elementVisible(els[0])) ? true : undefined;
        case "hidden": return els.length === 0 || !(await elementVisible(els[0])) ? true : undefined;
      }
    }, opts.timeout ?? ACTION_TIMEOUT, `${this} to be ${state}`);
  }

  async count(): Promise<number> { return (await this.elements()).length; }
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }
  async isVisible(): Promise<boolean> {
    const els = await this.elements();
    return els.length > 0 && (await elementVisible(els[0]));
  }
  async isDisabled(): Promise<boolean> { return !(await (await this.element()).isEnabled()); }
  async isEnabled(): Promise<boolean> { return (await this.element()).isEnabled(); }
  async isChecked(): Promise<boolean> {
    const el = await this.element();
    const checked = await el.getAttribute("aria-checked");
    if (checked !== null) return checked === "true";
    const state = await el.getAttribute("data-state");
    if (state !== null) return state === "checked";
    return el.isSelected();
  }
  async innerText(): Promise<string> { return this.evaluate((el) => el.innerText); }
  async textContent(): Promise<string | null> {
    return this.evaluate((el) => el.textContent);
  }
  async allInnerTexts(): Promise<string[]> {
    return this.evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText));
  }
  async allTextContents(): Promise<string[]> {
    return this.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  }
  async getAttribute(name: string): Promise<string | null> {
    return (await this.element()).getAttribute(name);
  }
  async inputValue(): Promise<string> { return (await this.element()).getValue(); }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const els = await this.elements();
    if (!els.length) return null;
    const r = await browser.execute((el: Element) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }, els[0] as unknown as Element);
    return r;
  }

  // ---- actions (real WebDriver input) ----
  /** Resolve an actionable element and run `fn` on it; a stale reference
   *  (the DOM re-rendered in between) re-resolves and retries. */
  private async withActionable(timeout: number, enabled: boolean, fn: (el: WebdriverIO.Element) => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const el = await this.actionable(timeout, enabled);
      try {
        await fn(el);
        return;
      } catch (e) {
        if (attempt >= 3 || !/stale element|not found/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
  }
  async click(opts: ClickOptions = {}): Promise<void> {
    await this.withActionable(opts.timeout ?? ACTION_TIMEOUT, !opts.force, async (el) => {
      if ((opts.button ?? "left") === "left") {
        // The endpoint itself (scrolls into view, hit-tests, clicks); WebdriverIO's
        // `click()` wraps it in an interactability wait that misfires on WebKit.
        try {
          await browser.elementClick(el.elementId);
        } catch (e) {
          // WebKit's hit-test misses text in a clipped (`truncate`) inline box
          // until it is scrolled fully into view; the endpoint's own scroll
          // does not do that horizontally.
          if (!/not interactable/i.test(String((e as Error)?.message ?? e))) throw e;
          await el.scrollIntoView({ block: "center", inline: "center" });
          await browser.elementClick(el.elementId);
        }
        return;
      }
      // Pointer actions in one chain, move included: WebKitWebDriver presses at
      // (0, 0) when a down/up arrives without a move in the same request.
      await el.scrollIntoView({ block: "center", inline: "center" });
      const b = opts.button === "right" ? 2 : 1;
      await browser.action("pointer").move({ origin: el }).down({ button: b }).up({ button: b }).perform();
      await rememberPointer(el);
    });
  }
  async dblclick(opts: ClickOptions = {}): Promise<void> {
    await this.withActionable(opts.timeout ?? ACTION_TIMEOUT, !opts.force, async (el) => {
      await el.scrollIntoView({ block: "center", inline: "center" });
      await el.doubleClick();
      await rememberPointer(el);
    });
  }
  async hover(opts: { timeout?: number } = {}): Promise<void> {
    await this.withActionable(opts.timeout ?? ACTION_TIMEOUT, false, async (el) => {
      await el.scrollIntoView({ block: "center", inline: "center" });
      await el.moveTo();
      await rememberPointer(el);
    });
  }
  async focus(): Promise<void> {
    const el = await this.element();
    await browser.execute((e: HTMLElement) => e.focus(), el as unknown as HTMLElement);
  }
  /** Replace the field's value. Set through the native value setter and
   *  announced with `input`/`change`, so React's controlled inputs see it
   *  (typing it through the driver races the app's own key handling). */
  async fill(value: string, opts: { timeout?: number } = {}): Promise<void> {
    const el = await this.actionable(opts.timeout ?? ACTION_TIMEOUT, true);
    await browser.execute((e: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      e.focus();
      const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(e, v); else e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }, el as unknown as HTMLInputElement, value);
  }
  async press(key: string): Promise<void> {
    await this.focus();
    await browser.keys(chord(key));
  }
  async clear(): Promise<void> { await this.fill(""); }
  async check(): Promise<void> { if (!(await this.isChecked())) await this.click(); }
  async uncheck(): Promise<void> { if (await this.isChecked()) await this.click(); }
  async dispatchEvent(type: string, init: Record<string, unknown> = {}): Promise<void> {
    await this.evaluate((el, a) => { el.dispatchEvent(new Event(a.type, { bubbles: true, ...a.init })); }, { type, init });
  }

  // ---- scripting ----
  async evaluate<R, A = undefined>(fn: (el: HTMLElement, arg: A) => R, arg?: A): Promise<R> {
    const el = await this.element();
    return evaluateWith<R>(fn.toString(), arg, el);
  }
  async evaluateAll<R, A = undefined>(fn: (els: HTMLElement[], arg: A) => R, arg?: A): Promise<R> {
    const els = await this.elements();
    return evaluateWith<R>(fn.toString(), arg, els);
  }
}

/**
 * Run a function (given as source) in the page with `arg`, awaiting a
 * returned promise, and marshal the result or the error back. `handle` (an
 * element or element array) is passed as the first parameter when given.
 */
async function evaluateWith<R>(fnSrc: string, arg: unknown, handle?: unknown): Promise<R> {
  // An IIFE that defines the keep-names helper, then yields the function.
  const src = `(function () { ${DEFINE_NAME_HELPER} return (${fnSrc}); })()`;
  const res = await browser.executeAsync(
    function (src: string, arg: unknown, handle: unknown, hasHandle: boolean, done: (r: unknown) => void) {
      try {
        // eslint-disable-next-line no-eval
        const f = (0, eval)(src);
        const out = hasHandle ? f(handle, arg) : f(arg);
        Promise.resolve(out).then(
          (v: unknown) => done({ ok: v === undefined ? null : v }),
          (e: unknown) => done({ err: String((e as Error)?.message ?? e) }),
        );
      } catch (e) {
        done({ err: String((e as Error)?.message ?? e) });
      }
    },
    src, arg ?? null, handle ?? null, handle !== undefined,
  ) as { ok?: unknown; err?: string };
  if (res && typeof res === "object" && "err" in res && res.err !== undefined) throw new Error(res.err);
  return (res as { ok: R }).ok;
}

// ---- keyboard ----

const KEY_MAP: Record<string, string> = {
  Control: Key.Ctrl, Alt: Key.Alt, Shift: Key.Shift, Meta: Key.Command,
  Enter: Key.Enter, Escape: Key.Escape, Tab: Key.Tab, Backspace: Key.Backspace, Delete: Key.Delete,
  ArrowLeft: Key.ArrowLeft, ArrowRight: Key.ArrowRight, ArrowUp: Key.ArrowUp, ArrowDown: Key.ArrowDown,
  Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown, Space: Key.Space, Insert: Key.Insert,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6, F7: Key.F7, F8: Key.F8,
  F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
};

/** "Control+Shift+k" → the WebDriver key sequence (modifiers held). */
function chord(key: string): string | string[] {
  const parts = key.split("+");
  const keys = parts.map((p, i) => {
    if (KEY_MAP[p]) return KEY_MAP[p];
    // A letter in a chord is typed lower-case; Shift is its own modifier.
    return i === parts.length - 1 && p.length === 1 ? p.toLowerCase() : p;
  });
  return keys.length === 1 ? keys[0] : keys;
}

class Keyboard {
  async press(key: string): Promise<void> { await browser.keys(chord(key)); }
  async type(text: string): Promise<void> { await browser.keys(text.split("")); }
  async down(key: string): Promise<void> {
    await browser.action("key").down(KEY_MAP[key] ?? key).perform(true);
  }
  async up(key: string): Promise<void> {
    await browser.action("key").up(KEY_MAP[key] ?? key).perform();
  }
}

/** Last pointer position: `wheel` scrolls there (Playwright semantics), and
 *  `down`/`up` re-state it — WebKitWebDriver forgets the pointer position
 *  between action requests and would press at (0, 0). */
const pointer = { x: 0, y: 0 };

async function rememberPointer(el: WebdriverIO.Element): Promise<void> {
  const r = await browser.execute((e: Element) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, el as unknown as Element);
  pointer.x = r.x;
  pointer.y = r.y;
}

/** The page-level mouse: WebDriver pointer actions at viewport coordinates. */
class Mouse {
  /** `steps` spreads the move over intermediate positions (a drag that
   *  listeners sample needs more than one mousemove). */
  async move(x: number, y: number, opts: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, opts.steps ?? 1);
    const action = browser.action("pointer");
    for (let i = 1; i <= steps; i++) {
      action.move({ x: Math.round(x), y: Math.round(y), origin: "viewport", duration: steps > 1 ? 20 : 0 });
    }
    await action.perform(true);
    pointer.x = x;
    pointer.y = y;
  }
  async down(opts: { button?: "left" | "right" | "middle" } = {}): Promise<void> {
    await browser.action("pointer")
      .move({ x: Math.round(pointer.x), y: Math.round(pointer.y), origin: "viewport" })
      .down({ button: opts.button ?? "left" })
      .perform(true);
  }
  async up(opts: { button?: "left" | "right" | "middle" } = {}): Promise<void> {
    await browser.action("pointer")
      .move({ x: Math.round(pointer.x), y: Math.round(pointer.y), origin: "viewport" })
      .up({ button: opts.button ?? "left" })
      .perform();
  }
  async click(x: number, y: number, opts: { button?: "left" | "right" | "middle" } = {}): Promise<void> {
    await browser.action("pointer")
      .move({ x: Math.round(x), y: Math.round(y), origin: "viewport" })
      .down({ button: opts.button ?? "left" })
      .up({ button: opts.button ?? "left" })
      .perform();
  }
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await browser.action("wheel")
      .scroll({ x: Math.round(pointer.x), y: Math.round(pointer.y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) })
      .perform();
  }
}

// ---- Page ----

export class Page {
  readonly keyboard = new Keyboard();
  readonly mouse = new Mouse();
  private readonly root = new Locator([]);

  locator(selector: string, opts?: LocatorOptions): Locator { return this.root.locator(selector, opts); }
  getByTestId(id: string): Locator { return this.root.getByTestId(id); }
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator { return this.root.getByRole(role, opts); }
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator { return this.root.getByText(text, opts); }
  getByPlaceholder(text: string | RegExp, opts?: { exact?: boolean }): Locator { return this.root.getByPlaceholder(text, opts); }
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator { return this.root.getByLabel(text, opts); }
  getByTitle(text: string | RegExp, opts?: { exact?: boolean }): Locator { return this.root.getByTitle(text, opts); }

  /** Run a function in the page (a returned promise is awaited). Like
   *  Playwright, the function is shipped as source: it cannot close over
   *  Node-side variables — pass them through `arg`. */
  async evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return evaluateWith<R>(fn.toString(), arg);
  }

  async url(): Promise<string> { return browser.getUrl(); }
  async goto(url: string): Promise<void> { await browser.url(url); }
  async title(): Promise<string> { return browser.getTitle(); }

  async waitForURL(pattern: RegExp | string, opts: { timeout?: number } = {}): Promise<void> {
    await pollUntil(async () => {
      const u = await browser.getUrl();
      const ok = pattern instanceof RegExp ? pattern.test(u) : u.includes(pattern);
      return ok ? true : undefined;
    }, opts.timeout ?? ACTION_TIMEOUT, `URL ${pattern}`);
  }
  async waitForFunction<A>(fn: (arg: A) => unknown, arg?: A, opts: { timeout?: number } = {}): Promise<void> {
    await pollUntil(async () => ((await this.evaluate(fn, arg)) ? true : undefined), opts.timeout ?? ACTION_TIMEOUT, "waitForFunction");
  }
  /** Plain delay. The suite's rule is to poll for state instead; kept only
   *  for the two sites that need a true pause. */
  async waitForTimeout(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

  /** Window size as the WebDriver sees it (the outer window). */
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await browser.setWindowSize(size.width, size.height);
  }
  async windowSize(): Promise<{ width: number; height: number }> {
    const r = await browser.getWindowSize();
    return { width: r.width, height: r.height };
  }

  async screenshot(file: string): Promise<void> {
    mkdirSync(path.dirname(file), { recursive: true });
    await browser.saveScreenshot(file);
  }
}

/** The one page of the app under test. */
export const page = new Page();
