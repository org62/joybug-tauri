import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DebugSession, Module, Thread, Symbol } from '@/contexts/SessionContext';

export function useDebugSession(sessionId: string | undefined) {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSteppingIn, setIsSteppingIn] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  const canStep = useMemo(() => session?.status === "Paused", [session]);
  const canStop = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Connecting", "Connected", "Running", "Paused"].includes(session.status);
  }, [session]);
  const canStart = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Created", "Finished"].includes(session.status);
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
    } else if (session?.status === "Finished" || typeof session?.status === 'object') {
      setModules([]);
      setThreads([]);
    }

    return () => {
      isCancelled = true;
    };
  }, [session, loadModules, loadThreads]);

  const handleGo = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setIsProcessing(true);
    try {
      await invoke("step_debug_session", { sessionId });
      // The session-updated event will refresh the state
    } catch (error) {
      const errorMessage = `Failed to step session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [sessionId, canStep]);

  const handleStepIn = useCallback(async () => {
    if (!sessionId || !canStep) return;
    setIsSteppingIn(true);
    try {
      await invoke("step_in_debug_session", { sessionId });
      // The session-updated event will refresh the state
    } catch (error) {
      const errorMessage = `Failed to step in session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setIsSteppingIn(false);
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
    setIsStopping(true);
    try {
      await invoke("stop_debug_session", { sessionId });
      toast.success("Debug session stopped");
    } catch (error) {
      const errorMessage = `Failed to stop session: ${error}`;
      toast.error(errorMessage);
      console.error(errorMessage);
    } finally {
      setIsStopping(false);
    }
  }, [sessionId, canStop]);

  return {
    session,
    isLoading,
    isProcessing,
    isSteppingIn,
    isStopping,
    modules,
    threads,
    loadModules,
    loadThreads,
    searchSymbols,
    handleGo,
    handleStepIn,
    handleStop,
    handleStart,
    canStep,
    canStop,
    canStart,
  };
} 