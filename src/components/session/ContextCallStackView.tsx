import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { AlertCircle, List } from 'lucide-react';

interface CallStackFrame {
  frame_number: number;
  instruction_pointer: string;
  stack_pointer: string;
  frame_pointer: string;
  symbol_info: string | null;
}

export function ContextCallStackView() {
  const sessionData = useSessionContext();
  const [callStack, setCallStack] = useState<CallStackFrame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isOpenRef = useRef(false);

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

  // Auto-fetch call stack on every step if window is open
  useEffect(() => {
    if (sessionData?.session?.status === 'Paused' && isOpenRef.current) {
      fetchCallStack();
    } else if (sessionData?.session?.status !== 'Paused') {
      setCallStack([]);
      setError(null);
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

    return () => {
      unlistenUpdated.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionData?.session?.id]);

  // Track if component is visible (mounted)
  useEffect(() => {
    isOpenRef.current = true;
    return () => {
      isOpenRef.current = false;
    };
  }, []);

  const formatSymbol = (symbol: string | null) => {
    if (!symbol) return 'Unknown';
    return symbol;
  };

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
    <div className="h-full overflow-auto">
      {callStack.length > 0 ? (
        <div className="space-y-1">
          {callStack.map((frame) => (
            <div 
              key={frame.frame_number}
              className="flex items-center justify-between px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-muted-foreground">#{frame.frame_number}</span>
                  <p className="font-medium truncate">
                    {formatSymbol(frame.symbol_info)}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  RIP: <span className="font-mono">{frame.instruction_pointer}</span> | 
                  SP: <span className="font-mono">{frame.stack_pointer}</span> | 
                  FP: <span className="font-mono">{frame.frame_pointer}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">{error}</p>
            <p className="text-sm mt-1">Call stack will retry automatically on next step</p>
          </div>
        </div>
      ) : sessionData.session.status !== 'Paused' ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Session must be paused to fetch call stack</p>
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
    </div>
  );
} 