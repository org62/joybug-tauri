import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatTauriError } from '@/lib/sessionHelpers';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useChangedValues } from '@/hooks/useChangedValues';

export type ScanValueType = 'U8' | 'U16' | 'U32' | 'U64' | 'F32' | 'F64';

export type ScanCompareType =
  | 'ExactValue' | 'UnknownInitialValue' | 'BiggerThan' | 'SmallerThan' | 'ValueBetween'
  | 'IncreasedValue' | 'DecreasedValue' | 'IncreasedValueBy' | 'DecreasedValueBy'
  | 'Changed' | 'Unchanged';

export const FIRST_SCAN_COMPARE_TYPES: ScanCompareType[] = [
  'ExactValue', 'UnknownInitialValue', 'BiggerThan', 'SmallerThan', 'ValueBetween',
];

export const NEXT_SCAN_COMPARE_TYPES: ScanCompareType[] = [
  'ExactValue', 'BiggerThan', 'SmallerThan', 'ValueBetween',
  'Changed', 'Unchanged', 'IncreasedValue', 'DecreasedValue', 'IncreasedValueBy', 'DecreasedValueBy',
];

const NO_VALUE_COMPARE_TYPES: ScanCompareType[] = [
  'UnknownInitialValue', 'Changed', 'Unchanged', 'IncreasedValue', 'DecreasedValue',
];

// IncreasedValueBy/DecreasedValueBy take their amount in the FIRST value slot
// (joybug-core compares against `value`; `value2` is ignored for them).
const TWO_VALUE_COMPARE_TYPES: ScanCompareType[] = [
  'ValueBetween',
];

export function needsValue(ct: ScanCompareType): boolean {
  return !NO_VALUE_COMPARE_TYPES.includes(ct);
}

export function needsSecondValue(ct: ScanCompareType): boolean {
  return TWO_VALUE_COMPARE_TYPES.includes(ct);
}

export interface ScanResultEntry {
  address: string;
  value: { value_type: string; display: string };
}

const PAGE_SIZE = 200;

interface ScanMatchResultPayload {
  session_id: string;
  scan_id: number;
  match_count: number;
  scan_time_us: number;
}

interface ScanResultsPayload {
  session_id: string;
  scan_id: number;
  addresses: string[];
  values: { value_type: string; display: string }[];
  total_count: number;
}

interface ScanErrorPayload {
  session_id: string;
  error: string;
}

export function useMemoryScanner(sessionId: string | undefined, available: boolean, isLive: boolean) {
  const [scanId, setScanId] = useState<number | null>(null);
  const [valueType, setValueType] = useState<ScanValueType>('U32');
  const [compareType, setCompareType] = useState<ScanCompareType>('ExactValue');
  const [value, setValue] = useState('');
  const [value2, setValue2] = useState('');
  const [alignment, setAlignment] = useState<string>('');
  const [floatTolerance, setFloatTolerance] = useState<string>('');
  const [writableOnly, setWritableOnly] = useState(true);

  const [matchCount, setMatchCount] = useState<number>(0);
  const [scanTimeUs, setScanTimeUs] = useState<number>(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isFirstScan, setIsFirstScan] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [results, setResults] = useState<ScanResultEntry[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(0);

  const scanIdRef = useRef<number | null>(null);
  scanIdRef.current = scanId;

  const compareTypeRef = useRef(compareType);
  compareTypeRef.current = compareType;

  const currentPageRef = useRef(0);
  currentPageRef.current = currentPage;

  // Reset only when session ends (not on pause/resume — scan survives stepping)
  useEffect(() => {
    if (!sessionId) {
      setScanId(null);
      setMatchCount(0);
      setScanTimeUs(0);
      setIsScanning(false);
      setIsFirstScan(true);
      setError(null);
      setResults([]);
      setTotalCount(0);
      setCurrentPage(0);
    }
  }, [sessionId]);

  // Fetch a page of results
  const loadPage = useCallback(async (page: number) => {
    if (!sessionId || scanIdRef.current === null) return;
    try {
      await invoke('request_scan_memory_get_results', {
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

  // Listen for events
  useEffect(() => {
    if (!sessionId) return;

    const unlistenStart = listen<ScanMatchResultPayload>('scan-memory-start-result', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const sid = event.payload.scan_id;
      setScanId(sid);
      scanIdRef.current = sid;
      setMatchCount(event.payload.match_count);
      setScanTimeUs(event.payload.scan_time_us);
      setIsScanning(false);
      setIsFirstScan(false);
      setError(null);
      // The compare type set changes between first and next scans; a stale
      // UnknownInitialValue would be rejected by the next scan.
      if (!NEXT_SCAN_COMPARE_TYPES.includes(compareTypeRef.current)) {
        setCompareType('Changed');
      }
      // Auto-fetch first page
      invoke('request_scan_memory_get_results', {
        sessionId,
        scanId: sid,
        offset: 0,
        count: PAGE_SIZE,
      }).catch(() => {});
      setCurrentPage(0);
    });

    const unlistenNext = listen<ScanMatchResultPayload>('scan-memory-next-result', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setMatchCount(event.payload.match_count);
      setScanTimeUs(event.payload.scan_time_us);
      setIsScanning(false);
      setError(null);
      // Auto-fetch first page
      if (scanIdRef.current !== null) {
        invoke('request_scan_memory_get_results', {
          sessionId,
          scanId: scanIdRef.current,
          offset: 0,
          count: PAGE_SIZE,
        }).catch(() => {});
        setCurrentPage(0);
      }
    });

    const unlistenResults = listen<ScanResultsPayload>('scan-memory-results', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const entries: ScanResultEntry[] = event.payload.addresses.map((addr, i) => ({
        address: addr,
        value: event.payload.values[i] ?? { value_type: '', display: '' },
      }));
      setResults(entries);
      setTotalCount(event.payload.total_count);
    });

    const unlistenError = listen<ScanErrorPayload>('scan-memory-error', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setError(event.payload.error);
      setIsScanning(false);
    });

    return () => {
      unlistenStart.then(f => f());
      unlistenNext.then(f => f());
      unlistenResults.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionId]);

  // Poll current-page values while the target runs live (Running / non-invasive
  // Open) and re-fetch once after each step, on the shared cadence — the
  // process keeps mutating, so re-read the visible result addresses.
  useLiveRefresh(sessionId, isLive, () => {
    if (!sessionId || scanIdRef.current === null) return;
    invoke('request_scan_memory_get_results', {
      sessionId,
      scanId: scanIdRef.current,
      offset: currentPageRef.current * PAGE_SIZE,
      count: PAGE_SIZE,
    }).catch(() => {});
  });

  // Values that changed since the previous results fetch (red highlight);
  // baseline cleared when the scan or session changes so a new scan doesn't
  // diff against the old one.
  const changedAddresses = useChangedValues(
    results,
    (e) => e.address,
    (e) => e.value.display,
    `${sessionId}:${scanId}`,
  );

  const handleFirstScan = useCallback(async () => {
    if (!sessionId || !available) return;
    setIsScanning(true);
    setError(null);
    setResults([]);
    try {
      const alignVal = alignment ? parseInt(alignment, 10) : undefined;
      // 0 is a valid tolerance (strict comparison), so only blank/NaN become null
      const ftVal = floatTolerance ? parseFloat(floatTolerance) : NaN;
      await invoke('request_scan_memory_start', {
        sessionId,
        valueType,
        compareType,
        value: needsValue(compareType) ? (value || undefined) : undefined,
        value2: needsSecondValue(compareType) ? (value2 || undefined) : undefined,
        alignment: alignVal && !isNaN(alignVal) ? alignVal : null,
        floatTolerance: isNaN(ftVal) ? null : ftVal,
        writableOnly,
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, available, valueType, compareType, value, value2, alignment, floatTolerance, writableOnly]);

  const handleNextScan = useCallback(async () => {
    if (!sessionId || !available || scanId === null) return;
    setIsScanning(true);
    setError(null);
    try {
      const ftVal = floatTolerance ? parseFloat(floatTolerance) : NaN;
      await invoke('request_scan_memory_next', {
        sessionId,
        scanId,
        valueType,
        compareType,
        value: needsValue(compareType) ? (value || undefined) : undefined,
        value2: needsSecondValue(compareType) ? (value2 || undefined) : undefined,
        floatTolerance: isNaN(ftVal) ? null : ftVal,
      });
    } catch (e) {
      setError(formatTauriError(e));
      setIsScanning(false);
    }
  }, [sessionId, available, scanId, valueType, compareType, value, value2, floatTolerance]);

  const handleNewScan = useCallback(async () => {
    if (scanId !== null && sessionId) {
      try {
        await invoke('request_scan_memory_reset', { sessionId, scanId });
      } catch (_) { /* ignore */ }
    }
    setScanId(null);
    setMatchCount(0);
    setScanTimeUs(0);
    setIsFirstScan(true);
    setError(null);
    setResults([]);
    setTotalCount(0);
    setCurrentPage(0);
    // Next-scan-only compare types (Changed, Increased, ...) are rejected by
    // a first scan; fall back to ExactValue.
    if (!FIRST_SCAN_COMPARE_TYPES.includes(compareTypeRef.current)) {
      setCompareType('ExactValue');
    }
  }, [sessionId, scanId]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return {
    // State
    scanId, valueType, compareType, value, value2,
    alignment, floatTolerance, writableOnly,
    matchCount, scanTimeUs, isScanning, isFirstScan, error,
    results, changedAddresses, totalCount, currentPage, totalPages, pageSize: PAGE_SIZE,
    // Setters
    setValueType, setCompareType, setValue, setValue2,
    setAlignment, setFloatTolerance, setWritableOnly,
    // Actions
    handleFirstScan, handleNextScan, handleNewScan, loadPage,
  };
}
