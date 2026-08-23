import { useEffect, useMemo, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { AlertCircle, List } from 'lucide-react';
import { CallStackFrameList, CallStackFrame } from '@/components/CallStackFrameList';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { EmptyState, ProcessUnavailableState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { ContextHexView } from '@/components/session/ContextHexView';
import { formatTauriError, isBenignSessionError } from '@/lib/sessionHelpers';
import { parseAddress } from '@/lib/hexUtils';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';

interface ContextCallStackViewProps {
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemoryPointer?: (address: string) => void;
}

/** "Stack" tab sub-view: walked frames, or the raw stack memory at RSP in
 *  pointer style. Persisted like the other panel preferences (registers.*). */
type StackMode = 'frames' | 'hex';
const STACK_MODES = [
  ['frames', 'Call Stack'],
  ['hex', 'Hex'],
] as const;

function StackModeToggle({ mode, onChange }: { mode: StackMode; onChange: (m: StackMode) => void }) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      {STACK_MODES.map(([value, label]) => (
        <Button
          key={value}
          size="xs"
          variant={mode === value ? 'default' : 'ghost'}
          aria-pressed={mode === value}
          data-testid={`stack-mode-${value}`}
          onClick={() => onChange(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

export function ContextCallStackView({ onNavigateToDisassembly, onNavigateToMemoryPointer }: ContextCallStackViewProps) {
  const sessionData = useSessionContext();
  const sessionId = sessionData?.session?.id;
  const [callStack, setCallStack] = useState<CallStackFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Thread explicitly chosen via the Threads window in Open/Running sessions
  // (no context to switch there, so the backend has no record of it).
  const [redirectedTid, setRedirectedTid] = useState<number | null>(null);
  const isOpenRef = useRef(false);
  const canUse = sessionData.canUseMemoryOps;
  const isPaused = sessionData.isPaused;
  // While paused the backend owns the selection (reset on every pause); the
  // session payload is the source of truth so the label can't go stale.
  const selectedTid =
    sessionData.session?.status === 'Paused'
      ? sessionData.session.selected_thread_id ?? null
      : redirectedTid;

  const [mode, setMode] = useLocalStorageState<StackMode>('stack.mode', 'frames');

  // Hex-mode inputs: RSP (x64) / SP (ARM64) from the current thread context, and
  // a key that advances once per pause so the hex view re-follows the stack
  // pointer even when a step leaves it unchanged.
  const context = sessionData?.session?.current_event?.context;
  const stackPointer = useMemo(() => {
    if (!context) return undefined;
    const raw = 'rsp' in context ? context.rsp : 'sp' in context ? context.sp : undefined;
    return raw ? parseAddress(String(raw)) ?? undefined : undefined;
  }, [context]);
  const [followSeq, setFollowSeq] = useState(0);

  const fetchCallStack = async () => {
    if (!sessionData?.session?.id) return;

    setError(null);

    try {
      await invoke('request_session_callstack', {
        sessionId: sessionData.session.id,
      });
    } catch (err) {
      // A request that rejects because the process went away mid-flight is not
      // an error — the panel shows its no-process state instead.
      const errorMessage = formatTauriError(err) || 'Failed to fetch call stack';
      if (isBenignSessionError(errorMessage)) return;
      setError(errorMessage);
    }
  };

  // Auto-fetch the current thread's call stack on every step (paused invasive
  // sessions). Clear only when the process is gone (Stopped/Error); in
  // Open/Running the stack is driven by thread selection, so don't wipe it here.
  // Keyed on the debounced status like every other tab — Stopped applies to it
  // immediately, so clearing is still prompt.
  // Walking the stack is expensive on the backend (StackWalk64 under the global
  // dbghelp lock, symbolizing every frame), so hex mode — where the frames are
  // never rendered — skips it; `mode` is a dep so switching back refetches.
  useEffect(() => {
    if (isPaused && isOpenRef.current) {
      if (mode === 'frames') fetchCallStack();
      else setFollowSeq((s) => s + 1);
    } else if (!canUse) {
      setCallStack([]);
      setError(null);
      setRedirectedTid(null);
    }
  }, [isPaused, canUse, mode, sessionData?.session?.current_event]);

  // Fetch call stack when component first mounts if session is already paused
  useEffect(() => {
    if (sessionData?.session?.status === 'Paused' && sessionData?.session?.id) {
      fetchCallStack();
    }
  }, [sessionData?.session?.id]); // Run when session ID is available

  // Listen for callstack updates
  useEffect(() => {
    const unlistenUpdated = listen('callstack-updated', (event: any) => {
      if (event.payload.session_id === sessionData?.session?.id) {
        setCallStack(event.payload.frames);
        setError(null);
      }
    });

    const unlistenError = listen('callstack-error', (event: any) => {
      if (event.payload.session_id === sessionData?.session?.id) {
        setError(event.payload.error);
        setCallStack([]);
      }
    });

    // Also reflect the thread the user selects in the Threads window, so clicking a
    // thread "redirects" its call stack here (the primary path in non-invasive mode,
    // which has no single current thread). Hover-preview fetches (the Threads
    // popover) carry preview=true and must NOT retarget this panel.
    const unlistenThread = listen<{ session_id: string; tid: number; preview: boolean; frames: CallStackFrame[] }>(
      'thread-callstack-updated',
      (event) => {
        if (event.payload.session_id === sessionData?.session?.id && !event.payload.preview) {
          setRedirectedTid(event.payload.tid);
          setCallStack(event.payload.frames);
          setError(null);
        }
      },
    );

    return () => {
      unlistenUpdated.then(f => f());
      unlistenError.then(f => f());
      unlistenThread.then(f => f());
    };
  }, [sessionData?.session?.id]);

  // Track if component is visible (mounted)
  useEffect(() => {
    isOpenRef.current = true;
    return () => {
      isOpenRef.current = false;
    };
  }, []);

  if (!sessionData?.session) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No session available</p>
        </div>
      </div>
    );
  }

  // One shell for both modes: the toggle sits in the panel's own toolbar, so it
  // stays in a fixed place (and stays reachable in the empty/error states)
  // instead of being injected into the hex view's toolbar.
  const hasFrames = callStack.length > 0;
  return (
    <DockPanel data-testid="callstack-panel">
      <PanelToolbar className="text-xs text-muted-foreground">
        <StackModeToggle mode={mode} onChange={setMode} />
        {mode === 'frames' && hasFrames && selectedTid !== null && <span>Thread {selectedTid}</span>}
      </PanelToolbar>
      {/* Hex mode needs a live process; otherwise fall through to the frames
          empty states, which explain why there is nothing to show. */}
      {mode === 'hex' && canUse ? (
        <div className="flex-1 min-h-0 relative">
          <ContextHexView
            memoryViewId="stack"
            initialAddress={stackPointer}
            initialViewMode="pointer"
            followAddress={stackPointer}
            followKey={`${sessionId}:${followSeq}`}
            navScope="private"
          />
        </div>
      ) : hasFrames ? (
        <div className="flex-1 min-h-0">
          <CallStackFrameList
            frames={callStack}
            onClickAddress={onNavigateToDisassembly}
            onClickMemory={onNavigateToMemoryPointer}
          />
        </div>
      ) : error ? (
        <EmptyState
          icon={<AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />}
          title={error}
          subtitle="Call stack will retry automatically on next step"
        />
      ) : !canUse ? (
        <ProcessUnavailableState icon={List} what="Call stack" />
      ) : !isPaused ? (
        <EmptyState
          icon={<List className="h-12 w-12 mx-auto mb-4 opacity-50" />}
          title="No call stack selected"
          subtitle="Click a thread in the Threads window to view its call stack"
        />
      ) : (
        <EmptyState
          icon={<List className="h-12 w-12 mx-auto mb-4 opacity-50" />}
          title="No call stack data available"
          subtitle="Call stack will be fetched automatically"
        />
      )}
    </DockPanel>
  );
}
