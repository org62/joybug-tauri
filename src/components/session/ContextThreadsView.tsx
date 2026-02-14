import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
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

export const ContextThreadsView = ({ onNavigateToDisassembly, onNavigateToMemoryPointer }: ContextThreadsViewProps) => {
  const sessionData = useSessionContext();
  const sessionId = sessionData?.session?.id;
  const displayStatus = sessionData?.displayStatus;

  // Context-level navigation (reuses existing memory tab, like symbols view)
  const onNavigateToDisassemblyCtx = sessionData.onNavigateToDisassembly;
  const onNavigateToMemoryCtx = sessionData.onNavigateToMemory;

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

  // Request symbol resolution when threads change and session is paused
  useEffect(() => {
    if (!sessionId || displayStatus !== 'Paused' || !sessionData?.threads?.length) return;
    invoke('request_resolve_thread_symbols', { sessionId }).catch((err) => {
      console.error('Failed to request thread symbol resolution:', err);
    });
  }, [sessionId, displayStatus, sessionData?.threads]);

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

  // Session cleanup: clear all hover/cache state when session ends or resumes
  useEffect(() => {
    if (!sessionId || displayStatus !== 'Paused') {
      setHoveredThread(null);
      setPopoverPos(null);
      setThreadCallStacks(new Map());
      threadCallStacksRef.current = new Map();
      setLoadingThread(null);
      setCallstackError(null);
      setThreadSymbols(new Map());
      popoverHoveredRef.current = false;
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [sessionId, displayStatus, setLoadingThread, setHoveredThread]);

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
      setHoveredThread(tid);
      setPopoverPos({ x: mouseX + 16, y: mouseY - 8 });
      setCallstackError(null);

      // Fetch callstack if not cached
      if (!threadCallStacksRef.current.has(tid) && sessionId && displayStatus === 'Paused') {
        setLoadingThread(tid);
        invoke('request_thread_callstack', { sessionId, tid }).catch((err) => {
          console.error('Failed to request thread callstack:', err);
          setLoadingThread(null);
          setCallstackError({ tid, message: String(err) });
        });
      }
    }, 400);
  }, [sessionId, displayStatus, setLoadingThread, setHoveredThread]);

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
      case "Running":
        return "bg-green-100 text-green-800 border-green-200";
      case "Suspended":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "Waiting":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "Terminated":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  const cachedFrames = hoveredThreadId !== null ? threadCallStacks.get(hoveredThreadId) : undefined;
  const isLoadingPopover = hoveredThreadId !== null && loadingThreadId === hoveredThreadId;
  const popoverError = hoveredThreadId !== null && callstackError?.tid === hoveredThreadId ? callstackError.message : null;

  return (
    <div className="h-full">
      <ScrollArea className="h-full">
        {sessionData?.threads && sessionData.threads.length > 0 ? (
          <div className="space-y-1">
            {sessionData.threads.map((thread, index) => {
              const symInfo = threadSymbols.get(thread.id);
              const displayText = symInfo?.symbol_info ?? thread.start_address;
              const isFunction = symInfo?.is_function ?? true;
              const clickColor = isFunction
                ? 'hover:text-blue-600 dark:hover:text-blue-400'
                : 'hover:text-green-600 dark:hover:text-green-400';

              return (
                <div
                  key={index}
                  className="flex items-center justify-between px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900"
                  onMouseEnter={(e) => handleThreadMouseEnter(thread.id, e)}
                  onMouseLeave={handleThreadMouseLeave}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium text-sm">Thread {thread.id}</h3>
                      <Badge
                        variant="outline"
                        className={`${getThreadStatusColor(thread.status)} border text-xs px-1 py-0`}
                      >
                        {thread.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      Start:{' '}
                      <button
                        className={`font-mono ${clickColor} hover:underline cursor-pointer`}
                        onClick={(e) => { e.stopPropagation(); handleStartAddressClick(thread.start_address, isFunction); }}
                      >
                        {displayText}
                      </button>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No threads found</p>
              <p className="text-sm mt-1">Threads will appear here during debugging</p>
            </div>
          </div>
        )}
      </ScrollArea>

      {/* Hover popover - portaled to body to escape rc-dock transforms */}
      {hoveredThreadId !== null && popoverPos && createPortal(
        <div
          className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-3 min-w-[320px] max-w-[480px]"
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
    </div>
  );
};
