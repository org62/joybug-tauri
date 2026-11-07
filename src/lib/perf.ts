/**
 * Frontend half of the opt-in performance telemetry (Rust side:
 * `src-tauri/src/telemetry/`). Everything here is a no-op until the backend
 * says telemetry is on; then measurements are batched to `telemetry_record`
 * once a second.
 *
 * A record is a name of ours (`ui.*`), a start, a duration and numbers. Never
 * put anything from the target (an address, a symbol, a path) in a name or an
 * attribute key — the backend rejects records that don't look like ours, and
 * values are numbers by type.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TelemetryStatus {
  active: boolean;
  url: string | null;
  /** Whether the collector at `url` took the last batch; null before the first try. */
  connected: boolean | null;
  recording_to_file: boolean;
  sent_records: number;
  sent_batches: number;
  failed_batches: number;
  dropped: number;
  last_error: string | null;
  file: string | null;
}

/** Backend event: the telemetry switches changed (payload: `TelemetryStatus`). */
const TELEMETRY_STATUS_EVENT = "telemetry-status-changed";

/**
 * What the telemetry is doing right now: the backend's answer, followed
 * through `telemetry-status-changed` and, with `pollMs`, re-read on a timer
 * (the counters move without an event).
 */
export function useTelemetryStatus(pollMs?: number): TelemetryStatus | null {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  useEffect(() => {
    const refresh = () => { invoke<TelemetryStatus>("telemetry_status").then(setStatus).catch(() => {}); };
    refresh();
    const timer = pollMs ? setInterval(refresh, pollMs) : null;
    const unlisten = listen<TelemetryStatus>(TELEMETRY_STATUS_EVENT, (event) => setStatus(event.payload));
    return () => {
      if (timer) clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, [pollMs]);
  return status;
}

/**
 * Why the disassembly view asked for a listing; the suffix of the
 * `ui.asm.load.<reason>` span name.
 */
export type AsmLoadReason = "navigation" | "pc_follow" | "patches_updated" | "symbols_loaded" | "refresh";

interface PerfRecord {
  n: string;
  /** Start, microseconds since the Unix epoch (the backend's clock). */
  t: number;
  /** Duration, microseconds. */
  d: number;
  s?: string;
  a?: Record<string, number>;
}

/**
 * What the UI's spans measure; the frontend half of `INSTRUMENTATION` in
 * `src-tauri/src/telemetry/anonymize.rs`. Bump both with every change to the
 * instrumentation, so a recording says whether the client already has it.
 */
const UI_INSTRUMENTATION = 3;

const FLUSH_MS = 1000;
const MAX_QUEUED = 4000;
/** A frame gap this long counts as a stall where `longtask` isn't supported. */
const STALL_MS = 100;

let active = false;
let queue: PerfRecord[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let stopWatchingStalls: (() => void) | null = null;

/** `performance.now()` as microseconds since the Unix epoch. */
const toEpochUs = (nowMs: number) => Math.round((performance.timeOrigin + nowMs) * 1000);

/** Record a span that started at `startMs` (a `performance.now()` value). */
export function perfRecord(name: string, startMs: number, durationMs: number, attrs?: Record<string, number>, sessionId?: string | null): void {
  if (!active || queue.length >= MAX_QUEUED) return;
  const record: PerfRecord = { n: name, t: toEpochUs(startMs), d: Math.max(0, Math.round(durationMs * 1000)) };
  if (attrs) record.a = attrs;
  if (sessionId) record.s = sessionId;
  queue.push(record);
}

function flush(): void {
  if (queue.length === 0) return;
  const records = queue;
  queue = [];
  invoke("telemetry_record", { records }).catch(() => {
    // Telemetry never surfaces its own failures in the UI.
  });
}

function setActive(next: boolean): void {
  if (next === active) return;
  active = next;
  if (active) {
    perfRecord("ui.instrumentation", performance.now(), 0, { revision: UI_INSTRUMENTATION });
    flushTimer = setInterval(flush, FLUSH_MS);
    stopWatchingStalls = watchStalls();
  } else {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    stopWatchingStalls?.();
    stopWatchingStalls = null;
    // Recorded while it was on: still delivered (the backend takes it for a
    // moment after a switch-off).
    flush();
    pendingStep = null;
    pendingAsmLoad = null;
  }
}

/** Main-thread stalls: `longtask` entries where the webview has them, else frame gaps. */
function watchStalls(): () => void {
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfRecord("ui.longtask", entry.startTime, entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    return () => observer.disconnect();
  }
  let last = performance.now();
  let handle = requestAnimationFrame(function tick(now) {
    // A hidden window gets no frames at all; that is not a stall.
    if (now - last >= STALL_MS && document.visibilityState === "visible") {
      perfRecord("ui.longtask", last, now - last, { frame_gap: 1 });
    }
    last = now;
    handle = requestAnimationFrame(tick);
  });
  const onVisibility = () => { last = performance.now(); };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    cancelAnimationFrame(handle);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Start following the backend's telemetry switch. Called once at startup. */
export function initPerf(): void {
  invoke<TelemetryStatus>("telemetry_status")
    .then((status) => setActive(status.active))
    .catch(() => {});
  void listen<TelemetryStatus>(TELEMETRY_STATUS_EVENT, (event) => setActive(event.payload.active));
  window.addEventListener("pagehide", flush);
}

/**
 * `invoke`, timed as `ui.invoke.<name>` while telemetry is on. `attrs` reads
 * the numbers worth recording off a successful result (a row count).
 */
export async function perfInvoke<T>(
  name: string,
  cmd: string,
  args?: InvokeArgs,
  sessionId?: string | null,
  attrs?: (result: T) => Record<string, number>,
): Promise<T> {
  if (!active) return invoke<T>(cmd, args);
  const start = performance.now();
  let result: T | undefined;
  try {
    result = await invoke<T>(cmd, args);
    return result;
  } finally {
    perfRecord(`ui.invoke.${name}`, start, performance.now() - start, result !== undefined && attrs ? attrs(result) : undefined, sessionId);
  }
}

/** How often `perfWatchWait` reports a wait that is still going. */
const WAIT_HEARTBEAT_MS = 5000;

/**
 * Report a wait that may never end (a spinner): every few seconds until the
 * returned function is called, `name` is recorded spanning the wait so far.
 * A span is only recorded when it finishes, so without this a hung request
 * leaves no trace at all.
 */
export function perfWatchWait(name: string, sessionId?: string | null): () => void {
  if (!active) return () => {};
  const start = performance.now();
  let beats = 0;
  const timer = setInterval(() => perfRecord(name, start, performance.now() - start, { beats: ++beats }, sessionId), WAIT_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * Times a component's render through commit as `ui.render.<name>`: from the
 * start of its render function to its layout effect, which runs once its whole
 * subtree has rendered and been committed.
 */
export function usePerfRender(name: string): void {
  const start = active ? performance.now() : 0;
  // No dependency list on purpose: every commit is a measurement.
  useLayoutEffect(() => {
    if (start) perfRecord(`ui.render.${name}`, start, performance.now() - start);
  });
}

// ---------------------------------------------------------------------------
// Step latency: step issued -> pause event -> disassembly committed -> painted
// ---------------------------------------------------------------------------

interface PendingStep {
  sessionId: string;
  issued: number;
  /** The pause the step started from, to tell its own pause from a re-emit. */
  fromPause: string | null;
  sawRunning: boolean;
  eventAt: number | null;
  reloaded: boolean;
}

let pendingStep: PendingStep | null = null;
let lastPause: string | null = null;

function finishStep(step: PendingStep, commitAt: number | null, paintAt: number | null): void {
  if (step.eventAt === null) return;
  const end = paintAt ?? commitAt ?? step.eventAt;
  perfRecord("ui.step", step.issued, end - step.issued, {
    event_us: Math.round((step.eventAt - step.issued) * 1000),
    commit_us: commitAt === null ? 0 : Math.round((commitAt - step.eventAt) * 1000),
    paint_us: commitAt === null || paintAt === null ? 0 : Math.round((paintAt - commitAt) * 1000),
    reloaded: step.reloaded ? 1 : 0,
    // 0: the disassembly view was not there to show the result.
    viewed: commitAt === null ? 0 : 1,
  }, step.sessionId);
}

/** The user asked for an instruction step. */
export function perfStepIssued(sessionId: string): void {
  if (!active) return;
  // A step still open here never reached the disassembly view (tab closed).
  if (pendingStep) finishStep(pendingStep, null, null);
  pendingStep = { sessionId, issued: performance.now(), fromPause: lastPause, sawRunning: false, eventAt: null, reloaded: false };
}

/**
 * A `session-updated` payload arrived. Call before handing it to React, so the
 * pause is on record by the time the views commit it.
 */
export function perfSessionUpdate(session: { id: string; status: unknown; current_event?: unknown }): void {
  if (!active) return;
  const now = performance.now();
  const paused = session.status === "Paused";
  const pause = paused ? JSON.stringify(session.current_event ?? null) : null;
  const step = pendingStep;
  if (step && step.sessionId === session.id && step.eventAt === null) {
    if (!paused) {
      step.sawRunning = true;
    } else if (step.sawRunning || pause !== step.fromPause) {
      step.eventAt = now;
    }
  }
  if (paused) lastPause = pause;
}

/**
 * The disassembly view committed. `pcVisible`: the row of the current PC is
 * in the committed listing.
 */
export function perfAsmCommitted(sessionId: string | null | undefined, pcVisible: () => boolean): void {
  const step = pendingStep;
  if (!active || !step || step.sessionId !== sessionId || step.eventAt === null || !pcVisible()) return;
  pendingStep = null;
  const commitAt = performance.now();
  // The frame callback runs before the paint it belongs to; the task queued
  // from it runs after.
  requestAnimationFrame(() => setTimeout(() => finishStep(step, commitAt, performance.now()), 0));
}

/** Whether a step is waiting for the disassembly view (so callers can skip work otherwise). */
export function perfStepPending(): boolean {
  return active && pendingStep !== null;
}

// ---------------------------------------------------------------------------
// Disassembly loads
// ---------------------------------------------------------------------------

let pendingAsmLoad: { start: number; reason: AsmLoadReason; sessionId: string | null } | null = null;

/** The disassembly view requested a function listing. */
export function perfAsmLoadStart(reason: AsmLoadReason, sessionId: string | null | undefined): void {
  if (!active) return;
  pendingAsmLoad = { start: performance.now(), reason, sessionId: sessionId ?? null };
  if (pendingStep && pendingStep.sessionId === sessionId) pendingStep.reloaded = true;
}

/** ... and its result was applied to the view's state. */
export function perfAsmLoadEnd(rows: number): void {
  const load = pendingAsmLoad;
  if (!active || !load) return;
  pendingAsmLoad = null;
  perfRecord(`ui.asm.load.${load.reason}`, load.start, performance.now() - load.start, { rows }, load.sessionId);
}
