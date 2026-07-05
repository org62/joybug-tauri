import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatTauriError } from '@/lib/sessionHelpers';

export interface PointerPathEntry {
  module_index: number;
  module_base: string;
  base_offset: string;
  base_symbol: string | null;
  offsets: string[];
  resolved: string;
}

const PAGE_SIZE = 200;
const DEFAULT_MAX_OFFSET = '0x1000';
const DEFAULT_MAX_DEPTH = '5';

interface PointerScanStartPayload {
  session_id: string;
  results_path: string;
  match_count: number;
  scan_time_us: number;
}

interface PointerScanResultsPayload {
  session_id: string;
  results_path: string;
  paths: PointerPathEntry[];
  total_count: number;
}

interface PointerScanErrorPayload {
  session_id: string;
  error: string;
}

// The results file lives on disk and is identified by path, so a scan survives a
// target restart (the backend re-bases each path by module_index for ASLR) and
// even a full app restart. We persist the path + summary per session so it can be
// restored after the app is relaunched. The session id is stable across restarts.
interface PersistedScan {
  resultsPath: string;
  matchCount: number;
  totalCount: number;
  targetAddress: string;
}

function scanStorageKey(sessionId: string): string {
  return `joybug.pointerScan.${sessionId}`;
}

function loadPersistedScan(sessionId: string): PersistedScan | null {
  try {
    const raw = localStorage.getItem(scanStorageKey(sessionId));
    return raw ? (JSON.parse(raw) as PersistedScan) : null;
  } catch {
    return null;
  }
}

function savePersistedScan(sessionId: string, scan: PersistedScan | null): void {
  try {
    if (scan) localStorage.setItem(scanStorageKey(sessionId), JSON.stringify(scan));
    else localStorage.removeItem(scanStorageKey(sessionId));
  } catch { /* storage full / unavailable — non-fatal */ }
}

export function usePointerScan(sessionId: string | undefined, available: boolean) {
  const [resultsPath, setResultsPath] = useState<string | null>(null);
  const [targetAddress, setTargetAddress] = useState('');
  const [maxOffset, setMaxOffset] = useState(DEFAULT_MAX_OFFSET);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  // Base addresses (hex strings) of modules to restrict static bases to.
  // Empty = all modules.
  const [selectedModuleBases, setSelectedModuleBases] = useState<string[]>([]);
  // Scan only writable regions (faster; may miss static roots in read-only data).
  const [writableOnly, setWritableOnly] = useState(false);

  const [matchCount, setMatchCount] = useState(0);
  const [scanTimeUs, setScanTimeUs] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [results, setResults] = useState<PointerPathEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  // Quick filter: space/comma-separated chain offsets (e.g. "0x88 0x10"). A path
  // is kept only if its offsets contain every listed value. Applied server-side
  // over the whole results file, so it narrows millions of rows, not just the page.
  const [offsetFilter, setOffsetFilter] = useState('');

  const resultsPathRef = useRef<string | null>(null);
  resultsPathRef.current = resultsPath;

  const offsetFilterRef = useRef<number[]>([]);
  offsetFilterRef.current = parseOffsetFilter(offsetFilter);

  // Set while a "keep only matches" commit is in flight so the start-result
  // handler knows to clear the (now-redundant) filter once the reduced file lands.
  const applyPendingRef = useRef(false);

  // Clear the active scan and its results (kept here so the session-end effect
  // and "New Scan" stay in sync). Module selection and isScanning are handled
  // by the callers, which differ in whether those should be reset.
  const clearScan = useCallback(() => {
    setResultsPath(null);
    setMatchCount(0);
    setScanTimeUs(0);
    setError(null);
    setResults([]);
    setTotalCount(0);
    setCurrentPage(0);
    setOffsetFilter('');
  }, []);

  // Reset when the session ends.
  useEffect(() => {
    if (!sessionId) {
      clearScan();
      setIsScanning(false);
      setSelectedModuleBases([]);
    }
  }, [sessionId, clearScan]);

  const loadPage = useCallback(async (page: number) => {
    if (!sessionId || resultsPathRef.current === null) return;
    try {
      await invoke('request_pointer_scan_get_results', {
        sessionId,
        resultsPath: resultsPathRef.current,
        offset: page * PAGE_SIZE,
        count: PAGE_SIZE,
        offsetFilter: offsetFilterRef.current,
      });
      setCurrentPage(page);
    } catch (e) {
      setError(formatTauriError(e));
    }
  }, [sessionId]);

  // Re-page from the top whenever the filter changes (debounced so typing each
  // hex digit doesn't spam the backend).
  useEffect(() => {
    if (!sessionId || resultsPath === null) return;
    const t = setTimeout(() => { loadPage(0); }, 200);
    return () => clearTimeout(t);
  }, [offsetFilter, sessionId, resultsPath, loadPage]);

  // Restore a persisted scan when the session becomes available and paused. The
  // on-disk results file outlives target/app restarts; reloading page 0 re-bases
  // the paths against the current module layout.
  const restoredForSession = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !available) return;
    if (resultsPath !== null) return;
    if (restoredForSession.current === sessionId) return;
    const persisted = loadPersistedScan(sessionId);
    if (!persisted) return;
    restoredForSession.current = sessionId;
    setResultsPath(persisted.resultsPath);
    resultsPathRef.current = persisted.resultsPath;
    setMatchCount(persisted.matchCount);
    setTotalCount(persisted.totalCount);
    if (persisted.targetAddress) setTargetAddress(persisted.targetAddress);
    loadPage(0);
  }, [sessionId, available, resultsPath, loadPage]);

  // Listen for backend events.
  useEffect(() => {
    if (!sessionId) return;

    const unlistenStart = listen<PointerScanStartPayload>('pointer-scan-start-result', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const path = event.payload.results_path;
      setResultsPath(path);
      resultsPathRef.current = path;
      setMatchCount(event.payload.match_count);
      setScanTimeUs(event.payload.scan_time_us);
      setIsScanning(false);
      setError(null);
      savePersistedScan(sessionId, {
        resultsPath: path,
        matchCount: event.payload.match_count,
        totalCount: event.payload.match_count,
        targetAddress,
      });
      // After committing a filter, the new file already holds only the matches, so
      // drop the filter input (clearing it also re-pages via the debounce effect).
      if (applyPendingRef.current) {
        applyPendingRef.current = false;
        setOffsetFilter('');
      }
      // Auto-fetch the first page (resultsPathRef is set above, so loadPage's guard passes).
      loadPage(0);
    });

    const unlistenResults = listen<PointerScanResultsPayload>('pointer-scan-results', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setResults(event.payload.paths);
      setTotalCount(event.payload.total_count);
      // Keep the persisted total in sync with the authoritative on-disk count.
      const persisted = loadPersistedScan(sessionId);
      if (persisted && persisted.resultsPath === event.payload.results_path) {
        savePersistedScan(sessionId, { ...persisted, totalCount: event.payload.total_count });
      }
    });

    const unlistenError = listen<PointerScanErrorPayload>('pointer-scan-error', (event) => {
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

  const handleScan = useCallback(async () => {
    if (!sessionId || !available) return;
    const target = parseAddr(targetAddress);
    if (target === null) {
      setError('Invalid target address');
      return;
    }
    const offsetVal = parseIntFlexible(maxOffset);
    const depthVal = parseInt(maxDepth, 10);
    if (offsetVal === null || isNaN(depthVal) || depthVal <= 0) {
      setError('Invalid max offset or max depth');
      return;
    }

    // Restrict static bases to the selected modules (empty => all).
    const moduleBases = selectedModuleBases
      .map((b) => parseAddr(b))
      .filter((n): n is number => n !== null);

    setIsScanning(true);
    setError(null);
    setResults([]);
    setMatchCount(0);
    try {
      await invoke('request_pointer_scan_start', {
        sessionId,
        targetAddress: target,
        maxOffset: offsetVal,
        maxDepth: depthVal,
        maxResults: null,
        modules: moduleBases.length > 0 ? moduleBases : null,
        writableOnly,
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, available, targetAddress, maxOffset, maxDepth, selectedModuleBases, writableOnly]);

  const handleNewScan = useCallback(async () => {
    if (resultsPath !== null && sessionId) {
      try {
        await invoke('request_pointer_scan_reset', { sessionId, resultsPath });
      } catch (_) { /* ignore */ }
    }
    if (sessionId) savePersistedScan(sessionId, null);
    restoredForSession.current = sessionId ?? null;
    clearScan();
  }, [sessionId, resultsPath, clearScan]);

  // Rescan: narrow the current result list to paths that still resolve to the
  // (possibly changed) target address. Reuses the start-result event flow.
  const handleRescan = useCallback(async () => {
    if (!sessionId || !available || resultsPath === null) return;
    const target = parseAddr(targetAddress);
    if (target === null) {
      setError('Invalid target address');
      return;
    }
    setIsScanning(true);
    setError(null);
    try {
      await invoke('request_pointer_scan_rescan', { sessionId, resultsPath, targetAddress: target });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, available, resultsPath, targetAddress]);

  // Commit the active filter: reduce the results file to only the matches and make
  // it the active set (the backend writes a new file and deletes the old one).
  const handleApplyFilter = useCallback(async () => {
    if (!sessionId || resultsPath === null) return;
    const filter = offsetFilterRef.current;
    if (filter.length === 0) return;
    setIsScanning(true);
    setError(null);
    applyPendingRef.current = true;
    try {
      await invoke('request_pointer_scan_apply_filter', { sessionId, resultsPath, offsetFilter: filter });
    } catch (e) {
      applyPendingRef.current = false;
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, resultsPath]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return {
    // State
    resultsPath, targetAddress, maxOffset, maxDepth, selectedModuleBases, writableOnly,
    matchCount, scanTimeUs, isScanning, error, offsetFilter,
    results, totalCount, currentPage, totalPages, pageSize: PAGE_SIZE,
    // Setters
    setTargetAddress, setMaxOffset, setMaxDepth, setSelectedModuleBases, setWritableOnly, setOffsetFilter,
    // Actions
    handleScan, handleNewScan, handleRescan, handleApplyFilter, loadPage,
  };
}

// Parse a space/comma-separated list of chain offsets ("0x88 0x10", "88,10") into
// numbers. Values are hex by default (with or without "0x"); invalid tokens are
// dropped so partial typing doesn't blow up the filter.
function parseOffsetFilter(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const hex = t.toLowerCase().startsWith('0x') ? t.slice(2) : t;
      const n = parseInt(hex, 16);
      return isNaN(n) ? null : n;
    })
    .filter((n): n is number => n !== null);
}

// Parse an address string (always hex, with or without an "0x" prefix) to a JS
// number — addresses stay < 2^53 in practice.
function parseAddr(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = parseInt(t, 16);
  return isNaN(n) ? null : n;
}

function parseIntFlexible(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : parseInt(t, 10);
  return isNaN(n) ? null : n;
}
