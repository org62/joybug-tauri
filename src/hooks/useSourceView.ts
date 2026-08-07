import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { formatTauriError, isBenignSessionError } from '@/lib/sessionHelpers';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { sourceNavigation } from '@/lib/navigationStore';

export interface SourceFileInfo {
  path: string;
  checksum_kind: string;
  checksum: string;
}

// Payloads mirror the backend events in session/source.rs
interface SourceLineResolvedPayload {
  session_id: string;
  address: string;
  info: {
    module_path: string;
    module_base: string;
    file_path: string;
    line: number;
    checksum_kind: string;
    checksum: string;
  } | null;
}

interface SourceFileLineMapPayload {
  session_id: string;
  module_base: string;
  file_path: string;
  checksum_kind: string | null;
  checksum: string | null;
  entries: { address: string; rva: number; length: number; line: number; line_end: number }[];
}

interface SourceFilesListedPayload {
  session_id: string;
  module_base: string;
  files: SourceFileInfo[];
}

// Synchronous command results (commands/source.rs)
interface SourceFileMeta {
  resolved_path: string;
  line_count: number;
  checksum_matches: boolean | null;
}
interface SourceWindow {
  start_line: number;
  lines: string[];
}

/** A pending scroll instruction for the view; `seq` guarantees fresh identity. */
export interface ScrollToLine {
  line: number;
  transient: boolean;
  seq: number;
}

// Sliding-window sizing. The window is always ≤ MAX_WINDOW lines, so the webview
// holds a bounded amount of text even for multi-GB files, and syntax highlighting
// (capped at 20k lines) always covers the whole window.
const WINDOW_CHUNK = 2000; // lines fetched per edge extension
const INITIAL_HALF = 2000; // lines loaded on each side of a goto/PC target
const MAX_WINDOW = 12000; // trim the far edge past this
const META_CACHE_MAX = 8;

function normAddr(hex: string): string {
  try {
    return BigInt(hex).toString(16).toLowerCase();
  } catch {
    return hex.toLowerCase();
  }
}

function fileKey(moduleBase: string, filePath: string): string {
  return `${normAddr(moduleBase)}|${filePath.toLowerCase()}`;
}

export interface UseSourceViewOptions {
  sessionId: string | undefined;
  isPaused?: boolean;
  pcAddress?: number;
  /** Changes when a module's symbols finish loading; triggers a PC re-resolve so
   * line info appears once a module's PDB path becomes known. */
  symbolsRefreshKey?: string;
}

export interface SourceViewState {
  filePath: string | null;
  /** Total line count of the current file (the window is a slice of this). */
  lineCount: number;
  /** 1-based line number of `windowLines[0]`. */
  windowStart: number;
  /** The currently loaded slice of source text. */
  windowLines: string[];
  /** Source line number → instruction addresses (hex, ascending), for the loaded window. */
  lineMap: Map<number, string[]>;
  pcLine: number | null;
  navTargetLine: number | null;
  fileList: SourceFileInfo[];
  followPc: boolean;
  fileMissing: boolean;
  checksumMismatch: boolean;
  noLineInfo: boolean;
  isLoading: boolean;
  scrollToLine: ScrollToLine | null;
}

export interface SourceViewActions {
  selectFile: (filePath: string) => void;
  locateFile: () => Promise<void>;
  toggleFollowPc: () => void;
  refresh: () => void;
  /** Extend the window toward the top; returns true if a fetch started. */
  extendUp: () => boolean;
  /** Extend the window toward the bottom; returns true if a fetch started. */
  extendDown: () => boolean;
  /** Navigate the disassembly view to a source line's first instruction. */
  lineToAddress: (line: number) => string | null;
}

interface OpenFile {
  key: string;
  moduleBase: string;
  filePath: string;
  resolvedPath: string;
  lineCount: number;
}

export function useSourceView(options: UseSourceViewOptions): SourceViewState & SourceViewActions {
  const { sessionId, isPaused, pcAddress: pcAddressProp, symbolsRefreshKey } = options;

  const [filePath, setFilePath] = useState<string | null>(null);
  const [moduleBase, setModuleBase] = useState<string | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [windowStart, setWindowStart] = useState(1);
  const [windowLines, setWindowLines] = useState<string[]>([]);
  const [lineMap, setLineMap] = useState<Map<number, string[]>>(new Map());
  const [pcLine, setPcLine] = useState<number | null>(null);
  const [navTargetLine, setNavTargetLine] = useState<number | null>(null);
  const [fileList, setFileList] = useState<SourceFileInfo[]>([]);
  const [followPc, setFollowPc] = useState(true);
  const [fileMissing, setFileMissing] = useState(false);
  const [checksumMismatch, setChecksumMismatch] = useState(false);
  const [noLineInfo, setNoLineInfo] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [scrollToLine, setScrollToLine] = useState<ScrollToLine | null>(null);

  const pcAddress = pcAddressProp != null ? BigInt(pcAddressProp) : null;
  const followPcRef = useRef(followPc);
  followPcRef.current = followPc;

  // normalized address -> intent of an in-flight resolve_address_to_line
  const pendingResolvesRef = useRef(new Map<string, { isPc: boolean }>());
  // The currently open file (identity + resolved path + total lines), for handlers.
  const openRef = useRef<OpenFile | null>(null);
  // Serializes window reads (open/extend) so they don't interleave.
  const fetchingRef = useRef(false);
  // Increments on every openFile so stale async results can be discarded.
  const openTokenRef = useRef(0);
  // key -> cached meta so switching back to a file skips the re-scan open call.
  const metaCacheRef = useRef(new Map<string, SourceFileMeta & { fileMissing: boolean }>());
  // pdb file path (lowercased) -> user-picked local override
  const manualPathsRef = useRef(new Map<string, string>());
  const listedBasesRef = useRef(new Set<string>());
  const seqRef = useRef(0);
  // Mirror window bounds for scroll/extend handlers without stale closures.
  const windowRef = useRef({ start: 1, len: 0 });
  windowRef.current = { start: windowStart, len: windowLines.length };

  const requestScroll = useCallback((line: number, transient: boolean) => {
    seqRef.current += 1;
    setScrollToLine({ line, transient, seq: seqRef.current });
  }, []);

  const cacheMeta = useCallback((key: string, meta: SourceFileMeta & { fileMissing: boolean }) => {
    const cache = metaCacheRef.current;
    cache.delete(key);
    cache.set(key, meta);
    while (cache.size > META_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);

  // Read a window [start, start+count) and apply it (replace / prepend / append).
  // The line map for the resulting window is fetched by a separate effect that
  // watches the window bounds, so this only touches the text.
  const loadWindow = useCallback(
    async (start: number, count: number, mode: 'replace' | 'prepend' | 'append', token: number) => {
      const of = openRef.current;
      // Missing files have no resolved path — nothing to read.
      if (!of || !of.resolvedPath) return;
      try {
        const win = await invoke<SourceWindow>('read_source_window', {
          resolvedPath: of.resolvedPath,
          startLine: Math.max(1, start),
          count,
        });
        if (token !== openTokenRef.current) return; // superseded by a newer open
        if (mode === 'replace') {
          setWindowStart(win.start_line);
          setWindowLines(win.lines);
        } else if (mode === 'prepend') {
          setWindowLines((prev) => {
            let combined = [...win.lines, ...prev];
            if (combined.length > MAX_WINDOW) combined = combined.slice(0, MAX_WINDOW);
            return combined;
          });
          setWindowStart(win.start_line);
        } else {
          // append — trim the top if the window grows past MAX_WINDOW
          const { start: prevStart, len: prevLen } = windowRef.current;
          const dropFront = Math.max(0, prevLen + win.lines.length - MAX_WINDOW);
          setWindowLines((prev) => {
            const combined = [...prev, ...win.lines];
            return dropFront > 0 ? combined.slice(dropFront) : combined;
          });
          if (dropFront > 0) setWindowStart(prevStart + dropFront);
        }
      } catch (err) {
        const msg = formatTauriError(err);
        if (!isBenignSessionError(msg)) console.warn('read_source_window failed:', msg);
      }
    },
    [],
  );

  // Open a file (if not already open) and reveal `targetLine`. Loads a window
  // centered on the target rather than the whole file.
  const openFile = useCallback(
    async (mBase: string, fPath: string, checksumKind: string, checksum: string, targetLine: number, transient: boolean) => {
      if (!sessionId) return;
      const key = fileKey(mBase, fPath);
      const clampAndScroll = (lc: number) => Math.min(Math.max(targetLine, 1), Math.max(1, lc));

      // Already open: just move the window to the target and scroll.
      if (openRef.current?.key === key) {
        const lc = openRef.current.lineCount;
        const line = clampAndScroll(lc);
        const start = Math.max(1, line - INITIAL_HALF);
        const { start: ws, len } = windowRef.current;
        if (line < ws || line >= ws + len) {
          const token = openTokenRef.current;
          void loadWindow(start, INITIAL_HALF * 2, 'replace', token);
        }
        requestScroll(line, transient);
        return;
      }

      const token = ++openTokenRef.current;
      setIsLoading(true);

      const applyMeta = (meta: SourceFileMeta & { fileMissing: boolean }) => {
        openRef.current = { key, moduleBase: mBase, filePath: fPath, resolvedPath: meta.resolved_path, lineCount: meta.line_count };
        setModuleBase(mBase);
        setFilePath(fPath);
        setLineCount(meta.line_count);
        setChecksumMismatch(meta.checksum_matches === false);
        setFileMissing(meta.fileMissing);
        setLineMap(new Map());
        if (meta.fileMissing) {
          setWindowStart(1);
          setWindowLines([]);
          return;
        }
        const line = clampAndScroll(meta.line_count);
        const start = Math.max(1, line - INITIAL_HALF);
        void loadWindow(start, INITIAL_HALF * 2, 'replace', token);
        requestScroll(line, transient);
      };

      const cached = metaCacheRef.current.get(key);
      if (cached) {
        applyMeta(cached);
        setIsLoading(false);
        return;
      }

      let meta: SourceFileMeta & { fileMissing: boolean };
      try {
        const override = manualPathsRef.current.get(fPath.toLowerCase());
        const opened = await invoke<SourceFileMeta>('open_source_file', {
          filePath: override ?? fPath,
          checksumKind: checksumKind || null,
          checksum: checksum || null,
        });
        meta = { ...opened, fileMissing: false };
      } catch (err) {
        const msg = formatTauriError(err);
        if (!isBenignSessionError(msg)) console.warn('Source file unavailable:', msg);
        // The miss is cached (negatively) below: every PC move / disasm click
        // re-resolves the same file, and without this each one re-invokes
        // open_source_file. Refresh and Locate drop the cache to re-check disk.
        meta = { resolved_path: '', line_count: 0, checksum_matches: null, fileMissing: true };
      }
      if (token !== openTokenRef.current) return; // superseded — the newer open owns isLoading
      cacheMeta(key, meta);
      applyMeta(meta);
      setIsLoading(false);
    },
    [sessionId, loadWindow, cacheMeta, requestScroll],
  );

  // --- Edge extensions (called by the view on scroll near a boundary) ---
  const extendUp = useCallback((): boolean => {
    const open = openRef.current;
    const { start } = windowRef.current;
    if (!open || fetchingRef.current || start <= 1) return false;
    fetchingRef.current = true;
    const newStart = Math.max(1, start - WINDOW_CHUNK);
    void loadWindow(newStart, start - newStart, 'prepend', openTokenRef.current).finally(() => {
      fetchingRef.current = false;
    });
    return true;
  }, [loadWindow]);

  const extendDown = useCallback((): boolean => {
    const open = openRef.current;
    const { start, len } = windowRef.current;
    if (!open || fetchingRef.current || start + len - 1 >= open.lineCount) return false;
    fetchingRef.current = true;
    void loadWindow(start + len, WINDOW_CHUNK, 'append', openTokenRef.current).finally(() => {
      fetchingRef.current = false;
    });
    return true;
  }, [loadWindow]);

  // Issue a resolve_address_to_line, recording whether it follows the PC.
  const resolveAddress = useCallback(
    async (address: bigint, isPc: boolean) => {
      if (!sessionId) return;
      const hex = `0x${address.toString(16)}`;
      pendingResolvesRef.current.set(normAddr(hex), { isPc });
      try {
        await invoke('resolve_address_to_line', { sessionId, address: hex });
      } catch (err) {
        pendingResolvesRef.current.delete(normAddr(hex));
        const msg = formatTauriError(err);
        if (!isBenignSessionError(msg)) console.warn('resolve_address_to_line failed:', msg);
      }
    },
    [sessionId],
  );

  // --- Event listeners ---
  useEffect(() => {
    if (!sessionId) return;

    const unlistenResolved = listen<SourceLineResolvedPayload>('source-line-resolved', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const intent = pendingResolvesRef.current.get(normAddr(event.payload.address));
      if (!intent) return;
      pendingResolvesRef.current.delete(normAddr(event.payload.address));

      const info = event.payload.info;
      if (!info) {
        if (intent.isPc) {
          setPcLine(null);
          setNoLineInfo(true);
        }
        return;
      }

      if (intent.isPc) {
        setNoLineInfo(false);
        setPcLine(info.line);
        if (followPcRef.current) {
          openFile(info.module_base, info.file_path, info.checksum_kind, info.checksum, info.line, false);
        } else {
          // Not following: only keep the highlight if the PC is in the shown file.
          const open = openRef.current;
          const inView = open
            && normAddr(open.moduleBase) === normAddr(info.module_base)
            && open.filePath.toLowerCase() === info.file_path.toLowerCase();
          if (!inView) setPcLine(null);
        }
      } else {
        // Disassembly → source sync: reveal the file and flash the line.
        setNavTargetLine(info.line);
        openFile(info.module_base, info.file_path, info.checksum_kind, info.checksum, info.line, true);
      }
    });

    const unlistenMap = listen<SourceFileLineMapPayload>('source-file-line-map', (event) => {
      if (event.payload.session_id !== sessionId) return;
      const open = openRef.current;
      if (!open) return;
      // Ignore maps for a different file than the one displayed.
      if (normAddr(event.payload.module_base) !== normAddr(open.moduleBase)) return;
      if (event.payload.file_path.toLowerCase() !== open.filePath.toLowerCase()) return;

      const map = new Map<number, string[]>();
      for (const entry of event.payload.entries) {
        const arr = map.get(entry.line);
        if (arr) arr.push(entry.address);
        else map.set(entry.line, [entry.address]);
      }
      for (const arr of map.values()) {
        arr.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
      }
      setLineMap(map);
    });

    const unlistenFiles = listen<SourceFilesListedPayload>('source-files-listed', (event) => {
      if (event.payload.session_id !== sessionId) return;
      setFileList(event.payload.files);
    });

    return () => {
      unlistenResolved.then((u) => u());
      unlistenMap.then((u) => u());
      unlistenFiles.then((u) => u());
    };
  }, [sessionId, openFile]);

  // Follow the PC while paused.
  const lastPcRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (!sessionId || pcAddress === null || isPaused === false) return;
    if (lastPcRef.current === pcAddress) return;
    lastPcRef.current = pcAddress;
    setNavTargetLine(null);
    resolveAddress(pcAddress, true);
  }, [sessionId, pcAddress, isPaused, resolveAddress]);

  // When symbols finish loading, re-resolve the PC so line info can appear.
  const prevSymbolsKey = useRef(symbolsRefreshKey);
  useEffect(() => {
    if (symbolsRefreshKey === prevSymbolsKey.current) return;
    prevSymbolsKey.current = symbolsRefreshKey;
    if (pcAddress !== null) {
      lastPcRef.current = null;
      resolveAddress(pcAddress, true);
    }
  }, [symbolsRefreshKey, pcAddress, resolveAddress]);

  // List a module's source files once its base becomes known (for the file picker).
  useEffect(() => {
    if (!sessionId || !moduleBase) return;
    const norm = normAddr(moduleBase);
    if (listedBasesRef.current.has(norm)) return;
    listedBasesRef.current.add(norm);
    invoke('list_source_files', { sessionId, moduleBase }).catch(() => {});
  }, [sessionId, moduleBase]);

  // Fetch the line map for the currently loaded window range only (bounded
  // response even for huge files). Debounced so rapid extends coalesce.
  useEffect(() => {
    if (!sessionId || !moduleBase || !filePath || fileMissing || windowLines.length === 0) return;
    const start = windowStart;
    const end = windowStart + windowLines.length - 1;
    const timer = setTimeout(() => {
      invoke('get_source_file_line_map', {
        sessionId,
        moduleBase,
        filePath,
        startLine: start,
        endLine: end,
      }).catch(() => {});
    }, 60);
    return () => clearTimeout(timer);
  }, [sessionId, moduleBase, filePath, fileMissing, windowStart, windowLines.length]);

  // Disassembly → source navigation channel (passive; does not steal focus).
  useNavigationChannel(sourceNavigation, (addr) => {
    try {
      resolveAddress(BigInt(addr), false);
    } catch {
      /* ignore malformed address */
    }
  });

  // Reset all state when the session ends or resumes.
  useEffect(() => {
    if (!sessionId || isPaused === false) {
      setFilePath(null);
      setModuleBase(null);
      setLineCount(0);
      setWindowStart(1);
      setWindowLines([]);
      setLineMap(new Map());
      setPcLine(null);
      setNavTargetLine(null);
      setFileList([]);
      setFileMissing(false);
      setChecksumMismatch(false);
      setNoLineInfo(false);
      setIsLoading(false);
      setScrollToLine(null);
      pendingResolvesRef.current.clear();
      metaCacheRef.current.clear();
      openRef.current = null;
      openTokenRef.current++;
      fetchingRef.current = false;
      listedBasesRef.current.clear();
      lastPcRef.current = null;
    }
  }, [sessionId, isPaused]);

  // --- Actions ---
  const selectFile = useCallback(
    (targetPath: string) => {
      if (!moduleBase) return;
      const info = fileList.find((f) => f.path === targetPath);
      openFile(moduleBase, targetPath, info?.checksum_kind ?? '', info?.checksum ?? '', 1, false);
    },
    [moduleBase, fileList, openFile],
  );

  const locateFile = useCallback(async () => {
    if (!filePath || !moduleBase) return;
    const picked = await openFileDialog({ multiple: false, directory: false, title: `Locate ${filePath}` });
    if (typeof picked !== 'string') return;
    manualPathsRef.current.set(filePath.toLowerCase(), picked);
    // Drop cached meta + force re-open from the override.
    const key = fileKey(moduleBase, filePath);
    metaCacheRef.current.delete(key);
    openRef.current = null;
    const info = fileList.find((f) => f.path === filePath);
    await openFile(moduleBase, filePath, info?.checksum_kind ?? '', info?.checksum ?? '', pcLine ?? 1, false);
  }, [filePath, moduleBase, fileList, pcLine, openFile]);

  const toggleFollowPc = useCallback(() => {
    setFollowPc((prev) => {
      const next = !prev;
      if (next && pcAddress !== null) {
        lastPcRef.current = null;
        resolveAddress(pcAddress, true);
      }
      return next;
    });
  }, [pcAddress, resolveAddress]);

  const refresh = useCallback(() => {
    // Re-check the disk for the current file and any negative "file missing"
    // entries (e.g. after the user copied sources into place). Other files'
    // metas stay cached — re-opening one re-streams the whole file.
    const currentKey = openRef.current?.key;
    for (const [k, m] of metaCacheRef.current) {
      if (m.fileMissing || k === currentKey) metaCacheRef.current.delete(k);
    }
    // Dropping a meta must also clear openRef, or the already-open fast path
    // in openFile skips the re-open (same pairing as locateFile).
    openRef.current = null;
    if (pcAddress !== null) {
      lastPcRef.current = null;
      resolveAddress(pcAddress, true);
    }
  }, [pcAddress, resolveAddress]);

  const lineToAddress = useCallback((line: number): string | null => lineMap.get(line)?.[0] ?? null, [lineMap]);

  return {
    filePath,
    lineCount,
    windowStart,
    windowLines,
    lineMap,
    pcLine,
    navTargetLine,
    fileList,
    followPc,
    fileMissing,
    checksumMismatch,
    noLineInfo,
    isLoading,
    scrollToLine,
    selectFile,
    locateFile,
    toggleFollowPc,
    refresh,
    extendUp,
    extendDown,
    lineToAddress,
  };
}
