import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError, isProcessAvailable } from '@/lib/sessionHelpers';
import { LINK_VALUE_CLASS } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useContextMenu } from '@/hooks/useContextMenu';
import { Cpu, Loader2, Pause, Play, Skull } from 'lucide-react';
import { toast } from 'sonner';
import { CallStackFrameList, CallStackFrame } from '@/components/CallStackFrameList';

interface ThreadSymbolInfo {
  tid: number;
  address: string;
  symbol_info: string | null;
  is_function: boolean;
}

interface ThreadActionResult {
  tid: number;
  error: string | null;
}

type ThreadActionCmd = 'suspend_threads' | 'resume_threads' | 'terminate_threads';

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
  // Raw status, not the debounced `displayStatus`: this gates a backend
  // precondition (`select_thread` is paused-only) and decides how to read a
  // fresh `current_event`. The debounce exists for rendering, not decisions.
  const isPaused = sessionData?.session?.status === 'Paused';
  // Event = the thread that raised the pause; active = the thread whose context
  // the views show, which is the event thread until the user switches away.
  // Only meaningful while paused.
  const currentEvent = sessionData?.session?.current_event;
  const eventTid = isPaused ? currentEvent?.thread_id ?? null : null;
  const activeTid = isPaused ? sessionData?.session?.selected_thread_id ?? eventTid : null;

  // Pulled out so callbacks depend on this stable function rather than on the
  // whole context object, whose identity changes on every session update.
  const loadThreads = sessionData.loadThreads;

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

  // Multi-selection (by tid) for the bulk suspend/resume/kill actions.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const lastToggledRef = useRef<number | null>(null);
  // Tids awaiting the Kill confirmation dialog.
  const [killPending, setKillPending] = useState<number[] | null>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ tid: number }>();

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
    // Only with a process. Guarded on the *raw* status, which is what triggers
    // this effect: `canUseMemoryOps` comes from the debounced status, updated by
    // a parent effect that runs after this one, so on the stop commit it would
    // still read true here and fire a load against the dead process.
    if (sessionData?.session?.id && isProcessAvailable(sessionData.session.status)) {
      loadThreads();
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
      setSelected(new Set());
      setKillPending(null);
      closeContextMenu();
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
  }, [sessionId, canUse, setLoadingThread, setHoveredThread, closeContextMenu]);

  // ---- Selection ----
  const toggleSelect = useCallback((tid: number, shift: boolean) => {
    const ids = (sessionData?.threads ?? []).map((t) => t.id);
    setSelected((prev) => {
      const next = new Set(prev);
      const anchor = lastToggledRef.current;
      if (shift && anchor !== null && ids.includes(anchor) && ids.includes(tid)) {
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(tid)].sort((x, y) => x - y);
        for (const id of ids.slice(a, b + 1)) next.add(id);
      } else if (next.has(tid)) {
        next.delete(tid);
      } else {
        next.add(tid);
      }
      return next;
    });
    lastToggledRef.current = tid;
  }, [sessionData?.threads]);

  const selectAll = useCallback(() => {
    setSelected(new Set((sessionData?.threads ?? []).map((t) => t.id)));
  }, [sessionData?.threads]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ---- Thread control ----
  // Per-tid results: one dead thread must not hide the outcome for the rest.
  const runThreadAction = useCallback(async (cmd: ThreadActionCmd, tids: number[]) => {
    if (!sessionId || tids.length === 0) return;
    try {
      const results = await invoke<ThreadActionResult[]>(cmd, { sessionId, tids });
      for (const r of results) {
        if (r.error) toast.error(`Thread ${r.tid}: ${r.error}`);
      }
    } catch (err) {
      toast.error(`Thread action failed: ${formatTauriError(err)}`);
    }
    loadThreads();
  }, [sessionId, loadThreads]);

  // Switching the context thread is paused-only; the backend resets the
  // selection on the next pause.
  const switchToThread = useCallback((tid: number) => {
    if (!sessionId) return;
    invoke('select_thread', { sessionId, tid }).catch((err) => {
      toast.error(`Failed to switch thread: ${formatTauriError(err)}`);
    });
  }, [sessionId]);

  const requestKill = useCallback((tids: number[]) => {
    if (tids.length > 0) setKillPending(tids);
  }, []);

  const confirmKill = useCallback(() => {
    const tids = killPending ?? [];
    setKillPending(null);
    void runThreadAction('terminate_threads', tids);
  }, [killPending, runThreadAction]);

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

  // Clicking a thread opens its call stack immediately (no hover delay) and,
  // while paused, switches the context thread (registers, disassembly IP,
  // call stack follow it until the next pause). Stepping stays on the event
  // thread. In Open/Running sessions there is no context to switch, so the
  // click only redirects the Call Stack panel.
  const handleThreadClick = useCallback((tid: number, e: React.MouseEvent) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    if (isPaused) switchToThread(tid);
    showThreadCallstack(tid, e.clientX, e.clientY, false);
  }, [isPaused, switchToThread, showThreadCallstack]);

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

  const cachedFrames = hoveredThreadId !== null ? threadCallStacks.get(hoveredThreadId) : undefined;
  // Spinner only when there's nothing to show yet; a refetch of an already
  // cached stack keeps the previous frames visible until fresh ones arrive.
  const isLoadingPopover = hoveredThreadId !== null && loadingThreadId === hoveredThreadId && !cachedFrames;
  const popoverError = hoveredThreadId !== null && callstackError?.tid === hoveredThreadId ? callstackError.message : null;

  const threads = sessionData?.threads ?? [];
  // Intersected with the live list rather than pruned by an effect: a tid left
  // in `selected` after its thread exits is simply never counted or acted on.
  const selectedTids = threads.filter((t) => selected.has(t.id)).map((t) => t.id);
  const actionsDisabled = !canUse || selectedTids.length === 0;
  const allSelected = threads.length > 0 && selectedTids.length === threads.length;
  // Context-menu target: the selection when the clicked row is part of it,
  // otherwise just that row (file-manager convention).
  const targetsFor = (tid: number): number[] => (selected.has(tid) ? selectedTids : [tid]);

  return (
    <DockPanel>
      {threads.length > 0 && (
        <PanelToolbar className="flex items-center gap-1 text-xs">
          {/* The panel is narrow by default: the all/none toggle is a single
              checkbox and the actions are icon-only, so the bar never overflows. */}
          <Checkbox
            className="mx-1"
            data-testid="thread-select-all"
            title={allSelected ? 'Clear selection' : 'Select all threads'}
            checked={allSelected ? true : selectedTids.length > 0 ? 'indeterminate' : false}
            onCheckedChange={allSelected ? clearSelection : selectAll}
          />
          <span className="text-muted-foreground flex-1 min-w-0 truncate" data-testid="thread-selection-count">
            {selectedTids.length > 0 ? `${selectedTids.length} selected` : `${threads.length} threads`}
          </span>
          <Button
            size="icon-xs"
            variant="outline"
            title="Suspend selected threads"
            disabled={actionsDisabled}
            onClick={() => runThreadAction('suspend_threads', selectedTids)}
            data-testid="thread-action-suspend"
          >
            <Pause />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            title="Resume selected threads"
            disabled={actionsDisabled}
            onClick={() => runThreadAction('resume_threads', selectedTids)}
            data-testid="thread-action-resume"
          >
            <Play />
          </Button>
          <Button
            size="icon-xs"
            variant="destructive"
            title="Terminate selected threads"
            disabled={actionsDisabled}
            onClick={() => requestKill(selectedTids)}
            data-testid="thread-action-kill"
          >
            <Skull />
          </Button>
        </PanelToolbar>
      )}
      {threads.length > 0 ? (
        <VirtualizedList
          items={threads}
          rowHeight={THREAD_ROW_HEIGHT}
          overscan={15}
          className="flex-1 min-h-0"
          getItemKey={(thread) => thread.id}
          renderItem={(thread) => {
            const symInfo = threadSymbols.get(thread.id);
            const displayText = symInfo?.symbol_info ?? thread.start_address;
            const isFunction = symInfo?.is_function ?? true;
            const tebAddress = threadTebs.get(thread.id);
            const isActive = thread.id === activeTid;
            // Marked only when the user switched away from it.
            const isEventThread = thread.id === eventTid && eventTid !== activeTid;
            const isSelected = selected.has(thread.id);
            // Suspend nesting is shown only when it actually nests.
            const status = thread.suspend_count > 0 ? 'Suspended' : 'Running';
            const statusLabel = thread.suspend_count > 1 ? `${status} (${thread.suspend_count})` : status;

            return (
              <div
                data-testid="thread-row"
                data-tid={thread.id}
                data-active={isActive ? 'true' : undefined}
                data-status={status}
                data-selected={isSelected ? 'true' : undefined}
                onContextMenu={(e) => openContextMenu(e, { tid: thread.id })}
                className={`flex items-center justify-between font-mono px-2 py-1 border-b h-full cursor-pointer border-l-2 ${
                  isActive
                    ? 'border-l-primary bg-accent/60'
                    : 'border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-900'
                }`}
                onMouseEnter={(e) => handleThreadMouseEnter(thread.id, e)}
                onMouseLeave={handleThreadMouseLeave}
                onClick={(e) => handleThreadClick(thread.id, e)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Checkbox
                      data-testid="thread-checkbox"
                      checked={isSelected}
                      onClick={(e) => { e.stopPropagation(); toggleSelect(thread.id, e.shiftKey); }}
                    />
                    <h3 className="font-medium text-sm whitespace-nowrap">Thread {thread.id}</h3>
                    {isActive && (
                      <Badge variant="outline" size="xs" className="bg-primary/15 text-primary border-primary/30">
                        current
                      </Badge>
                    )}
                    {isEventThread && (
                      <Badge variant="outline" size="xs" className="bg-muted text-muted-foreground border-border">
                        event
                      </Badge>
                    )}
                    {thread.suspend_count > 0 && (
                      <Badge
                        variant="outline"
                        size="xs"
                        className="whitespace-nowrap bg-syn-state/15 text-syn-state border-syn-state/30"
                      >
                        {statusLabel}
                      </Badge>
                    )}
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

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
          {isPaused && (
            <>
              <ContextMenuItem onClick={() => switchToThread(contextMenu.data.tid)}>
                Switch to thread
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            icon={<Pause />}
            disabled={!canUse}
            onClick={() => runThreadAction('suspend_threads', targetsFor(contextMenu.data.tid))}
          >
            Suspend
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Play />}
            disabled={!canUse}
            onClick={() => runThreadAction('resume_threads', targetsFor(contextMenu.data.tid))}
          >
            Resume
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Skull />}
            destructive
            disabled={!canUse}
            onClick={() => requestKill(targetsFor(contextMenu.data.tid))}
          >
            Kill
          </ContextMenuItem>
        </ContextMenu>
      )}

      <Dialog open={killPending !== null} onOpenChange={(o) => !o && setKillPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Terminate {killPending?.length === 1 ? `thread ${killPending[0]}` : `${killPending?.length ?? 0} threads`}?
            </DialogTitle>
            <DialogDescription>
              TerminateThread ends the thread immediately without unwinding: locks it holds stay
              held and its stack is never freed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillPending(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmKill} data-testid="thread-kill-confirm">Terminate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
