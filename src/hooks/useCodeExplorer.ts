import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatTauriError } from '@/lib/sessionHelpers';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/// One armed function, returned by `start_code_coverage`. Hit counts arrive
/// separately via polling and are joined by `address` in the view.
export interface CoverageFn {
  address: string; // hex "0x..."
  symbol: string;
  rva: number;
}

interface CoverageHit {
  address: string; // hex "0x..."
  hit_count: number;
  first_hit_seq: number; // 1-based first-execution order across the run
  thread_ids: number[]; // distinct hitting threads, first-hit order
}

/// Per-address live coverage data joined into the table by the view.
export interface CoverageCount {
  count: number;
  seq: number;
  tids: number[];
}

export type CoverageSortKey = 'address' | 'hits' | 'symbol' | 'order';

/// Fresh counts identical to the previous snapshot keep the old object so the
/// poll tick doesn't re-render (and re-sort) an unchanged table. seq is
/// immutable once assigned and tids only grow, so comparing count + seq + tids
/// length is exact (a changed tid set always changes its length).
function sameCounts(a: Record<string, CoverageCount>, b: Record<string, CoverageCount>): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((k) => {
    const x = a[k], y = b[k];
    return y !== undefined && x.count === y.count && x.seq === y.seq && x.tids.length === y.tids.length;
  });
}

/**
 * Drives the server-side code-coverage engine: enumerate a module's functions,
 * arm silent coverage breakpoints, and poll live hit counts while the target
 * runs. `available` gates Start on the session being usable (paused/running/open);
 * `isLive` gates polling on the target actually executing.
 */
export function useCodeExplorer(sessionId: string | undefined, available: boolean, isLive: boolean) {
  // The armed function table (stable between polls) and the live address -> count map.
  const [functions, setFunctions] = useState<CoverageFn[]>([]);
  const [counts, setCounts] = useState<Record<string, CoverageCount>>({});
  const [active, setActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Short name of the module the current table was armed on (the selection can
  // change after a scan; the table keeps describing what was actually armed).
  const [armedModule, setArmedModule] = useState('');

  // Controls
  const [selectedModule, setSelectedModule] = useState<string | null>(null); // module full name
  const [hitLimit, setHitLimit] = useState('1');

  // View state (client-side filter/sort over the in-memory table)
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<CoverageSortKey>('order');
  const [sortAsc, setSortAsc] = useState(true); // order: first executed first by default
  const [hitOnly, setHitOnly] = useState(true); // hide functions not reached yet

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const hits = await invoke<CoverageHit[]>('get_code_coverage', { sessionId });
      setCounts((prev) => {
        const map: Record<string, CoverageCount> = {};
        for (const h of hits) map[h.address] = { count: h.hit_count, seq: h.first_hit_seq, tids: h.thread_ids };
        return sameCounts(prev, map) ? prev : map;
      });
    } catch {
      // Transient (e.g. the process resumed between poll calls); keep the last
      // snapshot and try again on the next tick.
    }
  }, [sessionId]);

  // Poll live counts on the shared cadence while coverage is armed and the
  // target runs; refresh once more on the Running -> Paused transition so a
  // pause snapshots the final counts.
  useLiveRefresh(sessionId, active && isLive, () => {
    if (active) poll();
  });

  const start = useCallback(async () => {
    if (!sessionId || !available || !selectedModule) return;
    const limit = parseInt(hitLimit, 10);
    if (isNaN(limit) || limit < 0) {
      setError('Hit limit must be 0 or greater');
      return;
    }
    setIsStarting(true);
    setError(null);
    setCounts({});
    try {
      const fns = await invoke<CoverageFn[]>('start_code_coverage', {
        sessionId,
        moduleName: selectedModule,
        hitLimit: limit,
      });
      setFunctions(fns);
      setArmedModule(selectedModule);
      setActive(true);
      poll();
    } catch (e) {
      setError(formatTauriError(e));
    } finally {
      setIsStarting(false);
    }
  }, [sessionId, available, selectedModule, hitLimit, poll]);

  const stop = useCallback(async () => {
    setActive(false);
    if (!sessionId) return;
    try {
      await invoke('stop_code_coverage', { sessionId });
    } catch {
      /* best-effort: the session/process may already be gone */
    }
  }, [sessionId]);

  // Reset everything when the session ends.
  useEffect(() => {
    if (!sessionId) {
      setFunctions([]);
      setCounts({});
      setActive(false);
      setError(null);
      setArmedModule('');
      setSelectedModule(null);
      setHitLimit('1');
      setFilter('');
      setSortKey('order');
      setSortAsc(true);
      setHitOnly(true);
    }
  }, [sessionId]);

  const toggleSort = useCallback((key: CoverageSortKey) => {
    // Sensible default direction per column: names A -> Z, execution order
    // first-hit first, counts high -> low.
    setSortAsc(sortKey === key ? !sortAsc : key === 'symbol' || key === 'order');
    setSortKey(key);
  }, [sortKey, sortAsc]);

  return {
    // State
    functions, counts, active, isStarting, error, armedModule,
    selectedModule, hitLimit, filter, sortKey, sortAsc, hitOnly,
    // Setters
    setSelectedModule, setHitLimit, setFilter, setHitOnly,
    // Actions
    start, stop, toggleSort,
  };
}
