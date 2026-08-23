import { useEffect, useRef } from 'react';

/**
 * Run `reset` when a *different* process appears for the same session — i.e.
 * the target was restarted. Scan caches (strings, memory scanner) deliberately
 * survive a stop so the user can still read them, but their addresses belong to
 * the dead process and must not carry into the next run (ASLR). The first pid
 * seen, and a pid going away (stop), do not reset. (Pointer scan is deliberately
 * not a caller: its results live on disk and re-base themselves across restarts.)
 *
 * When `onProcessGone` is given it runs whenever the process goes away, for the
 * part of a scan's state that must not survive it (the "scanning" flag — nothing
 * will ever complete it, so the toolbar would stay stuck).
 *
 * Both callbacks are read through refs, so callers can pass inline closures.
 */
export function useResetOnNewProcess(
  processId: number | undefined | null,
  reset: () => void,
  available?: boolean,
  onProcessGone?: () => void,
) {
  const lastPidRef = useRef<number | null>(null);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const goneRef = useRef(onProcessGone);
  goneRef.current = onProcessGone;

  useEffect(() => {
    if (processId == null) return;
    const last = lastPidRef.current;
    lastPidRef.current = processId;
    if (last !== null && last !== processId) resetRef.current();
  }, [processId]);

  useEffect(() => {
    if (available === false) goneRef.current?.();
  }, [available]);
}
