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
} from '@/lib/hexUtils';

// Persistent state store per session (survives component unmount)
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
  selectedOffset: number | null;
  editingOffset: number | null;
  pendingChanges: Map<number, number>;
  littleEndian: boolean;
}

export interface HexEditorActions {
  goToAddress: (address: string | bigint) => Promise<void>;
  refresh: () => void;
  setViewMode: (mode: ViewMode) => void;
  startEdit: (offset: number) => void;
  commitEdit: (value: string) => void;
  cancelEdit: () => void;
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
  setSelectedOffset: (offset: number | null) => void;
}

export interface UseHexEditorOptions {
  sessionId: string | undefined;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

export function useHexEditor(options: UseHexEditorOptions): HexEditorState & HexEditorActions {
  const { sessionId, memoryViewId = 'memory', sessionStatus, registers = {}, resolveSymbol } = options;

  // Create a unique persistence key combining session and view ID
  const persistenceKey = sessionId ? `${sessionId}-${memoryViewId}` : undefined;

  // Get persisted state for this view
  const persistedState = persistenceKey ? sessionStateStore.get(persistenceKey) : undefined;

  const [baseAddress, setBaseAddressState] = useState<bigint>(persistedState?.baseAddress ?? 0n);
  const [memoryData, setMemoryData] = useState<Uint8Array>(new Uint8Array(0));
  const [viewMode, setViewModeInternal] = useState<ViewMode>(persistedState?.viewMode ?? 'byte');
  const [bytesPerRow] = useState<number>(BYTES_PER_ROW);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [editingOffset, setEditingOffset] = useState<number | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<number, number>>(new Map());
  const littleEndian = true; // Always little-endian as per requirements
  const initialLoadDone = useRef(false);
  const pendingReadAddress = useRef<bigint | null>(null);

  // Wrapper to persist baseAddress changes
  const setBaseAddress = useCallback((address: bigint) => {
    setBaseAddressState(address);
    if (persistenceKey) {
      const existing = sessionStateStore.get(persistenceKey) || { baseAddress: 0n, viewMode: 'byte' as ViewMode };
      sessionStateStore.set(persistenceKey, { ...existing, baseAddress: address });
    }
  }, [persistenceKey]);

  // Wrapper to persist viewMode changes
  const setViewModeState = useCallback((mode: ViewMode) => {
    setViewModeInternal(mode);
    if (persistenceKey) {
      const existing = sessionStateStore.get(persistenceKey) || { baseAddress: 0n, viewMode: 'byte' as ViewMode };
      sessionStateStore.set(persistenceKey, { ...existing, viewMode: mode });
    }
  }, [persistenceKey]);

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
    setSelectedOffset(null);
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
    setViewModeState(mode);
  }, []);

  // Start editing at offset
  const startEdit = useCallback((offset: number) => {
    setEditingOffset(offset);
    setSelectedOffset(offset);
  }, []);

  // Commit edit with new value
  const commitEdit = useCallback((value: string) => {
    if (editingOffset === null) return;

    const config = VIEW_MODE_CONFIGS[viewMode];
    const parsed = config.parseValue(value);

    if (parsed === null) {
      toastError('Invalid value format', sessionId);
      return;
    }

    // Add to pending changes
    const newPendingChanges = new Map(pendingChanges);
    for (let i = 0; i < parsed.length; i++) {
      newPendingChanges.set(editingOffset + i, parsed[i]);
    }
    setPendingChanges(newPendingChanges);
    setEditingOffset(null);
  }, [editingOffset, viewMode, pendingChanges]);

  // Cancel edit
  const cancelEdit = useCallback(() => {
    setEditingOffset(null);
  }, []);

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
        // Only accept errors for this view's pending request
        if (event.payload.session_id === sessionId &&
            pendingReadAddress.current !== null &&
            BigInt(event.payload.address) === pendingReadAddress.current) {
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

      return () => {
        unlistenRead();
        unlistenReadError();
        unlistenWrite();
        unlistenWriteError();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn?.());
    };
  }, [sessionId]);

  // Restore persisted state on mount
  useEffect(() => {
    if (!persistenceKey || initialLoadDone.current) return;

    const persisted = sessionStateStore.get(persistenceKey);
    if (persisted && persisted.baseAddress !== 0n) {
      initialLoadDone.current = true;
      loadMemory(persisted.baseAddress);
    }
  }, [persistenceKey, loadMemory]);

  // Reset error and data when session stops or restarts
  useEffect(() => {
    if (sessionStatus === 'Stopped') {
      setError(null);
      setMemoryData(new Uint8Array(0));
      initialLoadDone.current = false;
    }
  }, [sessionStatus]);

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

  return {
    baseAddress,
    memoryData: effectiveMemoryData,
    viewMode,
    bytesPerRow,
    isLoading,
    error,
    selectedOffset,
    editingOffset,
    pendingChanges,
    littleEndian,
    goToAddress,
    refresh,
    setViewMode,
    startEdit,
    commitEdit,
    cancelEdit,
    applyPendingChanges,
    discardPendingChanges,
    setSelectedOffset,
  };
}
