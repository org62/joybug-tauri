import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DebugSession, SessionStatus, DebugEventInfo, Module, Thread } from '@/contexts/SessionContext';

interface SessionUpdatePayload {
  session_id: string;
  status: SessionStatus;
  current_event?: DebugEventInfo | null;
}

export const useDebugSession = (sessionId: string | undefined) => {
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStepping, setIsStepping] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const unlistenSessionRef = useRef<(() => void) | null>(null);

  const canStep = useMemo(() => session?.status === "Paused", [session]);
  const canStop = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Connecting", "Connected", "Running", "Paused"].includes(session.status);
  }, [session]);
  const canStart = useMemo(() => {
    if (!session || typeof session.status !== "string") return false;
    return ["Created", "Finished"].includes(session.status);
  }, [session]);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const sessionData = await invoke<DebugSession | null>("get_debug_session", { sessionId });
      setSession(sessionData);
    } catch (error) {
      console.error("Failed to load debug session:", error);
      toast.error(`Failed to load debug session: ${error}`);
    }
  }, [sessionId]);

  const loadModules = useCallback(async () => {
    if (!sessionId) return;
    try {
      const moduleData = await invoke<Module[]>("get_session_modules", { sessionId });
      setModules(moduleData);
    } catch (error) {
      console.error("Failed to load modules:", error);
      toast.error(`Failed to load modules: ${error}`);
    }
  }, [sessionId]);

  const loadThreads = useCallback(async () => {
    if (!sessionId) return;
    try {
      const threadData = await invoke<Thread[]>("get_session_threads", { sessionId });
      setThreads(threadData);
    } catch (error) {
      console.error("Failed to load threads:", error);
      toast.error(`Failed to load threads: ${error}`);
    }
  }, [sessionId]);

  const handleSessionUpdate = useCallback((sessionData: DebugSession | SessionUpdatePayload) => {
    if (!sessionId) return;

    const updateSessionId = 'session_id' in sessionData ? sessionData.session_id : sessionData.id;
    if (updateSessionId !== sessionId) return;

    setSession(currentSession => {
      if (!currentSession) return currentSession;
      if ('session_id' in sessionData) {
        return {
          ...currentSession,
          status: sessionData.status,
          current_event: sessionData.current_event !== undefined ? sessionData.current_event : currentSession.current_event
        };
      }
      return sessionData as DebugSession;
    });
  }, [sessionId]);

  const handleStep = useCallback(async () => {
    if (!sessionId || !session || !canStep) return;

    try {
      setIsStepping(true);
      await invoke("step_debug_session", { sessionId });
    } catch (error) {
      console.error("Failed to step debug session:", error);
      toast.error(`Failed to step debug session: ${error}`);
    } finally {
      setIsStepping(false);
    }
  }, [sessionId, session, canStep]);

  const handleStart = useCallback(async () => {
    if (!sessionId || !canStart) return;
    try {
      await invoke("start_debug_session", { sessionId });
      toast.success("Debug session started");
      // The session-updated event will refresh the state
    } catch (error) {
      toast.error(`Failed to start session: ${error}`);
    }
  }, [sessionId, canStart]);

  const handleStop = useCallback(async () => {
    if (!sessionId || !canStop) return;
    setIsStopping(true);
    try {
      await invoke("stop_debug_session", { sessionId });
      toast.success("Debug session stopped");
    } catch (error) {
      console.error("Failed to stop debug session:", error);
      toast.error(`Failed to stop debug session: ${error}`);
    } finally {
      setIsStopping(false);
    }
  }, [sessionId, canStop]);

  useEffect(() => {
    const setupSession = async () => {
      setIsLoading(true);
      await loadSession();
      try {
        const unlistenSession = await listen<DebugSession | SessionUpdatePayload>("session-updated", (event) => {
          handleSessionUpdate(event.payload);
        });
        unlistenSessionRef.current = unlistenSession;
      } catch (error) {
        console.error("Failed to set up session update listener:", error);
        toast.error("Failed to set up real-time updates");
      }
      setIsLoading(false);
    };

    if (sessionId) {
      setupSession();
    } else {
      setIsLoading(false);
    }

    return () => {
      if (unlistenSessionRef.current) {
        unlistenSessionRef.current();
        unlistenSessionRef.current = null;
      }
    };
  }, [sessionId, loadSession, handleSessionUpdate]);

  return {
    session,
    isLoading,
    isStepping,
    isStopping,
    modules,
    threads,
    loadModules,
    loadThreads,
    handleStep,
    handleStop,
    handleStart,
    canStep,
    canStop,
    canStart,
  };
}; 