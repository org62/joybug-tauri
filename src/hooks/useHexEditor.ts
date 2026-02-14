import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError, toastSuccess, toastInfo } from '@/lib/logger';
import {
  ViewMode,
  VIEW_MODE_CONFIGS,
  BYTES_PER_ROW,
  DEFAULT_CHUNK_SIZE,
  parseAddressExpression,
  RegisterContext,
  SymbolResolver,
  getNormalizedSelection,
  getSelectedBytes,
  formatBytesAsText,
  formatBytesAsHexUnits,
  formatBytesAsDump,
  parseHexToBytes,
  DereferenceEntry,
  DereferenceResultPayload,
} from '@/lib/hexUtils';

// Persistent state store (survives component unmount within session)
interface HexViewPersistedState {
  baseAddress: bigint;
  viewMode: ViewMode;
}
const sessionStateStore = new Map<string, HexViewPersistedState>();

interface MemoryReadResult {
  session_id: string;
  address: number;
  requested_size: number;
  data: number[];
}

interface MemoryReadError {
  session_id: string;
  address: number;
  error: string;
}

interface MemoryWriteResult {
  session_id: string;
  address: number;
  success: boolean;
  bytes_written: number;
}

interface MemoryWriteError {
  session_id: string;
  address: number;
  error: string;
}

export interface HexEditorState {
  baseAddress: bigint;
  memoryData: Uint8Array;
  viewMode: ViewMode;
  bytesPerRow: number;
  isLoading: boolean;
  error: string | null;
  // Selection state
  selectionStart: number | null;
  selectionEnd: number | null;
  selectedOffsets: Set<number>;
  isDragging: boolean;
  // Editing state
  editingOffset: number | null;
  editingColumn: 'hex' | 'ascii';
  editBuffer: string;
  // Other
  pendingChanges: Map<number, number>;
  littleEndian: boolean;
  // Change detection
  changedOffsets: Set<number>;
  // Dereference data (pointer mode)
  dereferenceData: Map<string, DereferenceEntry>;
}

export interface HexEditorActions {
  goToAddress: (address: string | bigint) => Promise<void>;
  refresh: () => void;
  setViewMode: (mode: ViewMode) => void;
  // Pagination
  loadPreviousPage: () => void;
  loadNextPage: () => void;
  // Pending changes
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
  // Selection actions
  setSelection: (start: number | null, end: number | null) => void;
  clearSelection: () => void;
  extendSelection: (offset: number) => void;
  setIsDragging: (dragging: boolean) => void;
  // Editing actions
  startHexEdit: (offset: number) => void;
  startAsciiEdit: (offset: number) => void;
  handleKeyInput: (key: string) => boolean;
  commitEdit: () => void;
  cancelEdit: () => void;
  // Clipboard actions
  copySelection: (format: 'text' | 'hex' | 'dump') => Promise<void>;
  pasteBytes: (mode: 'hex' | 'text') => Promise<void>;
}

export interface UseHexEditorOptions {
  sessionId: string | undefined;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  initialAddress?: bigint;
  initialViewMode?: ViewMode;
}

export function useHexEditor(options: UseHexEditorOptions): HexEditorState & HexEditorActions {
  const { sessionId, memoryViewId = 'memory', sessionStatus, registers = {}, resolveSymbol, initialAddress, initialViewMode } = options;

  // Persistence key for this view
  const persistenceKey = sessionId ? `${sessionId}-${memoryViewId}` : undefined;
  const persisted = persistenceKey ? sessionStateStore.get(persistenceKey) : undefined;

  // Initialize from: persisted state > initialAddress > 0
  const [baseAddress, setBaseAddressRaw] = useState<bigint>(persisted?.baseAddress ?? initialAddress ?? 0n);
  const [memoryData, setMemoryData] = useState<Uint8Array>(new Uint8Array(0));
  const [viewMode, setViewModeRaw] = useState<ViewMode>(persisted?.viewMode ?? initialViewMode ?? 'byte');

  // Persist on change
  const setBaseAddress = useCallback((address: bigint) => {
    setBaseAddressRaw(address);
    if (persistenceKey) {
      const existing = sessionStateStore.get(persistenceKey) || { baseAddress: 0n, viewMode: 'byte' as ViewMode };
      sessionStateStore.set(persistenceKey, { ...existing, baseAddress: address });
    }
  }, [persistenceKey]);

  const setViewModeInternal = useCallback((mode: ViewMode) => {
    setViewModeRaw(mode);
    if (persistenceKey) {
      const existing = sessionStateStore.get(persistenceKey) || { baseAddress: 0n, viewMode: 'byte' as ViewMode };
      sessionStateStore.set(persistenceKey, { ...existing, viewMode: mode });
    }
  }, [persistenceKey]);
  const [bytesPerRow] = useState<number>(BYTES_PER_ROW);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<number, number>>(new Map());
  const littleEndian = true; // Always little-endian as per requirements

  // Dereference data for pointer mode (keyed by address string)
  const [dereferenceData, setDereferenceData] = useState<Map<string, DereferenceEntry>>(new Map());
  const pendingDereferenceAddress = useRef<string | null>(null);

  // Previous memory data for change detection (highlight changed bytes in red)
  const prevMemoryDataRef = useRef<{ data: Uint8Array; baseAddress: bigint } | undefined>(undefined);
  const lastSeenMemoryDataRef = useRef<Uint8Array | null>(null);

  // New selection state (replaces single selectedOffset for multi-selection)
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Editing state - no visible input, byte stays visible, typing overwrites
  const [editingOffset, setEditingOffset] = useState<number | null>(null);
  const [editingColumn, setEditingColumn] = useState<'hex' | 'ascii'>('hex');
  const [editBuffer, setEditBuffer] = useState(""); // Partial hex input (0-2 chars)

  // Computed: set of all selected offsets for O(1) lookup
  const selectedOffsets = useMemo(() => {
    const set = new Set<number>();
    if (selectionStart !== null && selectionEnd !== null) {
      const start = Math.min(selectionStart, selectionEnd);
      const end = Math.max(selectionStart, selectionEnd);
      for (let i = start; i <= end; i++) {
        set.add(i);
      }
    }
    return set;
  }, [selectionStart, selectionEnd]);
  const initialLoadDone = useRef(false);
  const pendingReadAddress = useRef<bigint | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  // Ref for auto-reload: tracks current address for the session-updated listener
  const baseAddressRef = useRef<bigint>(baseAddress);
  baseAddressRef.current = baseAddress;


  // Load memory from specified address
  const loadMemory = useCallback(async (address: bigint) => {
    if (!sessionId) return;

    setIsLoading(true);
    setError(null);
    pendingReadAddress.current = address;

    try {
      await invoke('request_memory_read', {
        sessionId,
        address: Number(address),
        size: DEFAULT_CHUNK_SIZE,
      });
      // Results will come via event
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message :
        (typeof err === 'object' && err !== null && 'message' in err) ? String((err as any).message) :
        (typeof err === 'string') ? err : JSON.stringify(err);
      setError(errorMsg);
      toastError(`Failed to read memory: ${errorMsg}`, sessionId);
      setIsLoading(false);
      pendingReadAddress.current = null;
    }
  }, [sessionId]);

  // Load dereference data for pointer mode
  const loadDereference = useCallback(async (address: bigint, count: number) => {
    if (!sessionId) return;

    const addrStr = `0x${address.toString(16).padStart(16, '0').toUpperCase()}`;
    pendingDereferenceAddress.current = addrStr;

    try {
      await invoke('request_dereference', {
        sessionId,
        address: `0x${address.toString(16)}`,
        count,
      });
      // Results will come via event
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message :
        (typeof err === 'object' && err !== null && 'message' in err) ? String((err as any).message) :
        (typeof err === 'string') ? err : JSON.stringify(err);
      // Don't show error toast for dereference - it's supplementary data
      console.error(`Failed to dereference: ${errorMsg}`);
      pendingDereferenceAddress.current = null;
    }
  }, [sessionId]);

  // Go to specific address (supports expressions like rax+0x10, symbol+offset)
  const goToAddress = useCallback(async (address: string | bigint) => {
    let targetAddress: bigint;

    if (typeof address === 'string') {
      const result = await parseAddressExpression(address, registers, resolveSymbol);
      if (result.address === null) {
        toastError(result.error || 'Invalid address expression', sessionId);
        return;
      }
      targetAddress = result.address;
    } else {
      targetAddress = address;
    }

    setBaseAddress(targetAddress);
    setSelectionStart(null);
    setSelectionEnd(null);
    setEditingOffset(null);
    loadMemory(targetAddress);
  }, [loadMemory, registers, resolveSymbol]);

  // Refresh current view
  const refresh = useCallback(() => {
    if (baseAddress !== undefined) {
      loadMemory(baseAddress);
    }
  }, [baseAddress, loadMemory]);

  // Set view mode
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeInternal(mode);
  }, []);

  // ============================================================================
  // Selection actions
  // ============================================================================

  const setSelection = useCallback((start: number | null, end: number | null) => {
    setSelectionStart(start);
    setSelectionEnd(end);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionStart(null);
    setSelectionEnd(null);
  }, []);

  const extendSelection = useCallback((offset: number) => {
    const config = VIEW_MODE_CONFIGS[viewMode];

    if (selectionStart === null) {
      // Align to unit boundary
      const unitStart = Math.floor(offset / config.bytesPerUnit) * config.bytesPerUnit;
      const unitEnd = Math.min(unitStart + config.bytesPerUnit - 1, memoryData.length - 1);
      setSelectionStart(unitStart);
      setSelectionEnd(unitEnd);
    } else {
      // Extend selection to include the full unit at the offset
      const unitStart = Math.floor(offset / config.bytesPerUnit) * config.bytesPerUnit;
      const unitEnd = Math.min(unitStart + config.bytesPerUnit - 1, memoryData.length - 1);

      // Determine which end of the unit to use based on selection direction
      if (offset >= selectionStart) {
        // Extending forward: use the end of the unit
        setSelectionEnd(unitEnd);
      } else {
        // Extending backward: use the start of the unit
        setSelectionEnd(unitStart);
      }
    }
  }, [selectionStart, viewMode, memoryData.length]);

  // ============================================================================
  // Pagination actions
  // ============================================================================

  // Load previous page (scroll up past beginning)
  const loadPreviousPage = useCallback(() => {
    if (isLoading) return;
    // Go back by chunk size, but don't go below 0
    const newAddress = baseAddress > BigInt(DEFAULT_CHUNK_SIZE)
      ? baseAddress - BigInt(DEFAULT_CHUNK_SIZE)
      : 0n;
    if (newAddress !== baseAddress) {
      setBaseAddress(newAddress);
      clearSelection();
      setEditingOffset(null);
      loadMemory(newAddress);
    }
  }, [baseAddress, isLoading, loadMemory, setBaseAddress, clearSelection]);

  // Load next page (scroll down past end)
  const loadNextPage = useCallback(() => {
    if (isLoading) return;
    const newAddress = baseAddress + BigInt(DEFAULT_CHUNK_SIZE);
    setBaseAddress(newAddress);
    clearSelection();
    setEditingOffset(null);
    loadMemory(newAddress);
  }, [baseAddress, isLoading, loadMemory, setBaseAddress, clearSelection]);

  // ============================================================================
  // Editing actions - no visible input, byte stays visible, typing overwrites
  // ============================================================================

  // Start editing in hex mode (click on hex column)
  const startHexEdit = useCallback((offset: number) => {
    const config = VIEW_MODE_CONFIGS[viewMode];
    // Align offset to unit boundary for multi-byte modes
    const unitOffset = Math.floor(offset / config.bytesPerUnit) * config.bytesPerUnit;

    if (unitOffset < 0 || unitOffset >= memoryData.length) return;

    setEditingOffset(unitOffset);
    setEditingColumn('hex');
    setEditBuffer("");
    // Select all bytes in the unit
    const unitEnd = Math.min(unitOffset + config.bytesPerUnit - 1, memoryData.length - 1);
    setSelection(unitOffset, unitEnd);
  }, [viewMode, memoryData.length, setSelection]);

  // Start editing in ascii mode (click on ascii column)
  const startAsciiEdit = useCallback((offset: number) => {
    if (offset < 0 || offset >= memoryData.length) return;
    setEditingOffset(offset);
    setEditingColumn('ascii');
    setEditBuffer("");
    setSelection(offset, offset);
  }, [memoryData.length, setSelection]);

  // Handle key input - the main editing function
  const handleKeyInput = useCallback((key: string) => {
    // If no selection, nothing to edit
    if (selectionStart === null) return false;

    // Start editing at selection start if not already editing
    const offset = editingOffset ?? selectionStart;
    const column = editingOffset !== null ? editingColumn : 'hex';

    if (column === 'ascii') {
      // ASCII mode: printable characters become bytes directly
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
        const byteValue = key.charCodeAt(0);
        const newPendingChanges = new Map(pendingChanges);
        newPendingChanges.set(offset, byteValue);
        setPendingChanges(newPendingChanges);

        // Advance to next byte
        const nextOffset = offset + 1;
        if (nextOffset < memoryData.length) {
          setEditingOffset(nextOffset);
          setEditingColumn('ascii');
          setEditBuffer("");
          setSelection(nextOffset, nextOffset);
        } else {
          setEditingOffset(null);
          setEditBuffer("");
        }
        return true;
      }
    } else {
      // Hex column editing - mode-aware
      const config = VIEW_MODE_CONFIGS[viewMode];

      if (viewMode === 'float') {
        // Float mode: accept digits, decimal point, minus, exponent
        if (/^[0-9.\-eE+]$/.test(key)) {
          const newBuffer = editBuffer + key;
          setEditBuffer(newBuffer);

          if (!editingOffset) {
            setEditingOffset(offset);
            setEditingColumn('hex');
          }
          // No auto-commit for float (variable length) - user must press Enter/Tab
          return true;
        }
      } else {
        // Hex modes (byte, word, dword, qword, pointer): only hex characters allowed
        if (/^[0-9A-Fa-f]$/.test(key)) {
          const newBuffer = (editBuffer + key.toUpperCase()).slice(0, config.displayWidth);
          setEditBuffer(newBuffer);

          if (!editingOffset) {
            setEditingOffset(offset);
            setEditingColumn('hex');
          }

          // Auto-commit when buffer reaches full length for the current mode
          if (newBuffer.length === config.displayWidth) {
            const bytes = config.parseValue(newBuffer);
            if (bytes) {
              const newPendingChanges = new Map(pendingChanges);
              for (let i = 0; i < bytes.length; i++) {
                newPendingChanges.set(offset + i, bytes[i]);
              }
              setPendingChanges(newPendingChanges);
            }

            // Advance to next unit
            const nextOffset = offset + config.bytesPerUnit;
            if (nextOffset < memoryData.length) {
              setEditingOffset(nextOffset);
              setEditBuffer("");
              setSelection(nextOffset, nextOffset);
            } else {
              setEditingOffset(null);
              setEditBuffer("");
            }
          }
          return true;
        }
      }
    }
    return false;
  }, [selectionStart, editingOffset, editingColumn, editBuffer, pendingChanges, memoryData.length, setSelection, viewMode]);

  // Cancel current edit
  const cancelEdit = useCallback(() => {
    setEditingOffset(null);
    setEditBuffer("");
  }, []);

  // Commit partial edit - handles all view modes
  const commitEdit = useCallback(() => {
    if (editingOffset === null) {
      setEditingOffset(null);
      setEditBuffer("");
      return;
    }

    if (editBuffer.length > 0 && editingColumn === 'hex') {
      const config = VIEW_MODE_CONFIGS[viewMode];
      let bytes: Uint8Array | null = null;

      if (viewMode === 'float') {
        // Float: parse as-is (variable length input)
        bytes = config.parseValue(editBuffer);
      } else {
        // Hex modes: pad with leading zeros to full displayWidth
        const padded = editBuffer.padStart(config.displayWidth, '0');
        bytes = config.parseValue(padded);
      }

      if (bytes) {
        const newPendingChanges = new Map(pendingChanges);
        for (let i = 0; i < bytes.length; i++) {
          newPendingChanges.set(editingOffset + i, bytes[i]);
        }
        setPendingChanges(newPendingChanges);
      }
    }

    setEditingOffset(null);
    setEditBuffer("");
  }, [editingOffset, editBuffer, editingColumn, pendingChanges, viewMode]);

  // ============================================================================
  // Clipboard actions
  // ============================================================================

  const copySelection = useCallback(async (format: 'text' | 'hex' | 'dump') => {
    if (selectionStart === null || selectionEnd === null) {
      toastInfo('No selection to copy', sessionId);
      return;
    }

    const range = getNormalizedSelection(selectionStart, selectionEnd);
    if (!range) return;

    const selectedBytes = getSelectedBytes(memoryData, range.start, range.end);
    let text = '';

    switch (format) {
      case 'text':
        text = formatBytesAsText(selectedBytes);
        break;
      case 'hex':
        text = formatBytesAsHexUnits(selectedBytes, viewMode);
        break;
      case 'dump':
        text = formatBytesAsDump(memoryData, baseAddress, range.start, range.end);
        break;
    }

    try {
      await navigator.clipboard.writeText(text);
      const byteCount = range.end - range.start + 1;
      toastSuccess(`Copied ${byteCount} byte${byteCount !== 1 ? 's' : ''} as ${format}`, sessionId);
    } catch (err) {
      toastError('Failed to copy to clipboard', sessionId);
    }
  }, [selectionStart, selectionEnd, memoryData, baseAddress, sessionId, viewMode]);

  const pasteBytes = useCallback(async (mode: 'hex' | 'text') => {
    if (selectionStart === null) {
      toastInfo('No cursor position for paste', sessionId);
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      let bytes: number[] | null;

      if (mode === 'text') {
        // Text mode: convert each character to its ASCII byte value
        bytes = [];
        for (let i = 0; i < text.length; i++) {
          const charCode = text.charCodeAt(i);
          // Only accept printable ASCII and common control chars
          if (charCode < 256) {
            bytes.push(charCode);
          }
        }
        if (bytes.length === 0) {
          toastError('No valid characters to paste', sessionId);
          return;
        }
      } else {
        // Hex mode: parse according to current view mode
        // For float/pointer, use the equivalent integer format
        let effectiveMode: ViewMode = viewMode;
        if (viewMode === 'float') {
          effectiveMode = 'dword';
        } else if (viewMode === 'pointer') {
          effectiveMode = 'qword';
        }

        const config = VIEW_MODE_CONFIGS[effectiveMode];
        const unitStrings = text.trim().split(/\s+/);
        bytes = [];

        for (const unitStr of unitStrings) {
          const unitBytes = config.parseValue(unitStr);
          if (unitBytes) {
            bytes.push(...Array.from(unitBytes));
          }
        }

        // Fallback: try parsing as raw hex bytes if view-mode parsing failed
        if (bytes.length === 0) {
          const fallbackBytes = parseHexToBytes(text);
          if (fallbackBytes && fallbackBytes.length > 0) {
            bytes = Array.from(fallbackBytes);
          }
        }

        if (!bytes || bytes.length === 0) {
          toastError('Invalid hex format in clipboard', sessionId);
          return;
        }
      }

      // Add to pending changes
      const newPendingChanges = new Map(pendingChanges);
      let pastedCount = 0;
      for (let i = 0; i < bytes.length; i++) {
        const offset = selectionStart + i;
        if (offset < memoryData.length) {
          newPendingChanges.set(offset, bytes[i]);
          pastedCount++;
        }
      }

      if (pastedCount < bytes.length) {
        toastInfo(`Pasted ${pastedCount} of ${bytes.length} bytes (truncated at buffer end)`, sessionId);
      } else {
        toastSuccess(`Pasted ${pastedCount} byte${pastedCount !== 1 ? 's' : ''}`, sessionId);
      }

      setPendingChanges(newPendingChanges);

      // Move cursor to next unit after pasted data (for repeated paste)
      const nextOffset = selectionStart + pastedCount;
      if (nextOffset < memoryData.length) {
        // Align to unit boundary and select the full unit
        const config = VIEW_MODE_CONFIGS[viewMode];
        const unitStart = Math.floor(nextOffset / config.bytesPerUnit) * config.bytesPerUnit;
        const unitEnd = Math.min(unitStart + config.bytesPerUnit - 1, memoryData.length - 1);
        setSelection(unitStart, unitEnd);
      } else {
        // At end of buffer, select the pasted range
        setSelection(selectionStart, selectionStart + pastedCount - 1);
      }
    } catch (err) {
      toastError('Failed to read from clipboard', sessionId);
    }
  }, [selectionStart, pendingChanges, memoryData.length, sessionId, setSelection, viewMode]);

  // Apply pending changes by writing to memory
  const applyPendingChanges = useCallback(async () => {
    if (!sessionId || pendingChanges.size === 0) return;

    setIsLoading(true);

    try {
      // Group consecutive changes into chunks for efficiency
      const sortedOffsets = Array.from(pendingChanges.keys()).sort((a, b) => a - b);
      let chunkStart = sortedOffsets[0];
      let chunkData: number[] = [pendingChanges.get(sortedOffsets[0])!];

      for (let i = 1; i < sortedOffsets.length; i++) {
        const offset = sortedOffsets[i];
        if (offset === sortedOffsets[i - 1] + 1) {
          // Consecutive, add to current chunk
          chunkData.push(pendingChanges.get(offset)!);
        } else {
          // Non-consecutive, write current chunk and start new one
          await invoke('request_memory_write', {
            sessionId,
            address: Number(baseAddress) + chunkStart,
            data: chunkData,
          });
          chunkStart = offset;
          chunkData = [pendingChanges.get(offset)!];
        }
      }

      // Write final chunk
      await invoke('request_memory_write', {
        sessionId,
        address: Number(baseAddress) + chunkStart,
        data: chunkData,
      });

      setPendingChanges(new Map());
      // Refresh to get updated data
      loadMemory(baseAddress);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message :
        (typeof err === 'object' && err !== null && 'message' in err) ? String((err as any).message) :
        (typeof err === 'string') ? err : JSON.stringify(err);
      toastError(`Failed to write memory: ${errorMsg}`, sessionId);
      setIsLoading(false);
    }
  }, [sessionId, pendingChanges, baseAddress, loadMemory]);

  // Discard pending changes
  const discardPendingChanges = useCallback(() => {
    setPendingChanges(new Map());
  }, []);

  // Listen for memory read results
  useEffect(() => {
    if (!sessionId) return;

    const setupListeners = async () => {
      const unlistenRead = await listen<MemoryReadResult>('memory-read-updated', (event) => {
        // Only accept responses for this view's pending request
        if (event.payload.session_id === sessionId &&
            pendingReadAddress.current !== null &&
            BigInt(event.payload.address) === pendingReadAddress.current) {
          const { data, requested_size } = event.payload;
          const bytesRead = data.length;
          const isPartial = bytesRead < requested_size && bytesRead > 0;

          setMemoryData(new Uint8Array(data));
          setIsLoading(false);
          setError(null);
          pendingReadAddress.current = null;

          if (isPartial) {
            toastInfo(`Partial read: ${bytesRead} of ${requested_size} bytes (end of accessible memory)`, sessionId);
          }
        }
      });

      const unlistenReadError = await listen<MemoryReadError>('memory-read-error', (event) => {
        // Accept errors for this session if we have a pending read
        // Don't be too strict about address matching - precision issues can occur with large addresses
        if (event.payload.session_id === sessionId && pendingReadAddress.current !== null) {
          setError(event.payload.error);
          toastError(`Failed to read memory: ${event.payload.error}`, sessionId);
          setIsLoading(false);
          pendingReadAddress.current = null;
        }
      });

      const unlistenWrite = await listen<MemoryWriteResult>('memory-write-result', (event) => {
        if (event.payload.session_id === sessionId && event.payload.success) {
          toastSuccess(`Wrote ${event.payload.bytes_written} bytes`, sessionId);
        }
      });

      const unlistenWriteError = await listen<MemoryWriteError>('memory-write-error', (event) => {
        if (event.payload.session_id === sessionId) {
          toastError(`Write failed: ${event.payload.error}`, sessionId);
          setIsLoading(false);
        }
      });

      const unlistenDereference = await listen<DereferenceResultPayload>('dereference-updated', (event) => {
        if (event.payload.session_id === sessionId &&
            pendingDereferenceAddress.current !== null &&
            event.payload.base_address === pendingDereferenceAddress.current) {
          // Build map from address to entry
          const newData = new Map<string, DereferenceEntry>();
          for (const entry of event.payload.entries) {
            newData.set(entry.address, entry);
          }
          setDereferenceData(newData);
          pendingDereferenceAddress.current = null;
        }
      });

      // Signal that listeners are ready
      setListenersReady(true);

      return () => {
        unlistenRead();
        unlistenReadError();
        unlistenWrite();
        unlistenWriteError();
        unlistenDereference();
      };
    };

    const cleanup = setupListeners();
    return () => {
      setListenersReady(false);
      cleanup.then((fn) => fn?.());
    };
  }, [sessionId]);

  // Auto-reload memory after a debugging step.
  // Listens for session-updated directly (bypasses React batching which can swallow
  // the Running→Paused transition during fast steps, making status-based effects miss it).
  useEffect(() => {
    if (!sessionId || !listenersReady) return;

    let prevStatus: string | null = null;

    const setupListener = async () => {
      const unlisten = await listen<{ id: string; status: string }>('session-updated', (event) => {
        if (event.payload.id !== sessionId) return;
        const newStatus = event.payload.status;
        const wasNonPaused = prevStatus !== null && prevStatus !== 'Paused';
        prevStatus = newStatus;

        // Reload when session transitions TO Paused from Running (step/breakpoint)
        // and user has already loaded memory at an address
        if (newStatus === 'Paused' && wasNonPaused && initialLoadDone.current) {
          loadMemory(baseAddressRef.current);
        }
      });
      return unlisten;
    };

    const cleanup = setupListener();
    return () => { cleanup.then(fn => fn?.()); };
  }, [sessionId, listenersReady, loadMemory]);

  // Load memory on mount: persisted address > initialAddress
  useEffect(() => {
    if (!sessionId || initialLoadDone.current || !listenersReady || sessionStatus !== 'Paused') return;

    // Determine address to load: persisted > initialAddress
    const addressToLoad = persisted?.baseAddress ?? initialAddress;
    if (addressToLoad !== undefined && addressToLoad !== 0n) {
      initialLoadDone.current = true;
      loadMemory(addressToLoad);
    }
  }, [sessionId, loadMemory, initialAddress, sessionStatus, listenersReady, persisted?.baseAddress]);

  // Reset error and data when session stops, ends, or resumes
  useEffect(() => {
    if (!sessionId || !sessionStatus || sessionStatus !== 'Paused') {
      setError(null);
      setMemoryData(new Uint8Array(0));
      setDereferenceData(new Map());
      initialLoadDone.current = false;
    }
  }, [sessionId, sessionStatus]);

  // Fetch dereference data when in pointer mode and memory data is available
  useEffect(() => {
    if (viewMode !== 'pointer' || memoryData.length === 0 || !sessionId || sessionStatus !== 'Paused') {
      // Clear dereference data when not in pointer mode
      if (viewMode !== 'pointer' && dereferenceData.size > 0) {
        setDereferenceData(new Map());
      }
      return;
    }

    // Calculate how many pointers we have (8 bytes each)
    const pointerCount = Math.floor(memoryData.length / 8);
    if (pointerCount > 0) {
      loadDereference(baseAddress, pointerCount);
    }
  }, [viewMode, memoryData.length, baseAddress, sessionId, sessionStatus, loadDereference]);

  // Computed: effective memory data with pending changes applied for display
  const effectiveMemoryData = useMemo(() => {
    if (pendingChanges.size === 0) return memoryData;

    const result = new Uint8Array(memoryData);
    pendingChanges.forEach((value, offset) => {
      if (offset < result.length) {
        result[offset] = value;
      }
    });
    return result;
  }, [memoryData, pendingChanges]);

  // Computed: set of byte offsets that changed since last read (for red highlighting)
  const changedOffsets = useMemo(() => {
    const set = new Set<number>();
    const prev = prevMemoryDataRef.current;
    if (!prev || prev.baseAddress !== baseAddress || memoryData.length === 0) return set;
    const len = Math.min(prev.data.length, memoryData.length);
    for (let i = 0; i < len; i++) {
      if (prev.data[i] !== memoryData[i]) {
        set.add(i);
      }
    }
    return set;
  }, [memoryData, baseAddress]);

  // Update prev memory ref after render for change detection.
  // Only reacts to sessionId change (clear on session end) and actual new data
  // from the backend (tracked via reference identity). Deliberately does NOT
  // clear on sessionStatus changes so the baseline survives step transitions
  // (Running → Paused) and the post-step reload can highlight what changed.
  useEffect(() => {
    if (!sessionId) {
      prevMemoryDataRef.current = undefined;
      lastSeenMemoryDataRef.current = null;
      return;
    }
    if (memoryData.length === 0) return; // Cleared by session cleanup — keep prevRef

    const isNewData = memoryData !== lastSeenMemoryDataRef.current;
    lastSeenMemoryDataRef.current = memoryData;
    if (!isNewData) return; // Same stale reference after address change — skip

    if (!prevMemoryDataRef.current || prevMemoryDataRef.current.baseAddress === baseAddress) {
      // Same address (refresh/step) or first load — store as baseline
      prevMemoryDataRef.current = { data: new Uint8Array(memoryData), baseAddress };
    } else {
      // Different address — clear baseline (no comparison across addresses)
      prevMemoryDataRef.current = undefined;
    }
  }, [memoryData, baseAddress, sessionId]);

  return {
    // State
    baseAddress,
    memoryData: effectiveMemoryData,
    viewMode,
    bytesPerRow,
    isLoading,
    error,
    // Selection state
    selectionStart,
    selectionEnd,
    selectedOffsets,
    isDragging,
    // Editing state
    editingOffset,
    editingColumn,
    editBuffer,
    // Other state
    pendingChanges,
    littleEndian,
    // Change detection
    changedOffsets,
    // Dereference data
    dereferenceData,
    // Actions
    goToAddress,
    refresh,
    setViewMode,
    // Pagination
    loadPreviousPage,
    loadNextPage,
    // Pending changes actions
    applyPendingChanges,
    discardPendingChanges,
    // Selection actions
    setSelection,
    clearSelection,
    extendSelection,
    setIsDragging,
    // Editing actions
    startHexEdit,
    startAsciiEdit,
    handleKeyInput,
    commitEdit,
    cancelEdit,
    // Clipboard actions
    copySelection,
    pasteBytes,
  };
}
