import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext, type Thread } from '@/contexts/SessionContext';
import { formatTauriError, isPausedSession, isProcessAvailable, reportSessionError } from '@/lib/sessionHelpers';
import { LINK_VALUE_CLASS } from '@/lib/utils';
import {
  formatThreadCreationTime, formatThreadCycles, formatThreadLastError, formatThreadPriority,
  formatThreadTime, formatThreadWaitReason, matchesThreadFilter, UNAVAILABLE_THREAD_VALUE,
} from '@/lib/threadDetails';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { EmptyState, ProcessUnavailableState, STATE_ICON_CLASS } from '@/components/ui/empty-state';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useContextMenu } from '@/hooks/useContextMenu';
import { usePlatform } from '@/hooks/usePlatform';
import { ChevronDown, ChevronRight, Cpu, Loader2, Pause, Play, Square, X } from 'lucide-react';
import { CallStackFrameList, type CallStackFrame } from '@/components/CallStackFrameList';

interface ThreadSymbolInfo {
  tid: number;
  address: string;
  symbol_info: string | null;
  is_function: boolean;
}
interface ThreadActionResult { tid: number; error: string | null }
type ThreadActionCmd = 'suspend_threads' | 'resume_threads' | 'terminate_threads';
interface ContextThreadsViewProps {
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemoryPointer?: (address: string) => void;
}
interface ThreadIdentity { key: string; creation: string | null }
interface ThreadRow { thread: Thread; key: string; ordinal: number }
const THREAD_ROW_HEIGHT = 68;

// A real process change (including loss) remounts every process-owned cache and
// the measured viewport. Pause/resume and metadata snapshots do not.
export function ContextThreadsView(props: ContextThreadsViewProps) {
  const context = useSessionContext();
  const available = context.canUseMemoryOps && !!context.session && isProcessAvailable(context.session.status);
  const scope = `${context.session?.id ?? ''}:${available ? context.processId ?? 'pending' : 'none'}`;
  return <ScopedThreadsView key={scope} {...props} available={available} />;
}

function ScopedThreadsView({ onNavigateToDisassembly, onNavigateToMemoryPointer, available }: ContextThreadsViewProps & { available: boolean }) {
  const sessionData = useSessionContext();
  const isWindows = usePlatform().os === 'windows';
  const sessionId = sessionData.session?.id;
  // Context roles must follow raw capability, not debounced display status.
  const isPaused = isPausedSession(sessionData.session?.status);
  const eventTid = isPaused ? sessionData.session?.current_event?.thread_id ?? null : null;
  const activeTid = isPaused ? sessionData.session?.selected_thread_id ?? eventTid : null;
  const mainTid = sessionData.session?.main_thread_id ?? null;
  const processId = sessionData.processId;
  const processIdRef = useRef(processId);
  processIdRef.current = processId;
  const architecture = sessionData.session?.arch;
  const loadThreads = sessionData.loadThreads;
  const aliveRef = useRef(true);
  const identitiesRef = useRef(new Map<number, ThreadIdentity>());
  const nextIdentityRef = useRef(0);
  const rows = useMemo(() => {
    const threads = available ? sessionData.threads : [];
    const live = new Set(threads.map(thread => thread.id));
    for (const tid of identitiesRef.current.keys()) {
      if (!live.has(tid)) identitiesRef.current.delete(tid);
    }
    return threads.map((thread, index): ThreadRow => {
      let identity = identitiesRef.current.get(thread.id);
      const creation = thread.creation_time_filetime_100ns;
      if (!identity || (identity.creation !== null && creation !== null && identity.creation !== creation)) {
        identity = { key: `${thread.id}:${++nextIdentityRef.current}`, creation };
        identitiesRef.current.set(thread.id, identity);
      } else if (creation !== null) {
        identity.creation = creation;
      }
      return { thread, key: identity.key, ordinal: index + 1 };
    });
  }, [available, sessionData.threads]);
  const liveRowsRef = useRef(rows);
  liveRowsRef.current = rows;
  const liveKeys = rows.map(row => row.key).join('|');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const anchorRef = useRef<string | null>(null);
  const [killPending, setKillPending] = useState<string[] | null>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<{ key: string; tid: number }>();
  const [threadSymbols, setThreadSymbols] = useState(new Map<string, ThreadSymbolInfo>());
  const [symbolListenerReady, setSymbolListenerReady] = useState(false);
  const stackListenersReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const [stacks, setStacks] = useState(new Map<string, CallStackFrame[]>());
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredKeyRef = useRef<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [stackError, setStackError] = useState<{ key: string; message: string } | null>(null);
  const pendingStacksRef = useRef(new Map<string, { key: string; tid: number }>());
  const latestStackRequestRef = useRef(new Map<string, string>());
  const symbolRequestRef = useRef<{ id: string; identities: Map<number, string> } | null>(null);
  const nextRequestRef = useRef(0);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const popoverHoveredRef = useRef(false);
  const detailsPrefix = useId();

  const clearHoverTimers = useCallback(() => {
    window.clearTimeout(hoverTimerRef.current);
    window.clearTimeout(hideTimerRef.current);
    hoverTimerRef.current = undefined;
    hideTimerRef.current = undefined;
  }, []);
  const dismissPopover = useCallback(() => {
    clearHoverTimers();
    popoverHoveredRef.current = false;
    hoveredKeyRef.current = null;
    setHoveredKey(null);
    setPopoverPos(null);
    setStackError(null);
  }, [clearHoverTimers]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; clearHoverTimers(); };
  }, [clearHoverTimers]);

  useEffect(() => {
    if (available && sessionId) void loadThreads();
  }, [available, sessionId, sessionData.session?.status, sessionData.session?.current_event, loadThreads]);

  // Only identity, Entry, symbol readiness and paused capability affect symbol
  // work. Names and cumulative counters refresh without another resolve IPC.
  const symbolInputs = rows.map(({ key, thread }) => `${key}:${thread.start_address ?? ''}`).join('|');
  useEffect(() => {
    if (!available || !sessionId || !isPaused || !symbolInputs || !symbolListenerReady) return;
    const threads = liveRowsRef.current.flatMap(row => row.thread.start_address ? [[row.thread.id, row.thread.start_address]] : []);
    if (!threads.length) return;
    const requestId = `${detailsPrefix}:symbols:${++nextRequestRef.current}`;
    symbolRequestRef.current = { id: requestId, identities: new Map(liveRowsRef.current.map(row => [row.thread.id, row.key])) };
    invoke('request_resolve_thread_symbols', { sessionId, threads, requestId }).catch(error => {
      if (aliveRef.current && symbolRequestRef.current?.id === requestId) reportSessionError('resolve thread symbols', error, sessionId);
    });
    return () => { if (symbolRequestRef.current?.id === requestId) symbolRequestRef.current = null; };
  }, [available, sessionId, isPaused, symbolInputs, sessionData.symbolsRefreshKey, detailsPrefix, symbolListenerReady]);

  useEffect(() => {
    if (!available || !sessionId) return;
    let cancelled = false;
    const unlisten = listen<{ session_id: string; process_id: number; request_id: string; symbols: ThreadSymbolInfo[] }>('thread-symbols-updated', event => {
      if (cancelled || !aliveRef.current || event.payload.session_id !== sessionId || event.payload.process_id !== processIdRef.current) return;
      const request = symbolRequestRef.current;
      if (!request || request.id !== event.payload.request_id) return;
      const map = new Map<string, ThreadSymbolInfo>();
      const rowsByTid = new Map(liveRowsRef.current.map(row => [row.thread.id, row]));
      for (const entry of event.payload.symbols) {
        const row = rowsByTid.get(entry.tid);
        if (row && request.identities.get(entry.tid) === row.key && row.thread.start_address?.toLowerCase() === entry.address.toLowerCase()) map.set(row.key, entry);
      }
      setThreadSymbols(map);
    });
    void unlisten.then(() => { if (!cancelled) setSymbolListenerReady(true); });
    return () => { cancelled = true; void unlisten.then(stop => stop()); };
  }, [available, sessionId, processId]);

  useEffect(() => {
    if (!available || !sessionId) return;
    let cancelled = false;
    const keyFor = (tid: number, requestId: string) => {
      const pending = pendingStacksRef.current.get(requestId);
      pendingStacksRef.current.delete(requestId);
      return pending && pending.tid === tid && latestStackRequestRef.current.get(pending.key) === requestId
        && liveRowsRef.current.some(row => row.key === pending.key && row.thread.id === tid) ? pending.key : null;
    };
    const updated = listen<{ session_id: string; process_id: number; request_id: string; tid: number; frames: CallStackFrame[] }>('thread-callstack-updated', event => {
      if (cancelled || !aliveRef.current || event.payload.session_id !== sessionId || event.payload.process_id !== processIdRef.current) return;
      const key = keyFor(event.payload.tid, event.payload.request_id);
      if (!key) return;
      setStacks(previous => new Map(previous).set(key, event.payload.frames));
      setLoadingKey(previous => previous === key ? null : previous);
      setStackError(previous => previous?.key === key ? null : previous);
    });
    const failed = listen<{ session_id: string; process_id: number; request_id: string; tid: number; error: string }>('thread-callstack-error', event => {
      if (cancelled || !aliveRef.current || event.payload.session_id !== sessionId || event.payload.process_id !== processIdRef.current) return;
      const key = keyFor(event.payload.tid, event.payload.request_id);
      if (!key) return;
      setLoadingKey(previous => previous === key ? null : previous);
      setStackError({ key, message: event.payload.error });
    });
    stackListenersReadyRef.current = Promise.all([updated, failed]);
    return () => { cancelled = true; void updated.then(stop => stop()); void failed.then(stop => stop()); };
  }, [available, sessionId, processId]);

  useEffect(() => {
    const live = new Set(liveRowsRef.current.map(row => row.key));
    setSelected(previous => new Set([...previous].filter(key => live.has(key))));
    setExpanded(previous => new Set([...previous].filter(key => live.has(key))));
    setThreadSymbols(previous => new Map([...previous].filter(([key]) => live.has(key))));
    setStacks(previous => new Map([...previous].filter(([key]) => live.has(key))));
    for (const [requestId, pending] of pendingStacksRef.current) if (!live.has(pending.key)) pendingStacksRef.current.delete(requestId);
    for (const key of latestStackRequestRef.current.keys()) if (!live.has(key)) latestStackRequestRef.current.delete(key);
    if (anchorRef.current && !live.has(anchorRef.current)) anchorRef.current = null;
    if (hoveredKeyRef.current && !live.has(hoveredKeyRef.current)) dismissPopover();
    setLoadingKey(previous => previous && live.has(previous) ? previous : null);
    setKillPending(previous => {
      const pending = previous?.filter(key => live.has(key));
      return pending?.length ? pending : null;
    });
    closeContextMenu();
  }, [liveKeys, closeContextMenu, dismissPopover]);

  const symbolFor = (row: ThreadRow) => {
    const symbol = threadSymbols.get(row.key);
    return symbol?.address.toLowerCase() === row.thread.start_address?.toLowerCase() ? symbol : undefined;
  };
  const visibleRows = rows.filter(row => matchesThreadFilter(row.thread, query, symbolFor(row)?.symbol_info ?? null, {
    main: row.thread.id === mainTid, current: row.thread.id === activeTid, event: row.thread.id === eventTid,
  }));
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const visibleKeys = new Set(visibleRows.map(row => row.key));
  const selectedRows = visibleRows.filter(row => selected.has(row.key));
  const hiddenSelected = rows.filter(row => selected.has(row.key) && !visibleKeys.has(row.key)).length;
  const allSelected = visibleRows.length > 0 && selectedRows.length === visibleRows.length;
  const actionsDisabled = !available || selectedRows.length === 0;
  const visibleIdentities = visibleRows.map(row => row.key).join('|');
  useEffect(() => {
    if (anchorRef.current && !visibleRowsRef.current.some(row => row.key === anchorRef.current)) anchorRef.current = null;
  }, [visibleIdentities]);

  useEffect(() => {
    dismissPopover();
    closeContextMenu();
    setKillPending(null);
  }, [query, dismissPopover, closeContextMenu]);

  const toggleSelect = (key: string, shift: boolean) => {
    const keys = visibleRows.map(row => row.key);
    const anchor = anchorRef.current;
    setSelected(previous => {
      const next = new Set(previous);
      if (shift && anchor !== null && keys.includes(anchor)) {
        const [a, b] = [keys.indexOf(anchor), keys.indexOf(key)].sort((x, y) => x - y);
        for (const item of keys.slice(a, b + 1)) next.add(item);
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchorRef.current = key;
  };
  const toggleSelectAll = () => setSelected(previous => {
    const next = new Set(previous);
    for (const row of visibleRows) {
      if (allSelected) next.delete(row.key);
      else next.add(row.key);
    }
    return next;
  });
  const targetsFor = (key: string) => selected.has(key) ? selectedRows.map(row => row.key) : visibleKeys.has(key) ? [key] : [];

  const runThreadAction = useCallback(async (command: ThreadActionCmd, keys: string[]) => {
    if (!sessionId || !available) return;
    // Revalidate at execution, especially after a confirmation was left open.
    const tids = visibleRowsRef.current.filter(row => keys.includes(row.key)).map(row => row.thread.id);
    if (!tids.length) return;
    try {
      const results = await invoke<ThreadActionResult[]>(command, { sessionId, tids });
      if (!aliveRef.current) return;
      for (const result of results) if (result.error) reportSessionError(`control thread ${result.tid}`, result.error, sessionId);
    } catch (error) {
      if (aliveRef.current) reportSessionError('control threads', error, sessionId);
    }
    if (aliveRef.current) void loadThreads();
  }, [sessionId, available, loadThreads]);
  const switchToThread = (key: string) => {
    const row = visibleRowsRef.current.find(row => row.key === key);
    if (!sessionId || !available || !isPaused || !row) return;
    invoke('select_thread', { sessionId, tid: row.thread.id }).catch(error => {
      if (aliveRef.current) reportSessionError('switch thread', error, sessionId);
    });
  };
  const requestKill = (keys: string[]) => { if (keys.length) setKillPending(keys); };
  const confirmKill = () => {
    const keys = killPending ?? [];
    setKillPending(null);
    void runThreadAction('terminate_threads', keys);
  };

  const startHideTimer = () => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => { if (!popoverHoveredRef.current) dismissPopover(); }, 150);
  };
  const showStack = (row: ThreadRow, x: number, y: number, preview: boolean) => {
    if (!sessionId || !available || !liveRowsRef.current.some(item => item.key === row.key)) return;
    hoveredKeyRef.current = row.key;
    setHoveredKey(row.key);
    setPopoverPos({ x: x + 16, y: y - 8 });
    setStackError(null);
    setLoadingKey(row.key);
    const requestId = `${detailsPrefix}:stack:${++nextRequestRef.current}`;
    const previousRequest = latestStackRequestRef.current.get(row.key);
    if (previousRequest) pendingStacksRef.current.delete(previousRequest);
    latestStackRequestRef.current.set(row.key, requestId);
    pendingStacksRef.current.set(requestId, { key: row.key, tid: row.thread.id });
    void stackListenersReadyRef.current.then(() => {
      if (!aliveRef.current || latestStackRequestRef.current.get(row.key) !== requestId
        || !liveRowsRef.current.some(item => item.key === row.key)) return;
      return invoke('request_thread_callstack', { sessionId, tid: row.thread.id, preview, requestId });
    }).catch(error => {
      if (!aliveRef.current || latestStackRequestRef.current.get(row.key) !== requestId || !pendingStacksRef.current.delete(requestId)) return;
      setLoadingKey(previous => previous === row.key ? null : previous);
      setStackError({ key: row.key, message: formatTauriError(error) });
    });
  };
  const enterSummary = (row: ThreadRow, event: React.MouseEvent) => {
    clearHoverTimers();
    if (hoveredKeyRef.current === row.key) return;
    const { clientX, clientY } = event;
    hoverTimerRef.current = window.setTimeout(() => showStack(row, clientX, clientY, true), 400);
  };
  const leaveSummary = () => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = undefined;
    startHideTimer();
  };
  const clickSummary = (row: ThreadRow, event: React.MouseEvent) => {
    clearHoverTimers();
    if (isPaused) switchToThread(row.key);
    showStack(row, event.clientX, event.clientY, false);
  };
  const navigateEntry = (address: string, isFunction: boolean) => {
    if (isFunction) sessionData.onNavigateToDisassembly?.(address);
    else sessionData.onNavigateToMemory?.(address);
  };
  const navigateTeb = (thread: Thread) => {
    if (!thread.teb_address) return;
    if (thread.teb_architecture && thread.teb_architecture === architecture) sessionData.onNavigateToType?.('_TEB', thread.teb_address);
    else sessionData.onNavigateToMemory?.(thread.teb_address);
  };
  const navigateIp = (thread: Thread, address: string) => {
    if (thread.instruction_pointer_architecture && thread.instruction_pointer_architecture === architecture) sessionData.onNavigateToDisassembly?.(address);
    else sessionData.onNavigateToMemory?.(address);
  };
  const addressLink = (address: string | null, navigate: () => void, title?: string) => address === null
    ? UNAVAILABLE_THREAD_VALUE
    : <span className={LINK_VALUE_CLASS} title={title} onContextMenu={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); navigate(); }}>{address}</span>;
  const hoveredRow = rows.find(row => row.key === hoveredKey);
  const cachedFrames = hoveredKey ? stacks.get(hoveredKey) : undefined;
  const popoverError = stackError?.key === hoveredKey ? stackError.message : null;

  return (
    <DockPanel>
      {available && <PanelToolbar stack>
        <div className="flex items-center gap-1 w-full min-w-0">
          <Input inputSize="xs" aria-label="Filter threads" placeholder="Filter threads" value={query}
            onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1" />
          <Button size="icon-xs" variant="ghost" aria-label="Clear thread filter" disabled={!query} onClick={() => setQuery('')}><X /></Button>
        </div>
        <div className="flex items-center gap-1 flex-wrap w-full text-xs">
          <Checkbox className="mx-1" data-testid="thread-select-all" aria-label="Select all visible threads"
            title={allSelected ? 'Clear visible selection' : 'Select all visible threads'}
            checked={allSelected ? true : selectedRows.length > 0 ? 'indeterminate' : false} onCheckedChange={toggleSelectAll} />
          <span className="text-muted-foreground flex-1 min-w-0" data-testid="thread-selection-count">
            {selectedRows.length ? `${selectedRows.length} selected` : `${visibleRows.length} threads`}
          </span>
          {hiddenSelected > 0 && <span className="text-muted-foreground" data-testid="thread-hidden-selection-count">{hiddenSelected} hidden selected</span>}
          <Button size="icon-xs" variant="outline" title="Suspend selected threads" disabled={actionsDisabled}
            onClick={() => void runThreadAction('suspend_threads', selectedRows.map(row => row.key))} data-testid="thread-action-suspend"><Pause /></Button>
          <Button size="icon-xs" variant="outline" title="Resume selected threads" disabled={actionsDisabled}
            onClick={() => void runThreadAction('resume_threads', selectedRows.map(row => row.key))} data-testid="thread-action-resume"><Play /></Button>
          <Button size="icon-xs" variant="outline" title="Terminate selected threads" disabled={actionsDisabled}
            onClick={() => requestKill(selectedRows.map(row => row.key))} data-testid="thread-action-kill"><Square /></Button>
        </div>
      </PanelToolbar>}
      {available ? <div className="relative flex-1 min-h-0">
        <VirtualizedList items={visibleRows} rowHeight={THREAD_ROW_HEIGHT} measureRows overscan={15}
          className="h-full" getItemKey={row => row.key}
          renderItem={row => {
            const { thread, key, ordinal } = row;
            const symbol = symbolFor(row);
            const roles = { main: thread.id === mainTid, current: thread.id === activeTid, event: thread.id === eventTid };
            const isSelected = selected.has(key);
            const isExpanded = expanded.has(key);
            const count = thread.suspend_count;
            const status = count === null ? 'Unknown' : count > 0 ? 'Suspended' : 'Running';
            const ip = thread.instruction_pointer;
            const detailsId = `${detailsPrefix}-${key.replace(':', '-')}`;
            const entry = thread.start_address;
            const details: Array<[string, React.ReactNode]> = isExpanded ? [
              ['Number / role', `#${ordinal}${roles.main ? ' · main' : ''}${roles.current ? ' · current' : ''}${roles.event ? ' · event' : ''}`],
              ['ID', <span title={`0x${thread.id.toString(16)}`}>{thread.id} (0x{thread.id.toString(16)})</span>],
              ['Entry', <>{addressLink(entry, () => entry && navigateEntry(entry, symbol?.is_function ?? true))}{entry && symbol?.symbol_info && <span className="block">{symbol.symbol_info}</span>}</>],
              ['TEB', addressLink(thread.teb_address, () => navigateTeb(thread), thread.teb_architecture ?? undefined)],
              ['Instruction pointer', addressLink(ip, () => ip && navigateIp(thread, ip), thread.instruction_pointer_architecture ?? undefined)],
              [isWindows ? 'Suspend Count (incl. debug freezes)' : 'Suspend Count', count ?? UNAVAILABLE_THREAD_VALUE],
              ['Priority', formatThreadPriority(thread.priority)],
              ['Wait Reason', formatThreadWaitReason(thread.thread_state, thread.wait_reason)],
              ['Last Error', formatThreadLastError(thread.last_error)],
              ['User Time', formatThreadTime(thread.user_time_100ns)],
              ['Kernel Time', formatThreadTime(thread.kernel_time_100ns)],
              ['Creation Time', formatThreadCreationTime(thread.creation_time_filetime_100ns)],
              ['CPU Cycles', formatThreadCycles(thread.cpu_cycles)],
              ['Name', thread.name ?? 'Unnamed'],
            ] : [];
            return <div data-testid="thread-row" data-tid={thread.id} data-active={roles.current ? 'true' : undefined}
              data-main={roles.main ? 'true' : undefined} data-status={status} data-selected={isSelected ? 'true' : 'false'}
              className={`font-mono border-b border-l-2 ${roles.current ? 'border-l-primary bg-accent/60' : 'border-l-transparent'}`}>
              <div className="min-h-[68px] px-2 py-1 cursor-pointer hover:bg-accent/30"
                onMouseEnter={event => enterSummary(row, event)} onMouseLeave={leaveSummary}
                onClick={event => clickSummary(row, event)}
                onContextMenu={event => { dismissPopover(); openContextMenu(event, { key, tid: thread.id }); }}>
                <div className="flex items-start gap-1 min-w-0">
                  <Checkbox data-testid="thread-checkbox" aria-label={`Select thread ${thread.id}`} checked={isSelected}
                    onContextMenu={event => event.stopPropagation()}
                    onMouseEnter={dismissPopover} onClick={event => { event.stopPropagation(); dismissPopover(); toggleSelect(key, event.shiftKey); }} />
                  <span className="text-xs text-muted-foreground shrink-0" title="Thread number">#{ordinal}</span>
                  <div className="flex items-center gap-1 flex-wrap min-w-0 flex-1">
                    <h3 className="font-medium text-sm min-w-0 max-w-full break-words" title={`0x${thread.id.toString(16)}`}>Thread {thread.id}</h3>
                    {roles.main && <Badge variant="outline" size="xs" className="max-w-full">main</Badge>}
                    {roles.current && <Badge variant="outline" size="xs" className="max-w-full bg-primary/15 text-primary border-primary/30">current</Badge>}
                    {roles.event && <Badge variant="outline" size="xs" className="max-w-full">event</Badge>}
                    {count !== null && count > 0 && <Badge variant="outline" size="xs" className="max-w-full bg-syn-state/15 text-syn-state border-syn-state/30">Suspended{count > 1 ? ` (${count})` : ''}</Badge>}
                  </div>
                  <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={`Thread ${thread.id} details`}
                    aria-expanded={isExpanded} aria-controls={detailsId} onMouseEnter={dismissPopover}
                    onContextMenu={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); dismissPopover(); setExpanded(previous => {
                      const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
                    }); }}>{isExpanded ? <ChevronDown /> : <ChevronRight />}</Button>
                </div>
                <p className="truncate text-xs" title={thread.name ?? 'Unnamed'}>{thread.name ?? 'Unnamed'}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  <span className="shrink-0">Entry:</span>
                  {entry === null ? UNAVAILABLE_THREAD_VALUE : <TruncatedSymbol text={symbol?.symbol_info ?? entry}
                    className={`font-mono ${LINK_VALUE_CLASS}`} title={entry}
                    onContextMenu={event => event.stopPropagation()}
                    onMouseEnter={dismissPopover} onClick={event => { event.stopPropagation(); dismissPopover(); navigateEntry(entry, symbol?.is_function ?? true); }} />}
                </p>
              </div>
              {isExpanded && <dl id={detailsId} className="grid gap-x-4 gap-y-2 px-3 pb-3 pt-1 text-xs select-text"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))' }}
                onMouseEnter={dismissPopover} onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
                {details.map(([label, value]) => <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-all">{value}</dd>
                </div>)}
              </dl>}
            </div>;
          }} />
        {visibleRows.length === 0 && <div className="absolute inset-0 pointer-events-none">
          <EmptyState icon={<Cpu className={STATE_ICON_CLASS} />} title={query.trim() ? 'No matching threads' : 'No threads found'}
            subtitle={query.trim() ? 'Clear or change the filter to show threads' : 'Threads will appear when available'} />
        </div>}
      </div> : <div className="flex-1 min-h-0"><ProcessUnavailableState icon={Cpu} what="Threads" /></div>}

      {contextMenu && visibleKeys.has(contextMenu.data.key) && <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu} className="min-w-[180px]">
        {isPaused && <><ContextMenuItem onClick={() => switchToThread(contextMenu.data.key)}>Switch to thread</ContextMenuItem><ContextMenuSeparator /></>}
        <ContextMenuItem icon={<Pause />} disabled={!available} onClick={() => void runThreadAction('suspend_threads', targetsFor(contextMenu.data.key))}>Suspend</ContextMenuItem>
        <ContextMenuItem icon={<Play />} disabled={!available} onClick={() => void runThreadAction('resume_threads', targetsFor(contextMenu.data.key))}>Resume</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={<Square />} destructive disabled={!available} onClick={() => requestKill(targetsFor(contextMenu.data.key))}>Kill</ContextMenuItem>
      </ContextMenu>}
      <Dialog open={killPending !== null} onOpenChange={open => !open && setKillPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminate {killPending?.length === 1 ? `thread ${rows.find(row => row.key === killPending[0])?.thread.id ?? ''}` : `${killPending?.length ?? 0} threads`}?</DialogTitle>
            <DialogDescription>TerminateThread ends the thread immediately without unwinding: locks it holds stay held and its stack is never freed. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillPending(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmKill} data-testid="thread-kill-confirm">Terminate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {hoveredRow && popoverPos && createPortal(<div
        className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-3 min-w-[320px] max-w-[480px] overflow-hidden"
        style={{ left: popoverPos.x, top: popoverPos.y }}
        onMouseEnter={() => { popoverHoveredRef.current = true; window.clearTimeout(hideTimerRef.current); }}
        onMouseLeave={() => { popoverHoveredRef.current = false; startHideTimer(); }}>
        <div className="text-sm font-medium mb-2">Thread {hoveredRow.thread.id} Call Stack</div>
        {loadingKey === hoveredKey && !cachedFrames ? <div className="flex items-center gap-2 text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Loading call stack...</span></div>
          : popoverError ? <div className="text-sm text-destructive py-1">{popoverError}</div>
            : cachedFrames?.length ? <CallStackFrameList frames={cachedFrames} onClickAddress={onNavigateToDisassembly} onClickMemory={onNavigateToMemoryPointer} compact maxHeight={250} />
              : cachedFrames ? <div className="text-sm text-muted-foreground py-1">No frames</div> : null}
      </div>, document.body)}
    </DockPanel>
  );
}
