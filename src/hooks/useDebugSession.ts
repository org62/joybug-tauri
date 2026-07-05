import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DebugSession, Module, Thread, Symbol, SessionStatus } from '@/contexts/SessionContext';
import { isProcessAvailable, isTargetLive } from '@/lib/sessionHelpers';

// The 1s live poll returns fresh arrays every tick even when nothing changed;
// keeping the previous reference when contents match stops every context
// consumer from re-rendering each second.
function sameModules(a: Module[], b: Module[]): boolean {
  return a.length === b.length && a.every((m, i) => m.base_address === b[i].base_address && m.name === b[i].name && m.size === b[i].size);
}

function sameThreads(a: Thread[], b: Thread[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.start_address === b[i].start_address);
}

export function useDebugSession(sessionId: string | undefined) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "pause" | "detach" | "attach" | null
  >(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  // Debounced display status - prevents UI flicker during quick stepping operations
  const [displayStatus, setDisplayStatus] = useState<SessionStatus>("Stopped");
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce logic: delay Paused → Running transitions to prevent flicker on stepping
  useEffect(() => {
    const actualStatus = session?.status;

    // Clear any pending timeout
    if (statusTimeoutRef.current) {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = null;
    }

    if (!actualStatus) {
      setDisplayStatus("Stopped");
      return;
    }

    // Immediate transition for these cases:
    // - Going to Paused (step completed, show results immediately)
    // - Going to Stopped (session ended)
    // - Going to Error
    // - Initial state when displayStatus is Stopped
    if (actualStatus === "Paused" ||
        actualStatus === "Stopped" ||
        typeof actualStatus === "object" ||  // Error state
        displayStatus === "Stopped") {
      setDisplayStatus(actualStatus);
      return;
    }

    // Debounce transition TO Running (from Paused)
    // This prevents flicker during quick step operations
    if (actualStatus === "Running" && displayStatus === "Paused") {
      statusTimeoutRef.current = setTimeout(() => {
        setDisplayStatus("Running");
      }, 250); // 250ms debounce
      return;
    }

    // For any other case, update immediately
    setDisplayStatus(actualStatus);
  }, [session?.status]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
    };
  }, []);

  const canStep = useMemo(() => displayStatus === "Paused", [displayStatus]);
  const canStop = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return isProcessAvailable(session.status);
  }, [session]);
  const canStart = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Stopped"].includes(session.status);
  }, [session]);

  const canPause = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Running"].includes(session.status);
  }, [session]);

  // Detach is sent over the session's own connection from the paused debug loop,
  // so it's only available while paused.
  const canDetach = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Paused"].includes(session.status);
  }, [session]);

  const loadModules = useCallback(async () => {
    if (!sessionId) return [];
    try {
      const mods = await invoke<Module[]>("get_session_modules", { sessionId });
      setModules(prev => sameModules(prev, mods) ? prev : mods);
      return mods;
    } catch (error) {
      const errorMessage = `Failed to load modules: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      return [];
    }
  }, [sessionId]);

  const loadThreads = useCallback(async () => {
    if (!sessionId) return [];
    try {
      const thrs = await invoke<Thread[]>("get_session_threads", { sessionId });
      setThreads(prev => sameThreads(prev, thrs) ? prev : thrs);
      return thrs;
    } catch (error) {
      const errorMessage = `Failed to load threads: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      return [];
    }
  }, [sessionId]);

  const searchSymbols = useCallback(async (pattern: string, limit?: number): Promise<Symbol[]> => {
    if (!sessionId) return [];

    // Create a promise that will resolve when we receive the symbols-updated event
    return new Promise(async (resolve) => {
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unlisten();
        unlistenError();
      };

      const timeout = setTimeout(() => {
        console.warn('Symbol search timed out for pattern:', pattern);
        cleanup();
        resolve([]);
      }, 5000); // 5 second timeout

      // Set up one-time listener for the response
      const unlisten = await listen<{ session_id: string; pattern: string; symbols: Symbol[] }>(
        'symbols-updated',
        (event) => {
          if (event.payload.session_id === sessionId && event.payload.pattern === pattern) {
            cleanup();
            resolve(event.payload.symbols);
          }
        }
      );

      // Also listen for errors
      const unlistenError = await listen<{ session_id: string; pattern: string; error: string }>(
        'symbols-error',
        (event) => {
          if (event.payload.session_id === sessionId && event.payload.pattern === pattern) {
            cleanup();
            console.error(`Symbol search error: ${event.payload.error}`);
            resolve([]);
          }
        }
      );

      try {
        await invoke("search_session_symbols", {
          sessionId,
          pattern,
          limit: limit || 30
        });
      } catch (error) {
        cleanup();
        const errorMessage = `Failed to search symbols: ${error}`;
        toast.error(errorMessage);
        console.error(errorMessage);
        resolve([]);
      }
    });
  }, [sessionId]);

  const handleSessionUpdate = useCallback((newSession: DebugSession) => {
    setSession(newSession);
    setIsLoading(false);
    // Persist latest exception code so settings page can pre-populate new rules
    const exc = newSession.current_event;
    if (exc?.event_type === "Exception" && exc.exception_code != null) {
      localStorage.setItem("joybug_last_exception_code", String(exc.exception_code));
    }
  }, []);

  useEffect(() => {
    // Track fetch ordering to prevent stale responses from overwriting fresh data.
    // Each fetch increments the counter; only the latest fetch applies its result.
    let fetchSeq = 0;
    const fetchSession = async () => {
      if (!sessionId) return;
      const mySeq = ++fetchSeq;
      try {
        const result = await invoke<DebugSession>("get_debug_session", { sessionId });
        if (mySeq === fetchSeq) {
          setSession(result);
          setIsLoading(false);
        }
      } catch (error) {
        if (mySeq === fetchSeq) {
          const errorMessage = `Failed to load session: ${error}`;
          toast.error(errorMessage);
          console.error(errorMessage);
          setSession(null);
          setIsLoading(false);
        }
      }
    };

    fetchSession();

    const listenToSessionUpdates = async () => {
      const unlisten = await listen<DebugSession>(
        "session-updated",
        (event) => {
          if (event.payload.id === sessionId) {
            handleSessionUpdate(event.payload);
          }
        }
      );
      // Re-fetch after listener is active to catch events that fired
      // between the initial fetch and listener setup
      fetchSession();
      return unlisten;
    };

    const unlistenPromise = listenToSessionUpdates();

    return () => {
      unlistenPromise.then(unlisten => {
        if (unlisten) unlisten();
      });
    };
  }, [sessionId, handleSessionUpdate]);

  useEffect(() => {
    if (isProcessAvailable(session?.status)) {
      loadModules();
      loadThreads();
    } else if (session?.status === "Stopped" || typeof session?.status === 'object') {
      setModules([]);
      setThreads([]);
    }
  }, [session?.status, loadModules, loadThreads]);

  // Poll modules/threads while the target runs live (Running or non-invasive
  // Open): thread/module churn produces no status transition to re-trigger the
  // effect above, and in Open mode no dll events arrive at all.
  useEffect(() => {
    if (!isTargetLive(session?.status)) return;
    const interval = setInterval(() => {
      loadModules();
      loadThreads();
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status, loadModules, loadThreads]);

  // Listen for dll load/unload targeted events to refresh modules quickly
  useEffect(() => {
    if (!sessionId) return;
    let unlistenUnload: (() => void) | undefined;
    let unlistenLoad: (() => void) | undefined;
    const attach = async () => {
      unlistenUnload = await listen<{ session_id: string; pid: number; tid: number; base_of_dll: number; dll_name?: string }>(
        "dll-unloaded",
        async (event) => {
          if (event.payload.session_id !== sessionId) return;
          await loadModules();
        }
      );
      unlistenLoad = await listen<{ session_id: string; pid: number; tid: number; dll_name: string; base_of_dll: number; size_of_dll?: number }>(
        "dll-loaded",
        async (event) => {
          if (event.payload.session_id !== sessionId) return;
          await loadModules();
        }
      );
    };
    attach();
    return () => {
      if (unlistenUnload) unlistenUnload();
      if (unlistenLoad) unlistenLoad();
    };
  }, [sessionId, loadModules]);

  const handleGo = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setBusyAction("go");
    try {
      await invoke("step_debug_session", { sessionId });
    } catch (error) {
      const errorMessage = `Failed to step session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStep]);

  const handleGoPassException = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setBusyAction("go");
    try {
      await invoke("step_pass_exception", { sessionId });
    } catch (error) {
      const errorMessage = `Failed to pass exception: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStep]);

  const handleStepIn = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setBusyAction("stepIn");
    try {
      await invoke("step_in_debug_session", { sessionId });
      // The session-updated event will refresh the state
    } catch (error) {
      const errorMessage = `Failed to step in session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStep]);

  const handleStepOut = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setBusyAction("stepOut");
    try {
      await invoke("step_out_debug_session", { sessionId });
    } catch (error) {
      const errorMessage = `Failed to step out session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStep]);

  const handleStepOver = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setBusyAction("stepOver");
    try {
      await invoke("step_over_debug_session", { sessionId });
    } catch (error) {
      const errorMessage = `Failed to step over session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStep]);

  const handleStart = useCallback(async () => {
    if (!sessionId || !canStart) return;
    try {
      await invoke("start_debug_session", { sessionId });
      toast.success("Debug session started");
    } catch (error) {
      const errorMessage = `Failed to start session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    }
  }, [sessionId, canStart]);

  const handleStop = useCallback(async () => {
    if (!sessionId || !canStop) return;
    setBusyAction("stop");
    try {
      const isRunning = session?.status === "Running";
      if (isRunning) {
        await invoke("terminate_debug_session", { sessionId });
        toast.success("Terminate signal sent");
      } else {
        await invoke("stop_debug_session", { sessionId });
        toast.success("Debug session stopped");
      }
    } catch (error) {
      const errorMessage = `Failed to stop session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStop, session]);

  const handlePause = useCallback(async () => {
    if (!sessionId || !canPause) return;
    setBusyAction("pause");
    try {
      await invoke("pause_debug_session", { sessionId });
      toast.success("Pause signal sent");
    } catch (error) {
      const errorMessage = `Failed to pause session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canPause]);

  const handleDetach = useCallback(async () => {
    if (!sessionId || !canDetach) return;
    setBusyAction("detach");
    try {
      await invoke("detach_debug_session", { sessionId });
      toast.success("Detached — target left running");
    } catch (error) {
      const errorMessage = `Failed to detach: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canDetach]);

  // Promote a non-invasive Open session to a full attached debug session.
  const handleAttach = useCallback(async () => {
    if (!sessionId || session?.status !== "Open") return;
    setBusyAction("attach");
    try {
      await invoke("attach_open_session", { sessionId });
      toast.success("Attaching to process…");
    } catch (error) {
      const errorMessage = `Failed to attach: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, session?.status]);

  return {
    session,
    displayStatus,
    isLoading,
    busyAction,
    modules,
    threads,
    loadModules,
    loadThreads,
    searchSymbols,
    handleGo,
    handleGoPassException,
    handleStepIn,
    handleStepOut,
    handleStepOver,
    handleStop,
    handleStart,
    handlePause,
    handleDetach,
    handleAttach,
    canStep,
    canStop,
    canStart,
    canPause,
    canDetach,
  };
} 