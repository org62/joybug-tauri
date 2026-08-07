import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DebugSession, Module, ModuleSymbolStatus, PdbLoadResult, Thread, Symbol, SessionStatus, hasUsableSymbols } from '@/contexts/SessionContext';
import { isProcessAvailable, isTargetLive, formatTauriError } from '@/lib/sessionHelpers';

// The 1s live poll returns fresh arrays every tick even when nothing changed;
// keeping the previous reference when contents match stops every context
// consumer from re-rendering each second.
function sameModules(a: Module[], b: Module[]): boolean {
  return a.length === b.length && a.every((m, i) => m.base_address === b[i].base_address && m.name === b[i].name && m.size === b[i].size);
}

function sameThreads(a: Thread[], b: Thread[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.start_address === b[i].start_address);
}

function sameSymbolStatuses(a: ModuleSymbolStatus[], b: ModuleSymbolStatus[]): boolean {
  return a.length === b.length && a.every((s, i) =>
    s.base_address === b[i].base_address && s.status === b[i].status && s.symbol_count === b[i].symbol_count);
}

export function useDebugSession(sessionId: string | undefined) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "restart" | "pause" | "detach" | "attach" | null
  >(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [symbolStatuses, setSymbolStatuses] = useState<ModuleSymbolStatus[]>([]);

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

  // Advisory data polled every second — failures are silent (the backend already
  // degrades errors to an empty list) so a transient hiccup never toast-spams.
  const loadSymbolStatuses = useCallback(async () => {
    if (!sessionId) return;
    try {
      const statuses = await invoke<ModuleSymbolStatus[]>("get_session_symbol_status", { sessionId });
      setSymbolStatuses(prev => sameSymbolStatuses(prev, statuses) ? prev : statuses);
    } catch (error) {
      console.error(`Failed to load symbol statuses: ${error}`);
    }
  }, [sessionId]);

  const loadModulePdb = useCallback(async (baseAddress: string, pdbPath: string, force: boolean): Promise<PdbLoadResult> => {
    if (!sessionId) return { loaded: false };
    const result = await invoke<PdbLoadResult>("load_module_pdb", {
      sessionId,
      moduleBase: baseAddress,
      pdbPath,
      force,
    });
    await loadSymbolStatuses();
    return result;
  }, [sessionId, loadSymbolStatuses]);

  const retryModuleSymbols = useCallback(async (baseAddress: string) => {
    if (!sessionId) return;
    await invoke("retry_module_symbols", { sessionId, moduleBase: baseAddress });
    await loadSymbolStatuses();
  }, [sessionId, loadSymbolStatuses]);

  const unloadModuleSymbols = useCallback(async (baseAddress: string) => {
    if (!sessionId) return;
    try {
      await invoke("unload_module_symbols", { sessionId, moduleBase: baseAddress });
      toast.success("Symbols unloaded");
    } catch (error) {
      const errorMessage = `Failed to unload symbols: ${formatTauriError(error)}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    }
    await loadSymbolStatuses();
  }, [sessionId, loadSymbolStatuses]);

  // Identity of the set of modules whose symbols are usable (PDB or export
  // fallback). Consumers refresh symbol-derived views (e.g. disassembly) when
  // it changes so raw addresses upgrade to symbol names as background
  // downloads land. The status is part of each entry so an exports_only →
  // loaded upgrade at an unchanged base still triggers a refresh.
  const symbolsRefreshKey = useMemo(
    () => symbolStatuses
      .filter((s) => hasUsableSymbols(s.status))
      .map((s) => `${s.base_address}:${s.status}`)
      .sort()
      .join(','),
    [symbolStatuses],
  );

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
      loadSymbolStatuses();
    } else if (session?.status === "Stopped" || typeof session?.status === 'object') {
      setModules([]);
      setThreads([]);
      setSymbolStatuses([]);
    }
  }, [session?.status, loadModules, loadThreads, loadSymbolStatuses]);

  // Poll modules/threads while the target runs live (Running or non-invasive
  // Open): thread/module churn produces no status transition to re-trigger the
  // effect above, and in Open mode no dll events arrive at all.
  //
  // Also re-read the session status here as a self-heal: a `session-updated`
  // event (e.g. the transition to Paused) can be missed if it fires during the
  // listener-registration window, and a paused session emits no further status
  // events — which would leave the UI stuck on "Running" until an unrelated
  // action forced a refetch. Re-reading the session catches that within a
  // second; the effect stops as soon as the status is no longer live.
  useEffect(() => {
    if (!isTargetLive(session?.status)) return;
    const interval = setInterval(() => {
      loadModules();
      loadThreads();
      if (sessionId) {
        invoke<DebugSession>("get_debug_session", { sessionId })
          .then((s) => {
            // Commit ONLY the transition the self-heal exists for: live → not
            // live. An unconditional commit would hand React a fresh session
            // object every second (re-rendering every consumer and re-firing
            // object-identity effects); and a stale still-"Running" response
            // arriving after a real `session-updated` Paused event must never
            // overwrite it — this direction check makes that impossible.
            if (s && !isTargetLive(s.status)) handleSessionUpdate(s);
          })
          .catch(() => {});
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status, sessionId, loadModules, loadThreads, handleSessionUpdate]);

  // Poll symbol statuses while PDB downloads are in flight (also while Paused —
  // downloads continue in the background) and while the target runs live (in
  // Open mode new modules appear without dll events). Once every module has
  // settled on a paused target the poll stops; the dll-loaded listener and the
  // explicit refreshes in loadModulePdb/retryModuleSymbols re-arm it.
  useEffect(() => {
    const loading = symbolStatuses.some((s) => s.status === 'loading');
    if (!isTargetLive(session?.status) && !(loading && isProcessAvailable(session?.status))) return;
    const interval = setInterval(() => {
      loadSymbolStatuses();
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status, symbolStatuses, loadSymbolStatuses]);

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
          await Promise.all([loadModules(), loadSymbolStatuses()]);
        }
      );
    };
    attach();
    return () => {
      if (unlistenUnload) unlistenUnload();
      if (unlistenLoad) unlistenLoad();
    };
  }, [sessionId, loadModules, loadSymbolStatuses]);

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

  // Restart = stop + start, orchestrated by the backend (it waits for the old
  // debug loop to unwind before starting the new run).
  const handleRestart = useCallback(async () => {
    if (!sessionId || !canStop) return;
    setBusyAction("restart");
    try {
      await invoke("restart_debug_session", { sessionId });
      toast.success("Restarting session…");
    } catch (error) {
      const errorMessage = `Failed to restart session: ${formatTauriError(error)}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStop]);

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
    symbolStatuses,
    symbolsRefreshKey,
    loadModules,
    loadThreads,
    loadModulePdb,
    retryModuleSymbols,
    unloadModuleSymbols,
    searchSymbols,
    handleGo,
    handleGoPassException,
    handleStepIn,
    handleStepOut,
    handleStepOver,
    handleStop,
    handleStart,
    handleRestart,
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