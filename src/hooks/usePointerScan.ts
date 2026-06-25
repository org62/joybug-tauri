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
  scan_id: number;
  match_count: number;
  scan_time_us: number;
}

interface PointerScanResultsPayload {
  session_id: string;
  scan_id: number;
  paths: PointerPathEntry[];
  total_count: number;
}

interface PointerScanErrorPayload {
  session_id: string;
  error: string;
}

export function usePointerScan(sessionId: string | undefined, isPaused: boolean) {
  const [scanId, setScanId] = useState<number | null>(null);
  const [targetAddress, setTargetAddress] = useState('');
  const [maxOffset, setMaxOffset] = useState(DEFAULT_MAX_OFFSET);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  // Base addresses (hex strings) of modules to restrict static bases to.
  // Empty = all modules.
  const [selectedModuleBases, setSelectedModuleBases] = useState<string[]>([]);

  const [matchCount, setMatchCount] = useState(0);
  const [scanTimeUs, setScanTimeUs] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [results, setResults] = useState<PointerPathEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const scanIdRef = useRef<number | null>(null);
  scanIdRef.current = scanId;

  // Clear the active scan and its results (kept here so the session-end effect
  // and "New Scan" stay in sync). Module selection and isScanning are handled
  // by the callers, which differ in whether those should be reset.
  const clearScan = useCallback(() => {
    setScanId(null);
    setMatchCount(0);
    setScanTimeUs(0);
    setError(null);
    setResults([]);
    setTotalCount(0);
    setCurrentPage(0);
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
    if (!sessionId || scanIdRef.current === null) return;
    try {
      await invoke('request_pointer_scan_get_results', {
        sessionId,
        scanId: scanIdRef.current,
        offset: page * PAGE_SIZE,
        count: PAGE_SIZE,
      });
      setCurrentPage(page);
    } catch (e) {
      setError(formatTauriError(e));
    }
  }, [sessionId]);

  // Listen for backend events.
  useEffect(() => {
    if (!sessionId) return;

    const unlistenStart = listen<PointerScanStartPayload>('pointer-scan-start-result', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const sid = event.payload.scan_id;
      setScanId(sid);
      scanIdRef.current = sid;
      setMatchCount(event.payload.match_count);
      setScanTimeUs(event.payload.scan_time_us);
      setIsScanning(false);
      setError(null);
      // Auto-fetch the first page (scanIdRef is set above, so loadPage's guard passes).
      loadPage(0);
    });

    const unlistenResults = listen<PointerScanResultsPayload>('pointer-scan-results', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setResults(event.payload.paths);
      setTotalCount(event.payload.total_count);
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
    if (!sessionId || !isPaused) return;
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
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, isPaused, targetAddress, maxOffset, maxDepth, selectedModuleBases]);

  const handleNewScan = useCallback(async () => {
    if (scanId !== null && sessionId) {
      try {
        await invoke('request_pointer_scan_reset', { sessionId, scanId });
      } catch (_) { /* ignore */ }
    }
    clearScan();
  }, [sessionId, scanId, clearScan]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return {
    // State
    scanId, targetAddress, maxOffset, maxDepth, selectedModuleBases,
    matchCount, scanTimeUs, isScanning, error,
    results, totalCount, currentPage, totalPages, pageSize: PAGE_SIZE,
    // Setters
    setTargetAddress, setMaxOffset, setMaxDepth, setSelectedModuleBases,
    // Actions
    handleScan, handleNewScan, loadPage,
  };
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
