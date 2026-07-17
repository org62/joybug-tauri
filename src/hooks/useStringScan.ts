import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatTauriError } from '@/lib/sessionHelpers';

export interface StringEntry {
  address: string;
  encoding: string; // "ascii" | "utf16"
  length: number;
  text: string;
  truncated: boolean;
}

export type StringSortKey = 'address' | 'value' | 'length';

/// Where a scan looks. 'module' spans one module; 'range' a custom span; the
/// rest cover the whole address space narrowed by a region filter.
export type StringScanScope =
  | 'module' | 'modules' | 'readable' | 'writable' | 'executable' | 'private' | 'mapped' | 'range';

export type StringEncodingFilter = 'both' | 'ascii' | 'utf16';

/// Encoding choices for string-scan selectors (session Strings tab and PE viewer).
export const ENCODING_OPTIONS: { value: StringEncodingFilter; label: string }[] = [
  { value: 'both', label: 'ASCII+UTF-16' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'utf16', label: 'UTF-16' },
];

/// Resolved parameters handed to handleScan. Null span bounds mean "the whole
/// address space" (the backend substitutes 0..u64::MAX).
export interface StringScanParams {
  startAddress: number | null;
  size: number | null;
  regionFilter: string;
}

export const STRING_SCAN_PAGE_SIZE = 200;
const PAGE_SIZE = STRING_SCAN_PAGE_SIZE;
const DEFAULT_MIN_LENGTH = '5';

/// The scan state/actions the shared StringsPanel consumes. Implemented by
/// `useStringScan` (session: server-side paging over a results file) and by
/// `usePeStringScan` (PE viewer: client-side paging over in-memory hits).
export interface StringScanController {
  hasScanned: boolean;
  minLength: string;
  setMinLength: (v: string) => void;
  encodings: StringEncodingFilter;
  setEncodings: (v: StringEncodingFilter) => void;
  contains: string;
  setContains: (v: string) => void;
  filter: string;
  setFilter: (v: string) => void;
  sortKey: StringSortKey;
  sortAsc: boolean;
  toggleSort: (key: StringSortKey) => void;
  results: StringEntry[];
  matchCount: number;
  totalCount: number;
  capped: boolean;
  scanTimeUs: number;
  isScanning: boolean;
  error: string | null;
  currentPage: number;
  totalPages: number;
  loadPage: (page: number) => void;
}

interface StringScanStartPayload {
  session_id: string;
  results_path: string;
  match_count: number;
  scan_time_us: number;
  capped: boolean;
}

interface StringScanResultsPayload {
  session_id: string;
  results_path: string;
  strings: StringEntry[];
  total_count: number;
}

interface StringScanErrorPayload {
  session_id: string;
  error: string;
}

export function useStringScan(sessionId: string | undefined, available: boolean) {
  const [resultsPath, setResultsPath] = useState<string | null>(null);
  const [scope, setScope] = useState<StringScanScope>('module');
  // Base address (hex string) of the module to scan; matches Module.base_address.
  const [selectedModuleBase, setSelectedModuleBase] = useState<string | null>(null);
  // Custom-range bounds (hex strings), used when scope === 'range'.
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [minLength, setMinLength] = useState(DEFAULT_MIN_LENGTH);
  const [encodings, setEncodings] = useState<StringEncodingFilter>('both');
  // Scan-time substring: only strings containing it are stored at all
  // (distinct from `filter`, which pages over already-stored results).
  const [contains, setContains] = useState('');

  const [matchCount, setMatchCount] = useState(0);
  const [scanTimeUs, setScanTimeUs] = useState(0);
  const [capped, setCapped] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [results, setResults] = useState<StringEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  // Case-insensitive substring filter, applied server-side over the whole file.
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<StringSortKey>('address');
  const [sortAsc, setSortAsc] = useState(true);

  // Refs mirror state so the stable event listeners and loadPage read current
  // values without re-subscribing on every keystroke.
  const resultsPathRef = useRef<string | null>(null);
  resultsPathRef.current = resultsPath;
  const filterRef = useRef('');
  filterRef.current = filter;
  const sortKeyRef = useRef<StringSortKey>('address');
  sortKeyRef.current = sortKey;
  const sortAscRef = useRef(true);
  sortAscRef.current = sortAsc;

  // Reset everything a scan produced; the filter is kept (a new scan of the
  // same module usually wants the same filter) — clearScan drops it too.
  const resetResults = useCallback(() => {
    setResultsPath(null);
    setMatchCount(0);
    setScanTimeUs(0);
    setCapped(false);
    setError(null);
    setResults([]);
    setTotalCount(0);
    setCurrentPage(0);
  }, []);

  const clearScan = useCallback(() => {
    resetResults();
    setFilter('');
  }, [resetResults]);

  // Reset when the session ends, and best-effort delete the results file.
  useEffect(() => {
    if (!sessionId) {
      const path = resultsPathRef.current;
      if (path) invoke('request_string_scan_reset', { sessionId, resultsPath: path }).catch(() => {});
      clearScan();
      setIsScanning(false);
      setScope('module');
      setSelectedModuleBase(null);
      setRangeStart('');
      setRangeEnd('');
      setEncodings('both');
      setContains('');
    }
  }, [sessionId, clearScan]);

  // Callers that change a value loadPage reads (sort click, scan completion)
  // pass it as an override, since the state hasn't committed to the refs yet.
  const loadPage = useCallback(async (
    page: number,
    overrides?: { resultsPath?: string; sortKey?: StringSortKey; sortAsc?: boolean },
  ) => {
    const path = overrides?.resultsPath ?? resultsPathRef.current;
    if (!sessionId || path === null) return;
    try {
      await invoke('request_string_scan_get_results', {
        sessionId,
        resultsPath: path,
        offset: page * PAGE_SIZE,
        count: PAGE_SIZE,
        filter: filterRef.current,
        sortKey: overrides?.sortKey ?? sortKeyRef.current,
        ascending: overrides?.sortAsc ?? sortAscRef.current,
      });
      setCurrentPage(page);
    } catch (e) {
      setError(formatTauriError(e));
    }
  }, [sessionId]);

  // Re-page from the top when the filter changes (debounced so typing doesn't
  // spam the backend). Sort changes re-page via toggleSort — a click, not a
  // keystroke.
  useEffect(() => {
    if (!sessionId || resultsPath === null) return;
    const t = setTimeout(() => loadPage(0), 200);
    return () => clearTimeout(t);
  }, [filter, sessionId, resultsPath, loadPage]);

  // Listen for backend events.
  useEffect(() => {
    if (!sessionId) return;

    const unlistenStart = listen<StringScanStartPayload>('string-scan-start-result', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const path = event.payload.results_path;
      setResultsPath(path);
      setMatchCount(event.payload.match_count);
      setScanTimeUs(event.payload.scan_time_us);
      setCapped(event.payload.capped);
      setIsScanning(false);
      setError(null);
      loadPage(0, { resultsPath: path });
    });

    const unlistenResults = listen<StringScanResultsPayload>('string-scan-results', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setResults(event.payload.strings);
      setTotalCount(event.payload.total_count);
    });

    const unlistenError = listen<StringScanErrorPayload>('string-scan-error', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setError(event.payload.error);
      setIsScanning(false);
    });

    return () => {
      unlistenStart.then(f => f());
      unlistenResults.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionId, loadPage]);

  const handleScan = useCallback(async (params: StringScanParams) => {
    if (!sessionId || !available) return;
    const min = parseInt(minLength, 10);
    if (isNaN(min) || min < 2) {
      setError('Minimum length must be at least 2');
      return;
    }
    // Delete any prior results file before starting a fresh scan.
    if (resultsPathRef.current !== null) {
      try {
        await invoke('request_string_scan_reset', { sessionId, resultsPath: resultsPathRef.current });
      } catch { /* ignore */ }
    }
    resetResults();
    setIsScanning(true);
    try {
      await invoke('request_string_scan_start', {
        sessionId,
        startAddress: params.startAddress,
        size: params.size,
        minLength: min,
        regionFilter: params.regionFilter,
        encodings,
        contains: contains.trim(),
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, available, minLength, encodings, contains, resetResults]);

  const toggleSort = useCallback((key: StringSortKey) => {
    const asc = sortKeyRef.current === key ? !sortAscRef.current : true;
    setSortKey(key);
    setSortAsc(asc);
    loadPage(0, { sortKey: key, sortAsc: asc });
  }, [loadPage]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return {
    // State
    resultsPath, hasScanned: resultsPath !== null,
    scope, selectedModuleBase, rangeStart, rangeEnd, minLength, encodings, contains,
    matchCount, scanTimeUs, capped, isScanning, error,
    filter, sortKey, sortAsc,
    results, totalCount, currentPage, totalPages,
    // Setters
    setScope, setSelectedModuleBase, setRangeStart, setRangeEnd, setMinLength,
    setEncodings, setContains, setFilter,
    // Actions
    handleScan, toggleSort, loadPage,
  };
}
