import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatTauriError } from '@/lib/sessionHelpers';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/// One armed function, returned by `start_code_coverage`. Hit counts arrive
/// separately via polling and are joined by `address` in the view.
export interface CoverageFn {
  address: string; // hex "0x..."
  symbol: string;
  rva: number;
  /// Where the address came from: '.pdata' exception directory, a symbol the
  /// PDB marks as a function, a symbol that passed the code-sanity check, or an
  /// entry the user listed explicitly.
  source: 'pdata' | 'symbol' | 'validated' | 'custom';
}

/// Where a scan draws its addresses from. Independent switches rather than
/// exclusive modes, so they combine: the exception directory plus your own list,
/// with symbols — the only tier that involves guessing — switched off entirely.
export interface TargetSources {
  /// `.pdata` RUNTIME_FUNCTION starts.
  pdata: boolean;
  /// Module symbols: those the PDB marks as functions, plus those that only pass
  /// the code-sanity heuristic.
  symbols: boolean;
  /// The user's explicit list of addresses and symbol names.
  list: boolean;
}

export const TARGET_SOURCES: { key: keyof TargetSources; label: string; hint: string }[] = [
  { key: 'pdata', label: 'Exception directory', hint: '.pdata RUNTIME_FUNCTION starts — the authoritative function table. No heuristics, and available even when the module has no symbols at all.' },
  { key: 'symbols', label: 'Symbols', hint: 'Module symbols: those the PDB marks as functions, plus those that pass a code-sanity check. Widest coverage, but that second group is a heuristic and can place a breakpoint on data.' },
  { key: 'list', label: 'List', hint: 'Your own addresses or symbol names, armed exactly as given — the code-sanity check is not applied to them.' },
];

/// The lines of a custom list that actually become targets. Mirrors the
/// backend's parsing (blank lines and `#`/`;` comments are skipped) so the count
/// the UI shows is the count that gets armed.
export function customEntryLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'));
}

/// Server-side names of the enabled enumeration tiers. Empty means nothing is
/// enumerated, leaving the custom list (if enabled) to supply every target.
function enabledSources(sources: TargetSources): string[] {
  const names: string[] = [];
  if (sources.pdata) names.push('pdata');
  if (sources.symbols) names.push('symbol', 'validated');
  return names;
}

interface CoverageHit {
  address: string; // hex "0x..."
  hit_count: number;
  first_hit_seq: number; // 1-based first-execution order across the run
  first_hit_us: number; // microseconds from run start to the first hit
  thread_ids: number[]; // distinct hitting threads, first-hit order
}

/// Per-address live coverage data joined into the table by the view.
export interface CoverageCount {
  count: number;
  seq: number;
  /// Microseconds from the start of the run to this address' first hit. Only
  /// the first hit is timed, so this is a point on the execution timeline —
  /// the gap between two functions is the difference of their values.
  us: number;
  tids: number[];
}

export type CoverageSortKey = 'address' | 'hits' | 'symbol' | 'order';

/// Fresh counts identical to the previous snapshot keep the old object so the
/// poll tick doesn't re-render (and re-sort) an unchanged table. seq (and the
/// timestamp stamped with it) is immutable once assigned and tids only grow, so
/// comparing count + seq + tids length is exact (a changed tid set always
/// changes its length).
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
 * `isLive` gates polling on the target actually executing; `processId` identifies
 * the process the armed breakpoints live in (see the scan-reset effect below).
 */
export function useCodeExplorer(
  sessionId: string | undefined,
  available: boolean,
  isLive: boolean,
  processId: number | undefined,
) {
  // The armed function table (stable between polls) and the live address -> count map.
  const [functions, setFunctions] = useState<CoverageFn[]>([]);
  const [counts, setCounts] = useState<Record<string, CoverageCount>>({});
  const [active, setActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Short name of the module the current table was armed on (the selection can
  // change after a scan; the table keeps describing what was actually armed).
  const [armedModule, setArmedModule] = useState('');
  // Process the breakpoints were armed in, captured at scan start.
  const armedPidRef = useRef<number | undefined>(undefined);

  // Controls
  const [selectedModule, setSelectedModule] = useState<string | null>(null); // module full name
  const [hitLimit, setHitLimit] = useState('1');
  const [targetSources, setTargetSources] = useState<TargetSources>({
    pdata: true, symbols: true, list: false,
  });
  // Raw text of the custom list, kept as typed so the dialog round-trips
  // exactly what was pasted; split into entries only at scan time.
  const [customList, setCustomList] = useState('');
  // Custom entries that named nothing, surfaced so a typo isn't silent.
  const [unresolved, setUnresolved] = useState<string[]>([]);

  // View state (client-side filter/sort over the in-memory table)
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<CoverageSortKey>('order');
  const [sortAsc, setSortAsc] = useState(true); // order: first executed first by default
  const [hitOnly, setHitOnly] = useState(true); // hide functions not reached yet

  // Whether the current source selection would arm anything: any enumeration
  // tier on, or the list on with at least one entry. The single owner of this
  // condition — the view binds Start's disabled state to it, `start` reuses it.
  const hasTargets = useMemo(
    () => enabledSources(targetSources).length > 0
      || (targetSources.list && customEntryLines(customList).length > 0),
    [targetSources, customList],
  );

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const hits = await invoke<CoverageHit[]>('get_code_coverage', { sessionId });
      setCounts((prev) => {
        const map: Record<string, CoverageCount> = {};
        for (const h of hits) {
          map[h.address] = { count: h.hit_count, seq: h.first_hit_seq, us: h.first_hit_us, tids: h.thread_ids };
        }
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
    const sources = enabledSources(targetSources);
    const entries = targetSources.list ? customEntryLines(customList) : [];
    if (sources.length === 0 && entries.length === 0) {
      setError(targetSources.list
        ? 'Add at least one address or symbol name to the list'
        : 'Enable at least one target source');
      return;
    }
    setIsStarting(true);
    setError(null);
    setCounts({});
    setUnresolved([]);
    try {
      const result = await invoke<{ functions: CoverageFn[]; unresolved: string[] }>(
        'start_code_coverage',
        {
          sessionId,
          moduleName: selectedModule,
          hitLimit: limit,
          sources,
          customEntries: entries,
        },
      );
      setFunctions(result.functions);
      setUnresolved(result.unresolved);
      setArmedModule(selectedModule);
      armedPidRef.current = processId;
      setActive(true);
      poll();
    } catch (e) {
      setError(formatTauriError(e));
    } finally {
      setIsStarting(false);
    }
  }, [sessionId, available, selectedModule, hitLimit, targetSources, customList, processId, poll]);

  const stop = useCallback(async () => {
    setActive(false);
    if (!sessionId) return;
    try {
      await invoke('stop_code_coverage', { sessionId });
    } catch {
      /* best-effort: the session/process may already be gone */
    }
  }, [sessionId]);

  /**
   * Drop the armed run when the process it belongs to goes away.
   *
   * A restart keeps the session id, so the session-end reset below never fires,
   * but the coverage map lives in the *process* — the new one has no breakpoints
   * armed. Left alone the panel keeps claiming "live" over a table that
   * instruments nothing and can never record a hit again. Two signals, because
   * either alone can be missed: the status leaving the process-available set
   * (which a debounce can swallow on a fast restart), and the debuggee's pid
   * changing out from under the table.
   *
   * Only the run is cleared — the module, sources and list are the user's setup
   * and survive, so re-arming after a restart is one click.
   */
  useEffect(() => {
    if (!active) return;
    const processGone = !available;
    const processReplaced = processId !== undefined
      && armedPidRef.current !== undefined
      && processId !== armedPidRef.current;
    if (processGone || processReplaced) {
      setFunctions([]);
      setCounts({});
      setActive(false);
      setArmedModule('');
      setUnresolved([]);
      armedPidRef.current = undefined;
    }
  }, [active, available, processId]);

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
      setTargetSources({ pdata: true, symbols: true, list: false });
      setCustomList('');
      setUnresolved([]);
      armedPidRef.current = undefined;
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
    functions, counts, active, isStarting, error, armedModule, unresolved, hasTargets,
    selectedModule, hitLimit, targetSources, customList, filter, sortKey, sortAsc, hitOnly,
    // Setters
    setSelectedModule, setHitLimit, setTargetSources, setCustomList, setFilter, setHitOnly,
    // Actions
    start, stop, toggleSort,
  };
}
