import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { isProcessAvailable } from '@/lib/sessionHelpers';
import { AlertCircle, List } from 'lucide-react';
import { CallStackFrameList, CallStackFrame } from '@/components/CallStackFrameList';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';

interface ContextCallStackViewProps {
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemoryPointer?: (address: string) => void;
}

export function ContextCallStackView({ onNavigateToDisassembly, onNavigateToMemoryPointer }: ContextCallStackViewProps) {
  const sessionData = useSessionContext();
  const [callStack, setCallStack] = useState<CallStackFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedTid, setSelectedTid] = useState<number | null>(null);
  const isOpenRef = useRef(false);
  const canUse = sessionData.canUseMemoryOps;

  const fetchCallStack = async () => {
    if (!sessionData?.session?.id) return;

    setError(null);

    try {
      await invoke('request_session_callstack', {
        sessionId: sessionData.session.id,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch call stack';
      setError(errorMessage);
    }
  };

  // Auto-fetch the current thread's call stack on every step (paused invasive
  // sessions). Clear only when the process is gone (Stopped/Error); in
  // Open/Running the stack is driven by thread selection, so don't wipe it here.
  // Use the raw session status (not the debounced canUse) so clearing fires
  // promptly on stop.
  useEffect(() => {
    const status = sessionData?.session?.status;
    const available = isProcessAvailable(status);
    if (status === 'Paused' && isOpenRef.current) {
      fetchCallStack();
    } else if (!available) {
      setCallStack([]);
      setError(null);
      setSelectedTid(null);
    }
  }, [sessionData?.session?.status, sessionData?.session?.current_event]);

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
    // which has no single current thread).
    const unlistenThread = listen<{ session_id: string; tid: number; frames: CallStackFrame[] }>(
      'thread-callstack-updated',
      (event) => {
        if (event.payload.session_id === sessionData?.session?.id) {
          setSelectedTid(event.payload.tid);
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

  return (
    <DockPanel>
      {callStack.length > 0 ? (
        <>
          {selectedTid !== null && (
            <PanelToolbar className="text-xs text-muted-foreground">
              Thread {selectedTid}
            </PanelToolbar>
          )}
          <div className="flex-1 min-h-0">
            <CallStackFrameList
              frames={callStack}
              onClickAddress={onNavigateToDisassembly}
              onClickMemory={onNavigateToMemoryPointer}
            />
          </div>
        </>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">{error}</p>
            <p className="text-sm mt-1">Call stack will retry automatically on next step</p>
          </div>
        </div>
      ) : !canUse ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No call stack available</p>
            <p className="text-sm mt-1">Open, attach to, or run a process first</p>
          </div>
        </div>
      ) : sessionData.session.status !== 'Paused' ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <List className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No call stack selected</p>
            <p className="text-sm mt-1">Click a thread in the Threads window to view its call stack</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <List className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No call stack data available</p>
            {sessionData.session.status === 'Paused' && (
              <p className="text-sm mt-1">Call stack will be fetched automatically</p>
            )}
          </div>
        </div>
      )}
    </DockPanel>
  );
}
