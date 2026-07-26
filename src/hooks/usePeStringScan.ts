import { useCallback, useMemo, useState } from 'react';
import {
  StringEntry, StringScanController, StringEncodingFilter, StringSortKey,
  STRING_SCAN_PAGE_SIZE,
} from '@/hooks/useStringScan';

/// One hit from `pe_string_scan` (joybug-core StringHit; address is a file offset).
export interface PeStringHit {
  address: number;
  encoding: string; // "Ascii" | "Utf16"
  length: number;
  text: string;
  truncated: boolean;
}

/// Result of `pe_string_scan`: the hits plus whether the backend cap truncated them.
export interface PeStringScanResult {
  hits: PeStringHit[];
  capped: boolean;
}

export type PeScanFn = (minLength: number, encodings: string, contains: string) => Promise<PeStringScanResult>;

interface StoredHit extends PeStringHit {
  lower: string; // precomputed for the post-scan filter
}

/**
 * StringScanController over a PE file's in-memory scan: the backend returns
 * all hits at once, so filtering, sorting, and paging happen client-side.
 * Entry addresses are file offsets serialized as hex strings ("0x1F00") — the
 * host formats them per its address display mode.
 */
export function usePeStringScan(scanFile: PeScanFn): StringScanController & { handleScan: () => void } {
  const [minLength, setMinLength] = useState('5');
  const [encodings, setEncodings] = useState<StringEncodingFilter>('both');
  const [contains, setContains] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<StringSortKey>('address');
  const [sortAsc, setSortAsc] = useState(true);
  const [hits, setHits] = useState<StoredHit[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanTimeUs, setScanTimeUs] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);

  const handleScan = useCallback(async () => {
    const min = parseInt(minLength, 10);
    if (isNaN(min) || min < 2) {
      setError('Minimum length must be at least 2');
      return;
    }
    setIsScanning(true);
    setError(null);
    setHits(null);
    setCapped(false);
    setCurrentPage(0);
    try {
      const started = performance.now();
      const result = await scanFile(min, encodings, contains.trim());
      setScanTimeUs(Math.round((performance.now() - started) * 1000));
      setHits(result.hits.map((h) => ({ ...h, lower: h.text.toLowerCase() })));
      setCapped(result.capped);
    } catch (e) {
      setError(String(e));
    }
    setIsScanning(false);
  }, [scanFile, minLength, encodings, contains]);

  const filtered = useMemo(() => {
    if (!hits) return [];
    const f = filter.trim().toLowerCase();
    return f ? hits.filter((h) => h.lower.includes(f)) : hits;
  }, [hits, filter]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    const cmp: (a: StoredHit, b: StoredHit) => number =
      sortKey === 'length' ? (a, b) => a.length - b.length :
      sortKey === 'value' ? (a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0) :
      (a, b) => a.address - b.address;
    return [...filtered].sort((a, b) => cmp(a, b) * dir);
  }, [filtered, sortKey, sortAsc]);

  const results = useMemo<StringEntry[]>(
    () => sorted
      .slice(currentPage * STRING_SCAN_PAGE_SIZE, (currentPage + 1) * STRING_SCAN_PAGE_SIZE)
      .map((h) => ({
        address: `0x${h.address.toString(16).toUpperCase()}`,
        encoding: h.encoding.toLowerCase(),
        length: h.length,
        text: h.text,
        truncated: h.truncated,
      })),
    [sorted, currentPage],
  );

  const totalPages = Math.ceil(filtered.length / STRING_SCAN_PAGE_SIZE);

  const toggleSort = useCallback((key: StringSortKey) => {
    setSortAsc((prevAsc) => (sortKey === key ? !prevAsc : true));
    setSortKey(key);
    setCurrentPage(0);
  }, [sortKey]);

  const loadPage = useCallback((page: number) => {
    setCurrentPage(Math.max(0, page));
  }, []);

  const setFilterAndRewind = useCallback((v: string) => {
    setFilter(v);
    setCurrentPage(0);
  }, []);

  return {
    hasScanned: hits !== null,
    minLength, setMinLength,
    encodings, setEncodings,
    contains, setContains,
    filter, setFilter: setFilterAndRewind,
    sortKey, sortAsc, toggleSort,
    results,
    matchCount: hits?.length ?? 0,
    totalCount: filtered.length,
    capped,
    scanTimeUs,
    isScanning,
    error,
    currentPage,
    totalPages,
    loadPage,
    handleScan,
  };
}
