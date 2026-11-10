import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { DebugSession, Module, ModuleSymbolStatus, PdbLoadResult, Thread, Symbol, hasUsableSymbols } from '@/contexts/SessionContext';
import { isProcessAvailable, isPausedSession, isTargetLive, canStopSession, formatTauriError, reportSessionError, sessionDisplayName, dumpMenuLabels } from '@/lib/sessionHelpers';
import { useDisplayStatus } from '@/hooks/useDisplayStatus';
import { usePlatform } from '@/hooks/usePlatform';
import { perfInvoke, perfSessionUpdate, perfStepIssued } from "@/lib/perf";

// The 1s live poll returns fresh arrays every tick even when nothing changed;
// keeping the previous reference when contents match stops every context
// consumer from re-rendering each second.
function sameModules(a: Module[], b: Module[]): boolean {
  return a.length === b.length && a.every((m, i) => m.base_address === b[i].base_address && m.name === b[i].name && m.size === b[i].size);
}

function sameThreads(a: Thread[], b: Thread[]): boolean {
  return a.length === b.length && a.every((t, i) => {
    const other = b[i];
    return t.id === other.id
      && t.start_address === other.start_address
      && t.suspend_count === other.suspend_count
      && t.name === other.name
      && t.teb_address === other.teb_address
      && t.teb_architecture === other.teb_architecture
      && t.instruction_pointer === other.instruction_pointer
      && t.instruction_pointer_architecture === other.instruction_pointer_architecture
      && t.priority === other.priority
      && t.thread_state === other.thread_state
      && t.wait_reason === other.wait_reason
      && t.last_error === other.last_error
      && t.user_time_100ns === other.user_time_100ns
      && t.kernel_time_100ns === other.kernel_time_100ns
      && t.creation_time_filetime_100ns === other.creation_time_filetime_100ns
      && t.cpu_cycles === other.cpu_cycles;
  });
}

// `line_info` is deliberately not compared: line tables land one module at a
// time, and a fresh array for each would re-render every context consumer.
// Their state is carried separately (`lineTablesReadyKey`, `lineTablesLoading`).
function sameSymbolStatuses(a: ModuleSymbolStatus[], b: ModuleSymbolStatus[]): boolean {
  return a.length === b.length && a.every((s, i) =>
    s.base_address === b[i].base_address && s.status === b[i].status && s.symbol_count === b[i].symbol_count);
}

export function useDebugSession(sessionId: string | undefined) {
  const platform = usePlatform();
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "restart" | "pause" | "detach" | "attach" | "dump" | null
  >(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  // Advance before committing session events, not in a later effect: an IPC
  // response can arrive between the event and React's next render.
  const targetRef = useRef({
    sessionId,
    processId: undefined as number | undefined,
    generation: 0,
    threadRequest: 0,
    sessionRevision: 0,
    status: undefined as DebugSession["status"] | undefined,
  });
  if (targetRef.current.sessionId !== sessionId) {
    targetRef.current = {
      sessionId,
      processId: undefined,
      generation: targetRef.current.generation + 1,
      threadRequest: 0,
      sessionRevision: targetRef.current.sessionRevision + 1,
      status: undefined,
    };
  }
  const [symbolStatuses, setSymbolStatuses] = useState<ModuleSymbolStatus[]>([]);
  // Line tables are parsed in the background, after the symbols. The key names
  // the modules whose table is ready (the source view asks again when it
  // changes); `lineTablesLoading` keeps the status poll going until they are.
  const [lineTablesReadyKey, setLineTablesReadyKey] = useState('');
  const [lineTablesLoading, setLineTablesLoading] = useState(false);

  // Debounced display status - prevents UI flicker during quick stepping
  // operations. Shared with the header's active-session pill so both settle
  // together; see hooks/useDisplayStatus.ts.
  const displayStatus = useDisplayStatus(session?.status);

  const canStep = useMemo(() => displayStatus === "Paused", [displayStatus]);
  const canStop = useMemo(() => canStopSession(session?.status), [session]);
  const canStart = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Stopped"].includes(session.status);
  }, [session]);

  const canPause = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    // A run-only ("just launch") sandbox session has no debugger, so there is
    // nothing to break into — Pause doesn't apply even while it's Running.
    if (session.sandbox && !session.sandbox.debug) return false;
    return ["Running"].includes(session.status);
  }, [session]);

  // Detach is sent over the session's own connection from the paused debug loop,
  // so it's only available while paused.
  const canDetach = useMemo(() => isPausedSession(session?.status), [session]);
  // Minidumps are written from inside the paused debug loop as well.
  const canDump = useMemo(() => isPausedSession(session?.status), [session]);

  const loadModules = useCallback(async () => {
    if (!sessionId) return [];
    try {
      const mods = await perfInvoke<Module[]>("modules", "get_session_modules", { sessionId }, sessionId);
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
    const target = targetRef.current;
    if (!sessionId || target.sessionId !== sessionId || target.processId == null) return [];
    const generation = target.generation;
    const request = ++target.threadRequest;
    const isCurrent = () => targetRef.current.sessionId === sessionId
      && targetRef.current.generation === generation
      && targetRef.current.processId === target.processId
      && targetRef.current.threadRequest === request;
    try {
      const thrs = await perfInvoke<Thread[]>("threads", "get_session_threads", { sessionId }, sessionId);
      if (!isCurrent()) return [];
      setThreads(prev => !isCurrent() || sameThreads(prev, thrs) ? prev : thrs);
      return thrs;
    } catch (error) {
      if (isCurrent()) reportSessionError("load threads", error, sessionId);
      return [];
    }
  }, [sessionId]);

  // Advisory data polled every second — failures are silent (the backend already
  // degrades errors to an empty list) so a transient hiccup never toast-spams.
  const loadSymbolStatuses = useCallback(async () => {
    if (!sessionId) return;
    try {
      const statuses = await perfInvoke<ModuleSymbolStatus[]>("symbol_status", "get_session_symbol_status", { sessionId }, sessionId);
      setSymbolStatuses(prev => sameSymbolStatuses(prev, statuses) ? prev : statuses);
      setLineTablesReadyKey(statuses.filter((s) => s.line_info === 'ready').map((s) => s.base_address).sort().join(','));
      setLineTablesLoading(statuses.some((s) => s.line_info === 'loading'));
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
  // loaded upgrade at an unchanged base still triggers a refresh. A line table
  // landing is deliberately not part of it: only the source view waits for
  // that (`lineTablesReadyKey`), and folding it in here would reload every
  // disassembly and hex view for nothing.
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

      // Generous: a broad pattern can return the panel's full 10k-symbol limit,
      // which is a megabyte or two of JSON crossing core -> Tauri -> webview.
      const timeout = setTimeout(() => {
        console.warn('Symbol search timed out for pattern:', pattern);
        cleanup();
        resolve([]);
      }, 30000);

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
    if (newSession.id !== sessionId || targetRef.current.sessionId !== sessionId) return;
    const target = targetRef.current;
    const processId = isProcessAvailable(newSession.status)
      ? newSession.current_event?.process_id ?? newSession.attach_pid ?? undefined
      : undefined;
    target.sessionRevision++;
    if (target.processId !== processId) {
      target.generation++;
      target.threadRequest++;
      target.processId = processId;
      setThreads([]);
    } else if (target.status !== newSession.status) {
      // Counts include the debug freeze on Windows. Neither that count nor a
      // stopped IP sample remains valid across a pause/resume transition.
      target.threadRequest++;
      setThreads(previous => previous.map(thread => ({
        ...thread,
        suspend_count: null,
        instruction_pointer: null,
        instruction_pointer_architecture: null,
      })));
    }
    target.status = newSession.status;
    // Before React sees it: the pause must be on record when the views commit.
    perfSessionUpdate(newSession);
    setSession(newSession);
    setIsLoading(false);
    // Persist latest exception code so settings page can pre-populate new rules
    const exc = newSession.current_event;
    if (exc?.event_type === "Exception" && exc.exception_code != null) {
      localStorage.setItem("joybug_last_exception_code", String(exc.exception_code));
    }
  }, [sessionId]);

  useEffect(() => {
    // Track fetch ordering to prevent stale responses from overwriting fresh data.
    // Each fetch increments the counter; only the latest fetch applies its result.
    let fetchSeq = 0;
    let active = true;
    const fetchSession = async () => {
      if (!sessionId) return;
      const mySeq = ++fetchSeq;
      const revision = targetRef.current.sessionRevision;
      try {
        const result = await invoke<DebugSession>("get_debug_session", { sessionId });
        if (active && mySeq === fetchSeq && revision === targetRef.current.sessionRevision) {
          handleSessionUpdate(result);
        }
      } catch (error) {
        if (active && mySeq === fetchSeq && revision === targetRef.current.sessionRevision) {
          const errorMessage = `Failed to load session: ${error}`;
          toast.error(errorMessage);
          console.error(errorMessage);
          targetRef.current.generation++;
          targetRef.current.threadRequest++;
          targetRef.current.processId = undefined;
          setThreads([]);
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
          if (active && event.payload.id === sessionId) {
            handleSessionUpdate(event.payload);
          }
        }
      );
      // Re-fetch after listener is active to catch events that fired
      // between the initial fetch and listener setup
      if (active) fetchSession();
      return unlisten;
    };

    const unlistenPromise = listenToSessionUpdates();

    return () => {
      active = false;
      fetchSeq++;
      targetRef.current.generation++;
      targetRef.current.threadRequest++;
      unlistenPromise.then(unlisten => {
        if (unlisten) unlisten();
      });
    };
  }, [sessionId, handleSessionUpdate]);

  useEffect(() => {
    if (session?.id === sessionId && isProcessAvailable(session?.status)) {
      loadModules();
      loadThreads();
      loadSymbolStatuses();
    } else {
      setModules([]);
      setThreads([]);
      setSymbolStatuses([]);
      setLineTablesReadyKey('');
      setLineTablesLoading(false);
    }
  }, [sessionId, session?.id, session?.current_event?.process_id, session?.attach_pid, session?.status, loadModules, loadThreads, loadSymbolStatuses]);

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
    let active = true;
    const interval = setInterval(() => {
      loadModules();
      loadThreads();
      if (sessionId) {
        const generation = targetRef.current.generation;
        const revision = targetRef.current.sessionRevision;
        invoke<DebugSession>("get_debug_session", { sessionId })
          .then((s) => {
            // Commit ONLY the transition the self-heal exists for: live → not
            // live. An unconditional commit would hand React a fresh session
            // object every second (re-rendering every consumer and re-firing
            // object-identity effects); and a stale still-"Running" response
            // arriving after a real `session-updated` Paused event must never
            // overwrite it — this direction check makes that impossible.
            if (active && targetRef.current.sessionId === sessionId
              && targetRef.current.generation === generation
              && targetRef.current.sessionRevision === revision
              && s && !isTargetLive(s.status)) handleSessionUpdate(s);
          })
          .catch(() => {});
      }
    }, 1000);
    return () => { active = false; clearInterval(interval); };
  }, [session?.status, sessionId, loadModules, loadThreads, handleSessionUpdate]);

  // Poll symbol statuses while PDB downloads or line-table parses are in flight
  // (also while Paused — both continue in the background) and while the target
  // runs live (in Open mode new modules appear without dll events). Once every
  // module has settled on a paused target the poll stops; the dll-loaded
  // listener, the explicit refreshes in loadModulePdb/retryModuleSymbols and
  // the line-table listener below re-arm it.
  useEffect(() => {
    const loading = lineTablesLoading || symbolStatuses.some((s) => s.status === 'loading');
    if (!isTargetLive(session?.status) && !(loading && isProcessAvailable(session?.status))) return;
    const interval = setInterval(() => {
      loadSymbolStatuses();
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.status, symbolStatuses, lineTablesLoading, loadSymbolStatuses]);

  // A source lookup that found its module's line table still unparsed has just
  // started the parse (in the background, in the debug server). Re-read the
  // statuses so the poll above sees the table loading and follows it to
  // `ready` — which is what brings the answer to the views that asked.
  useEffect(() => {
    if (!sessionId) return;
    const unlisten = listen<{ session_id: string; pending?: boolean }>('source-line-resolved', (event) => {
      if (event.payload.session_id === sessionId && event.payload.pending) loadSymbolStatuses();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [sessionId, loadSymbolStatuses]);

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
      perfStepIssued(sessionId);
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
      perfStepIssued(sessionId);
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
      perfStepIssued(sessionId);
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
    targetRef.current.generation++;
    targetRef.current.threadRequest++;
    targetRef.current.processId = undefined;
    setThreads([]);
    const generation = targetRef.current.generation;
    try {
      await invoke("restart_debug_session", { sessionId });
      toast.success("Restarting session…");
    } catch (error) {
      const errorMessage = `Failed to restart session: ${formatTauriError(error)}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      if (targetRef.current.sessionId === sessionId && targetRef.current.generation === generation) {
        try {
          const current = await invoke<DebugSession>("get_debug_session", { sessionId });
          if (targetRef.current.sessionId === sessionId && targetRef.current.generation === generation) {
            handleSessionUpdate(current);
          }
        } catch (refreshError) {
          reportSessionError("refresh session", refreshError, sessionId);
        }
      }
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, canStop, handleSessionUpdate]);

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

  // Pick a .dmp path, then ask the session loop to write the dump. The result
  // arrives as a `minidump-result` event (toasted app-wide in App.tsx); only a failure to queue the
  // command is reported here.
  const handleCreateDump = useCallback(async (fullMemory: boolean) => {
    if (!sessionId || !session || !canDump) return;
    const stem = sessionDisplayName(session).replace(/[<>:"/\\|?*]+/g, "_");
    const suffix = fullMemory ? "-full" : "";
    let path: string | null;
    try {
      // A minidump on Windows, an ELF core file everywhere else.
      const dump = dumpMenuLabels(platform.os);
      path = await saveFileDialog({
        defaultPath: `${stem}${suffix}.${dump.extension}`,
        filters: [{ name: dump.filterName, extensions: [dump.extension] }, { name: "All Files", extensions: ["*"] }],
      });
    } catch (error) {
      toast.error(`Failed to open save dialog: ${formatTauriError(error)}`);
      return;
    }
    if (!path) return;
    setBusyAction("dump");
    try {
      await invoke("write_minidump", { sessionId, path, fullMemory });
    } catch (error) {
      toast.error(`Failed to create dump: ${formatTauriError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, session, canDump, platform.os]);

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
    lineTablesReadyKey,
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
    handleCreateDump,
    handleAttach,
    canStep,
    canStop,
    canStart,
    canPause,
    canDetach,
    canDump,
  };
} 