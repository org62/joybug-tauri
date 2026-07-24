import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import type { Breakpoint } from '@/hooks/useBreakpoints';

/** One distinct instruction that accessed a watched address (resolved for display). */
export interface WatchpointAccessRow {
  accessor: string;        // hex "0x..." — the accessing instruction
  raw_rip: string;         // hex "0x..." — the raw trap RIP (post-access on x86)
  symbol: string | null;   // "mod!func+0x.."
  disasm: string | null;   // "mov [rbx], eax"
  hit_count: number;
  first_seq: number;
  thread_ids: number[];
}

/** A hardware access trace = a watchpoint breakpoint plus its collected accessors. */
export interface WatchpointTrace {
  breakpointId: string;
  address: string;         // watched address, hex "0x..."
  hwType: string;          // "Write" | "ReadWrite"
  hwSize: number;          // 1 | 2 | 4 | 8
  tracing: boolean;        // armed & collecting
  symbol: string | null;   // watched-address symbol, if any
  rows: WatchpointAccessRow[];
}

/**
 * Merge a poll result into state. Symbol/disasm are immutable per accessor: the
 * backend leaves them null for raw RIPs we reported as known, so fill them from
 * the previous rows. Returns the previous object identity when nothing changed,
 * so a steady-state poll causes no re-render.
 */
function mergeTraceRows(
  prev: Record<string, WatchpointAccessRow[]>,
  address: string,
  fetched: WatchpointAccessRow[],
): Record<string, WatchpointAccessRow[]> {
  const prevRows = prev[address] ?? [];
  const prevByRip = new Map(prevRows.map(r => [r.raw_rip, r]));
  const merged = fetched.map(r => {
    const p = prevByRip.get(r.raw_rip);
    return p ? { ...r, symbol: r.symbol ?? p.symbol, disasm: r.disasm ?? p.disasm } : r;
  });
  const unchanged =
    merged.length === prevRows.length &&
    merged.every((r, i) => {
      const p = prevRows[i];
      return (
        p.raw_rip === r.raw_rip &&
        p.hit_count === r.hit_count &&
        p.thread_ids.length === r.thread_ids.length &&
        p.symbol === r.symbol &&
        p.disasm === r.disasm
      );
    });
  return unchanged ? prev : { ...prev, [address]: merged };
}

/**
 * Manages hardware access traces ("find what reads/writes an address"). Watchpoints
 * live in the breakpoints list (bp_kind === "watchpoint"); this hook polls each
 * active one's accessors while the target runs and RETAINS the collected rows after
 * the trace is stopped (until the session ends or the row is explicitly cleared).
 */
export function useWatchpointTrace(
  sessionId: string | undefined,
  breakpoints: Breakpoint[] | undefined,
  isLive: boolean,
) {
  const [rowsByAddr, setRowsByAddr] = useState<Record<string, WatchpointAccessRow[]>>({});

  const watchpoints = useMemo(
    () => (breakpoints ?? []).filter(b => b.bp_kind === 'watchpoint'),
    [breakpoints],
  );

  // Session cleanup: drop all collected rows when the session ends.
  useEffect(() => {
    if (!sessionId) setRowsByAddr({});
  }, [sessionId]);

  const watchpointsRef = useRef(watchpoints);
  watchpointsRef.current = watchpoints;
  const rowsRef = useRef(rowsByAddr);
  rowsRef.current = rowsByAddr;

  const poll = useCallback(async () => {
    if (!sessionId) return;
    const active = watchpointsRef.current.filter(w => w.tracing && w.address !== '0x0');
    for (const w of active) {
      // Report the raw RIPs we already hold so the backend only resolves
      // symbol/disasm for accessors it hasn't seen from us before.
      const knownRips = (rowsRef.current[w.address] ?? []).map(r => r.raw_rip);
      try {
        const rows = await invoke<WatchpointAccessRow[]>('poll_watchpoint_accesses', {
          sessionId,
          address: w.address,
          knownRips,
        });
        setRowsByAddr(prev => mergeTraceRows(prev, w.address, rows));
      } catch {
        // Transient: the target may have exited or be mid-transition. Keep prior rows.
      }
    }
  }, [sessionId]);

  // Poll on the shared live-refresh cadence while a trace is armed and the target
  // runs; a paused target can't produce new accesses, and the pause transition
  // fires one final poll to snapshot the latest counts.
  const hasActiveTraces = watchpoints.some(w => w.tracing && w.address !== '0x0');
  useLiveRefresh(sessionId, hasActiveTraces && isLive, poll, 400);

  const clearRows = useCallback((address: string) => {
    setRowsByAddr(prev => {
      const next = { ...prev };
      delete next[address];
      return next;
    });
  }, []);

  const startTrace = useCallback(async (address: string, mode: 'Write' | 'ReadWrite', size: number) => {
    if (!sessionId) return;
    // Reset any prior results for this address so a fresh trace starts clean.
    clearRows(address);
    try {
      await invoke('start_watchpoint_trace', { sessionId, address, hwType: mode, hwSize: size });
    } catch (e) {
      console.error('Failed to start watchpoint trace:', e);
    }
  }, [sessionId, clearRows]);

  const stopTrace = useCallback(async (breakpointId: string) => {
    if (!sessionId) return;
    try {
      await invoke('stop_watchpoint_trace', { sessionId, breakpointId });
    } catch (e) {
      console.error('Failed to stop watchpoint trace:', e);
    }
  }, [sessionId]);

  const traces: WatchpointTrace[] = useMemo(() => watchpoints.map(w => ({
    breakpointId: w.id,
    address: w.address,
    hwType: w.hw_type ?? 'ReadWrite',
    hwSize: w.hw_size ?? 4,
    tracing: w.tracing,
    symbol: w.symbol,
    rows: rowsByAddr[w.address] ?? [],
  })), [watchpoints, rowsByAddr]);

  return useMemo(() => ({ traces, startTrace, stopTrace, clearRows }), [traces, startTrace, stopTrace, clearRows]);
}

export type WatchpointTraceState = ReturnType<typeof useWatchpointTrace>;
