import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError } from '@/lib/sessionHelpers';
import { LINK_VALUE_CLASS } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel } from '@/components/ui/panel';
import { Cpu, Loader2 } from 'lucide-react';
import { CallStackFrameList, CallStackFrame } from '@/components/CallStackFrameList';

interface ThreadSymbolInfo {
  tid: number;
  address: string;
  symbol_info: string | null;
  is_function: boolean;
}

interface ContextThreadsViewProps {
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemoryPointer?: (address: string) => void;
}

// Fixed row height (px) for the virtualized thread list. Rows are uniform (3 lines
// of truncated text: title/status, Start, TEB), so a fixed height avoids per-row
// getBoundingClientRect measurement.
const THREAD_ROW_HEIGHT = 68;

export const ContextThreadsView = ({ onNavigateToDisassembly, onNavigateToMemoryPointer }: ContextThreadsViewProps) => {
  const sessionData = useSessionContext();
  const sessionId = sessionData?.session?.id;
  const displayStatus = sessionData?.displayStatus;
  // Call stacks are available whenever a process is (paused, running, or the
  // non-invasive Open session), since they run over the OOB connection.
  const canUse = sessionData.canUseMemoryOps;

  // Context-level navigation (reuses existing memory tab, like symbols view)
  const onNavigateToDisassemblyCtx = sessionData.onNavigateToDisassembly;
  const onNavigateToMemoryCtx = sessionData.onNavigateToMemory;
  const onNavigateToTypeCtx = sessionData.onNavigateToType;

  // Hover popover state
  const [hoveredThreadId, setHoveredThreadId] = useState<number | null>(null);
  const hoveredThreadIdRef = useRef<number | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverHoveredRef = useRef(false);

  // Cached callstacks per thread
  const [threadCallStacks, setThreadCallStacks] = useState<Map<number, CallStackFrame[]>>(new Map());
  const threadCallStacksRef = useRef<Map<number, CallStackFrame[]>>(new Map());
  const loadingThreadIdRef = useRef<number | null>(null);
  const [loadingThreadId, setLoadingThreadId] = useState<number | null>(null);
  const [callstackError, setCallstackError] = useState<{ tid: number; message: string } | null>(null);

  // Thread symbol resolution
  const [threadSymbols, setThreadSymbols] = useState<Map<number, ThreadSymbolInfo>>(new Map());

  // Per-thread TEB base addresses (tid → hex), fetched over OOB when threads load.
  const [threadTebs, setThreadTebs] = useState<Map<number, string>>(new Map());
  // Tids already asked for (including those that yielded no TEB), so a thread-set
  // change with no new threads (e.g. a thread exit) doesn't refetch everything.
  const queriedTebTidsRef = useRef<Set<number>>(new Set());

  // Keep refs in sync with state
  const setLoadingThread = useCallback((tid: number | null) => {
    loadingThreadIdRef.current = tid;
    setLoadingThreadId(tid);
  }, []);

  const setHoveredThread = useCallback((tid: number | null) => {
    hoveredThreadIdRef.current = tid;
    setHoveredThreadId(tid);
  }, []);

  const setThreadCallStacksCb = useCallback((updater: (prev: Map<number, CallStackFrame[]>) => Map<number, CallStackFrame[]>) => {
    setThreadCallStacks(prev => {
      const next = updater(prev);
      threadCallStacksRef.current = next;
      return next;
    });
  }, []);

  // Load threads when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadThreads();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  // Request symbol resolution when threads change and session is paused. Also
  // re-request when symbolsRefreshKey flips: the backend resolves only
  // already-loaded modules (so it never blocks on a pending PDB parse), so once
  // a module's symbols finish loading we must ask again to upgrade raw
  // addresses to names.
  useEffect(() => {
    if (!sessionId || displayStatus !== 'Paused' || !sessionData?.threads?.length) return;
    invoke('request_resolve_thread_symbols', { sessionId }).catch((err) => {
      console.error('Failed to request thread symbol resolution:', err);
    });
  }, [sessionId, displayStatus, sessionData?.threads, sessionData?.symbolsRefreshKey]);

  // Fetch per-thread TEB addresses over OOB (works Paused/Running/Open). TEB bases
  // are stable for a thread's lifetime, so fetch only when an unseen tid appears.
  useEffect(() => {
    if (!sessionId || !canUse || !sessionData?.threads?.length) return;
    if (sessionData.threads.every((t) => queriedTebTidsRef.current.has(t.id))) return;
    let cancelled = false;
    invoke<Array<{ tid: number; teb: string | null }>>('get_session_thread_tebs', { sessionId })
      .then((entries) => {
        if (cancelled) return;
        for (const e of entries) queriedTebTidsRef.current.add(e.tid);
        setThreadTebs((prev) => {
          const map = new Map(prev);
          for (const e of entries) {
            if (e.teb) map.set(e.tid, e.teb);
          }
          return map;
        });
      })
      .catch((err) => {
        console.error('Failed to fetch thread TEB addresses:', err);
      });
    return () => { cancelled = true; };
  }, [sessionId, canUse, sessionData?.threads]);

  // Listen for thread symbol resolution results
  useEffect(() => {
    if (!sessionId) return;

    const unlisten = listen<{ session_id: string; symbols: ThreadSymbolInfo[] }>(
      'thread-symbols-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          const map = new Map<number, ThreadSymbolInfo>();
          for (const entry of event.payload.symbols) {
            map.set(entry.tid, entry);
          }
          setThreadSymbols(map);
        }
      }
    );

    return () => { unlisten.then(f => f()); };
  }, [sessionId]);

  // Listen for thread callstack events (no loadingThreadId in deps - use ref instead)
  useEffect(() => {
    if (!sessionId) return;

    const unlistenUpdated = listen<{ session_id: string; tid: number; frames: CallStackFrame[] }>(
      'thread-callstack-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setThreadCallStacksCb(prev => {
            const next = new Map(prev);
            next.set(event.payload.tid, event.payload.frames);
            return next;
          });
          if (loadingThreadIdRef.current === event.payload.tid) {
            setLoadingThread(null);
          }
          setCallstackError(prev => prev?.tid === event.payload.tid ? null : prev);
        }
      }
    );

    const unlistenError = listen<{ session_id: string; tid: number; error: string }>(
      'thread-callstack-error',
      (event) => {
        if (event.payload.session_id === sessionId) {
          if (loadingThreadIdRef.current === event.payload.tid) {
            setLoadingThread(null);
          }
          setCallstackError({ tid: event.payload.tid, message: event.payload.error });
        }
      }
    );

    return () => {
      unlistenUpdated.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionId, setLoadingThread, setThreadCallStacksCb]);

  // Session cleanup: clear all hover/cache state when the session ends or the
  // process becomes unavailable (Stopped/Error). Kept while paused/running/open.
  useEffect(() => {
    if (!sessionId || !canUse) {
      setHoveredThread(null);
      setPopoverPos(null);
      setThreadCallStacks(new Map());
      threadCallStacksRef.current = new Map();
      setLoadingThread(null);
      setCallstackError(null);
      setThreadSymbols(new Map());
      setThreadTebs(new Map());
      queriedTebTidsRef.current = new Set();
      popoverHoveredRef.current = false;
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [sessionId, canUse, setLoadingThread, setHoveredThread]);

  const clearHoverTimers = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const startHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!popoverHoveredRef.current) {
        setHoveredThread(null);
        setPopoverPos(null);
        setCallstackError(null);
      }
    }, 150);
  }, [setHoveredThread]);

  // Show the call-stack popover at (x, y) and fetch the thread's stack.
  // Always refetch: stacks change while the target runs (or across steps).
  // The cached frames stay visible until the fresh ones arrive.
  // `preview: true` marks a hover fetch — the Call Stack panel ignores those
  // and only follows explicit clicks, so hovering can't hijack it.
  const showThreadCallstack = useCallback((tid: number, x: number, y: number, preview: boolean) => {
    setHoveredThread(tid);
    setPopoverPos({ x: x + 16, y: y - 8 });
    setCallstackError(null);
    if (sessionId && canUse) {
      setLoadingThread(tid);
      invoke('request_thread_callstack', { sessionId, tid, preview }).catch((err) => {
        console.error('Failed to request thread callstack:', err);
        setLoadingThread(null);
        setCallstackError({ tid, message: formatTauriError(err) });
      });
    }
  }, [sessionId, canUse, setLoadingThread, setHoveredThread]);

  const handleThreadMouseEnter = useCallback((tid: number, e: React.MouseEvent) => {
    // Clear any pending hide
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    // If we're already showing this thread, do nothing
    if (hoveredThreadIdRef.current === tid) return;

    // Clear any pending hover timer for a different thread
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    // Capture mouse position directly - works reliably with fixed positioning
    // even when inside transformed ancestors (portal escapes them)
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    hoverTimerRef.current = setTimeout(() => {
      showThreadCallstack(tid, mouseX, mouseY, true);
    }, 400);
  }, [showThreadCallstack]);

  // Clicking a thread opens its call stack immediately (no hover delay).
  const handleThreadClick = useCallback((tid: number, e: React.MouseEvent) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    showThreadCallstack(tid, e.clientX, e.clientY, false);
  }, [showThreadCallstack]);

  const handleThreadMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    startHideTimer();
  }, [startHideTimer]);

  const handlePopoverMouseEnter = useCallback(() => {
    popoverHoveredRef.current = true;
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const handlePopoverMouseLeave = useCallback(() => {
    popoverHoveredRef.current = false;
    startHideTimer();
  }, [startHideTimer]);

  // Navigate to the thread start address - uses is_function to pick disasm vs memory
  const handleStartAddressClick = useCallback((address: string, isFunction: boolean) => {
    if (isFunction) {
      onNavigateToDisassemblyCtx?.(address);
    } else {
      onNavigateToMemoryCtx?.(address);
    }
  }, [onNavigateToDisassemblyCtx, onNavigateToMemoryCtx]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      clearHoverTimers();
    };
  }, [clearHoverTimers]);

  const getThreadStatusColor = (status: string) => {
    switch (status) {
      case "Suspended":
        return "bg-syn-state/15 text-syn-state border-syn-state/30";
      case "Terminated":
        return "bg-destructive/15 text-destructive border-destructive/30";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  const cachedFrames = hoveredThreadId !== null ? threadCallStacks.get(hoveredThreadId) : undefined;
  // Spinner only when there's nothing to show yet; a refetch of an already
  // cached stack keeps the previous frames visible until fresh ones arrive.
  const isLoadingPopover = hoveredThreadId !== null && loadingThreadId === hoveredThreadId && !cachedFrames;
  const popoverError = hoveredThreadId !== null && callstackError?.tid === hoveredThreadId ? callstackError.message : null;

  const threads = sessionData?.threads ?? [];

  return (
    <DockPanel>
      {threads.length > 0 ? (
        <VirtualizedList
          items={threads}
          rowHeight={THREAD_ROW_HEIGHT}
          overscan={15}
          className="flex-1 min-h-0"
          getItemKey={(_thread, index) => index}
          renderItem={(thread) => {
            const symInfo = threadSymbols.get(thread.id);
            const displayText = symInfo?.symbol_info ?? thread.start_address;
            const isFunction = symInfo?.is_function ?? true;
            const tebAddress = threadTebs.get(thread.id);

            return (
              <div
                className="flex items-center justify-between font-mono px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900 h-full cursor-pointer"
                onMouseEnter={(e) => handleThreadMouseEnter(thread.id, e)}
                onMouseLeave={handleThreadMouseLeave}
                onClick={(e) => handleThreadClick(thread.id, e)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-sm">Thread {thread.id}</h3>
                    <Badge
                      variant="outline"
                      size="xs"
                      className={getThreadStatusColor(thread.status)}
                    >
                      {thread.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                    <span className="shrink-0">Start:</span>
                    <TruncatedSymbol
                      text={displayText}
                      className={`font-mono ${LINK_VALUE_CLASS}`}
                      onClick={(e) => { e.stopPropagation(); handleStartAddressClick(thread.start_address, isFunction); }}
                    />
                  </p>
                  {tebAddress && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                      <span className="shrink-0">TEB:</span>
                      <TruncatedSymbol
                        text={tebAddress}
                        className={`font-mono ${LINK_VALUE_CLASS}`}
                        onClick={(e) => { e.stopPropagation(); onNavigateToTypeCtx?.('_TEB', tebAddress); }}
                      />
                    </p>
                  )}
                </div>
              </div>
            );
          }}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No threads found</p>
            <p className="text-sm mt-1">Open, attach to, or run a process to list threads</p>
          </div>
        </div>
      )}

      {/* Hover popover - portaled to body to escape rc-dock transforms */}
      {hoveredThreadId !== null && popoverPos && createPortal(
        <div
          className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-3 min-w-[320px] max-w-[480px] overflow-hidden"
          style={{ left: popoverPos.x, top: popoverPos.y }}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
        >
          <div className="text-sm font-medium mb-2">Thread {hoveredThreadId} Call Stack</div>
          {isLoadingPopover ? (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading call stack...</span>
            </div>
          ) : popoverError ? (
            <div className="text-sm text-destructive py-1">{popoverError}</div>
          ) : cachedFrames && cachedFrames.length > 0 ? (
            <CallStackFrameList
              frames={cachedFrames}
              onClickAddress={onNavigateToDisassembly}
              onClickMemory={onNavigateToMemoryPointer}
              compact
              maxHeight={250}
            />
          ) : cachedFrames ? (
            <div className="text-sm text-muted-foreground py-1">No frames</div>
          ) : null}
        </div>,
        document.body
      )}
    </DockPanel>
  );
};
