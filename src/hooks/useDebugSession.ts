import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DebugSession, Module, Thread, Symbol } from '@/contexts/SessionContext';

export function useDebugSession(sessionId: string | undefined) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "pause" | null
  >(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  const canStep = useMemo(() => session?.status === "Paused", [session]);
  const canStop = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Running", "Paused"].includes(session.status);
  }, [session]);
  const canStart = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Stopped"].includes(session.status);
  }, [session]);

  const canPause = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Running"].includes(session.status);
  }, [session]);

  const loadModules = useCallback(async () => {
    if (!sessionId) return [];
    try {
      return await invoke<Module[]>("get_session_modules", { sessionId });
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
      return await invoke<Thread[]>("get_session_threads", { sessionId });
    } catch (error) {
      const errorMessage = `Failed to load threads: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      return [];
    }
  }, [sessionId]);

  const searchSymbols = useCallback(async (pattern: string, limit?: number) => {
    if (!sessionId) return [];
    try {
      return await invoke<Symbol[]>("search_session_symbols", { 
        sessionId, 
        pattern, 
        limit: limit || 30 
      });
    } catch (error) {
      const errorMessage = `Failed to search symbols: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      return [];
    }
  }, [sessionId]);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await invoke<DebugSession>("get_debug_session", { sessionId });
      setSession(result);
    } catch (error) {
      const errorMessage = `Failed to load session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
      setSession(null);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const handleSessionUpdate = useCallback((newSession: DebugSession) => {
    setSession(newSession);
  }, []);

  useEffect(() => {
    loadSession();

    const listenToSessionUpdates = async () => {
      const unlisten = await listen<DebugSession>(
        "session-updated",
        (event) => {
          if (event.payload.id === sessionId) {
            handleSessionUpdate(event.payload);
          }
        }
      );
      return unlisten;
    };

    const unlistenPromise = listenToSessionUpdates();

    return () => {
      unlistenPromise.then(unlisten => {
        if (unlisten) unlisten();
      });
    };
  }, [sessionId, loadSession, handleSessionUpdate]);

  useEffect(() => {
    let isCancelled = false;

    if (session?.status === "Paused") {
      const fetchData = async () => {
        const [mods, thrs] = await Promise.all([loadModules(), loadThreads()]);
        if (!isCancelled) {
          setModules(mods);
          setThreads(thrs);
        }
      };
      fetchData();
    } else if (session?.status === "Stopped" || typeof session?.status === 'object') {
      setModules([]);
      setThreads([]);
    }

    return () => {
      isCancelled = true;
    };
  }, [session, loadModules, loadThreads]);

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
          const mods = await loadModules();
          setModules(mods);
        }
      );
      unlistenLoad = await listen<{ session_id: string; pid: number; tid: number; dll_name: string; base_of_dll: number; size_of_dll?: number }>(
        "dll-loaded",
        async (event) => {
          if (event.payload.session_id !== sessionId) return;
          const mods = await loadModules();
          setModules(mods);
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
      // The session-updated event will refresh the state
    } catch (error) {
      const errorMessage = `Failed to step session: ${error}`;
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

  return {
    session,
    isLoading,
    busyAction,
    modules,
    threads,
    loadModules,
    loadThreads,
    searchSymbols,
    handleGo,
    handleStepIn,
    handleStepOut,
    handleStepOver,
    handleStop,
    handleStart,
    handlePause,
    canStep,
    canStop,
    canStart,
    canPause,
  };
} 