import { expect, type Page } from "./test-fixtures";
import { invoke } from "./session-helpers";

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

/** An instruction as carried by the `*-disassembly-updated` events. */
export interface EmittedInstruction {
  address: string;
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_patched?: boolean;
  original_bytes?: string;
  original_disasm?: string;
}

export const FN_DISASM_EVENT = "function-disassembly-updated";

/**
 * Request a function disassembly anchored at `address` (image-diffed) and
 * return that response's instructions. Requires `installEventCapture` for
 * `FN_DISASM_EVENT`. The address echo is part of the predicate: the view issues
 * its own requests concurrently and they share the bucket.
 */
export async function disassembleFunction(
  page: Page,
  sessionId: string,
  address: number,
  maxInstructions = 200,
): Promise<EmittedInstruction[]> {
  await clearCapturedEvents(page, FN_DISASM_EVENT);
  await invoke(page, "request_function_disassembly", { sessionId, address, maxInstructions, compareImage: true });
  const payload = await waitForCapturedEvent(
    page,
    FN_DISASM_EVENT,
    (p) =>
      p.session_id === sessionId &&
      p.address === address &&
      Array.isArray(p.instructions) &&
      p.instructions.length > 0,
  );
  return payload.instructions as EmittedInstruction[];
}

/**
 * A symbol's VA via the session symbol search, polled until the module's PDB
 * has finished loading. Requires `installEventCapture` for `symbols-updated`.
 * `exact` matches the whole name; otherwise any name containing `pattern`
 * counts (incremental linking also publishes `@ILT+N(fn)` thunks, so use
 * `exact` when the address itself matters).
 */
export async function resolveSymbolVa(
  page: Page,
  sessionId: string,
  pattern: string,
  { exact = false, timeout = 30_000 } = {},
): Promise<string> {
  let va = "";
  await expect(async () => {
    await invoke(page, "search_session_symbols", { sessionId, pattern, limit: 20 });
    const events = await getCapturedEvents(page, "symbols-updated");
    const hit = events
      .flatMap((e: { symbols?: { name?: string; va?: string }[] }) => e.symbols ?? [])
      .find((s) => typeof s.name === "string" && (exact ? s.name === pattern : s.name.includes(pattern)) && s.va);
    expect(hit, `${pattern} should resolve`).toBeTruthy();
    va = hit!.va!;
  }).toPass({ timeout, intervals: [50, 100, 250] });
  return va;
}
