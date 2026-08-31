import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** One ETW event from the in-sandbox tracer (mirrors Rust `EtwEventRow`). */
export interface EtwEvent {
  seq: number;
  time: string;
  kind: string; // process | file | registry | network | audit | tracer
  op: string;
  pid: number | null;
  image: string | null;
  ppid: number | null;
  path: string | null;
  size: number | null;
  dest: string | null;
  exit: number | null;
  /** Captured callstack as hex return addresses (when callstacks are on). */
  stack: string[] | null;
  /** Audit events: the process acted upon (`pid` is the actor). */
  target_pid: number | null;
  /** Audit events: decoded DesiredAccess, e.g. "VM_READ|VM_WRITE". */
  access: string | null;
  /** Audit events: NTSTATUS of the audited call; 0 is success. */
  status: number | null;
}

const MAX_EVENTS = 100_000;

/**
 * Poll ETW events accumulated by the sandbox guest-tracer. Backend buffers them
 * in the shared file and assigns each a monotonic `seq`; we poll for `seq >
 * lastSeq` and append. Polls on a fixed interval (not gated on pause — the guest
 * tracer runs independently of the debugger's pause state). Resets when the
 * session changes or ETW is disabled.
 *
 * `live` gates only the interval, never the collected events: when the session
 * stops (`live` → false) the hook does one final drain poll and then goes
 * quiet, keeping the last run's events visible instead of ticking a useless
 * 1 Hz IPC poll against a dead session forever.
 */
export function useEtwEvents(
  sessionId: string | undefined,
  enabled: boolean,
  processId?: number,
  live: boolean = true,
) {
  const [events, setEvents] = useState<EtwEvent[]>([]);
  const lastSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const clear = useCallback(() => {
    // Empty the view but KEEP the high-water seq: the JSONL on disk is the
    // source of truth, so resetting to 0 would just re-read every cleared row on
    // the next poll. Leaving lastSeqRef put means only genuinely new events show.
    setEvents([]);
  }, []);

  // Reset on session change / disable (not on a `live` flip — a stop keeps the
  // last run's events visible).
  useEffect(() => {
    setEvents([]);
    lastSeqRef.current = 0;
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!sessionId || !enabled) return;

    let cancelled = false;
    const poll = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const rows = await invoke<EtwEvent[]>("poll_etw_events", {
          sessionId,
          fromSeq: lastSeqRef.current,
        });
        if (!cancelled && rows.length) {
          lastSeqRef.current = rows[rows.length - 1].seq;
          setEvents((prev) => {
            const next = prev.concat(rows);
            return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
          });
        }
      } catch {
        // Transient (session tearing down / file not yet created) — ignore.
      } finally {
        inFlightRef.current = false;
      }
    };

    void poll();
    const id = setInterval(poll, 1000);
    // On a stopped session, poll through a short grace window — the tracer
    // flushes on a delay and sandbox teardown takes seconds, so the exit tail
    // arrives after the status flip — then go quiet.
    const grace = live ? undefined : window.setTimeout(() => clearInterval(id), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (grace !== undefined) clearTimeout(grace);
    };
  }, [sessionId, enabled, live]);

  // Clear the view when a NEW process starts (restart) — those events belong to
  // the dead process. Only on a start: a stop (pid → undefined) leaves the last
  // run's events visible for inspection while the session is Stopped. The seq
  // high-water mark is kept, so cleared rows aren't re-read from the JSONL.
  const prevPidRef = useRef<number | undefined>(processId);
  useEffect(() => {
    if (processId === undefined) return; // stop: keep events + last pid
    if (prevPidRef.current !== undefined && processId !== prevPidRef.current) {
      setEvents([]); // a different pid appeared → the target restarted
    }
    prevPidRef.current = processId;
  }, [processId]);

  return { events, clear };
}
