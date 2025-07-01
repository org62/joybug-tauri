import React, { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Square, ChevronRight, AlertCircle, Play, Pause, Layers, Cpu } from "lucide-react";
import { toast } from "sonner";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { AssemblyView } from "@/components/AssemblyView";
import { RegisterView, SerializableThreadContext } from "@/components/RegisterView";
import { DebuggerDockingConfig } from "@/lib/dockingConfigs";
import { TabData, LayoutData } from "rc-dock";

interface DebugSession {
  id: string;
  name: string;
  server_url: string;
  launch_command: string;
  status: SessionStatus;
  current_event: DebugEventInfo | null;
  created_at: string;
}

interface DebugEventInfo {
  event_type: string;
  process_id: number;
  thread_id: number;
  details: string;
  can_continue: boolean;
  address?: number;
  context?: SerializableThreadContext;
}

interface Module {
  name: string;
  base_address: string;
  size: number;
  path: string;
}

interface Thread {
  id: number;
  status: string;
  start_address: string;
}

type SessionStatus = 
  | "Created"
  | "Connecting" 
  | "Connected"
  | "Running"
  | "Paused"
  | "Finished"
  | { Error: string };

interface SessionUpdatePayload {
  session_id: string;
  status: SessionStatus;
  current_event?: DebugEventInfo | null;
}

// Context for session data
interface SessionContextData {
  session: DebugSession | null;
  modules: Module[];
  threads: Thread[];
  loadModules: () => Promise<void>;
  loadThreads: () => Promise<void>;
}

const SessionContext = createContext<SessionContextData | null>(null);

// Hook to use session context
const useSessionContext = () => {
  const context = useContext(SessionContext);
  return context;
};

export default function SessionDocked() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStepping, setIsStepping] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  
  const dockingRef = useRef<DockingLayoutRef>(null);
  const unlistenSessionRef = useRef<(() => void) | null>(null);

const loadModules = async () => {
  if (!sessionId) return;
  
  try {
    const moduleData = await invoke<Module[]>("get_session_modules", { sessionId });
    setModules(moduleData);
  } catch (error) {
    console.error("Failed to load modules:", error);
    toast.error(`Failed to load modules: ${error}`);
  }
};

const loadThreads = async () => {
  if (!sessionId) return;
  
  try {
    const threadData = await invoke<Thread[]>("get_session_threads", { sessionId });
    setThreads(threadData);
  } catch (error) {
    console.error("Failed to load threads:", error);
    toast.error(`Failed to load threads: ${error}`);
  }
};

// Context-aware components that automatically update when session changes
const ContextAssemblyView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  console.log('ContextAssemblyView - sessionData:', sessionData);
  console.log('ContextAssemblyView - currentEvent:', currentEvent);
  if (currentEvent?.address && sessionData?.session?.id) {
    return <AssemblyView sessionId={sessionData.session.id} address={currentEvent.address} />;
  }
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 mx-auto mb-3 opacity-50" />
          <p className="text-base font-medium">No disassembly available</p>
          <p className="text-sm mt-1">Address information will appear here when debugging</p>
        </div>
      </div>
    );
};

const ContextRegisterView = () => {
  const sessionData = useSessionContext();
  const currentEvent = sessionData?.session?.current_event;
  console.log('ContextRegisterView - sessionData:', sessionData);
  console.log('ContextRegisterView - currentEvent:', currentEvent);
  if (currentEvent?.context) {
    return <RegisterView context={currentEvent.context} />;
  }
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <div className="text-center">
        <AlertCircle className="h-8 w-8 mx-auto mb-3 opacity-50" />
        <p className="text-base font-medium">No register data available</p>
        <p className="text-sm mt-1">Register values will appear here when debugging</p>
      </div>
    </div>
  );
};

const ContextModulesView = () => {
  const sessionData = useSessionContext();
  
  // Load modules when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadModules();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const formatBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  return (
    <div className="h-full overflow-auto p-4">
      {sessionData?.modules && sessionData.modules.length > 0 ? (
        <div className="space-y-4">
          {sessionData.modules.map((module, index) => (
            <div 
              key={index}
              className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold">{module.name}</h3>
                  <Badge variant="outline" className="text-xs">
                    {formatBytes(module.size)}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mb-1">
                  Base Address: <span className="font-mono">{module.base_address}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {module.path}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No modules loaded yet</p>
            <p className="text-sm mt-1">Modules will appear here as they are loaded during debugging</p>
          </div>
        </div>
      )}
    </div>
  );
};

const ContextThreadsView = () => {
  const sessionData = useSessionContext();
  
  // Load threads when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadThreads();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const getThreadStatusColor = (status: string) => {
    switch (status) {
      case "Running":
        return "bg-green-100 text-green-800 border-green-200";
      case "Suspended":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "Waiting":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "Terminated":
        return "bg-red-100 text-red-800 border-red-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      {sessionData?.threads && sessionData.threads.length > 0 ? (
        <div className="space-y-4">
          {sessionData.threads.map((thread, index) => (
            <div 
              key={index}
              className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold">Thread {thread.id}</h3>
                  <Badge 
                    variant="outline" 
                    className={`${getThreadStatusColor(thread.status)} border text-xs`}
                  >
                    {thread.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  Start Address: <span className="font-mono">{thread.start_address}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No threads found</p>
            <p className="text-sm mt-1">Threads will appear here as they are created during debugging</p>
          </div>
        </div>
      )}
    </div>
  );
};

// Static tab content - components will update via context
const dynamicTabContent = useMemo(() => ({
  disassembly: <ContextAssemblyView />,
  registers: <ContextRegisterView />,
  modules: <ContextModulesView />,
  threads: <ContextThreadsView />,
}), []);

// Create docking configuration with dynamic content  
const dockingConfig = useMemo(() => {
  const sessionTabContents: { [key: string]: TabData } = {
    disassembly: {
      id: "disassembly",
      title: "Disassembly",
      content: dynamicTabContent.disassembly,
      closable: true,
    },
    registers: {
      id: "registers",
      title: "Registers",
      content: dynamicTabContent.registers,
      closable: true,
    },
    modules: {
      id: "modules",
      title: "Modules",
      content: dynamicTabContent.modules,
      closable: true,
    },
    threads: {
      id: "threads",
      title: "Threads",
      content: dynamicTabContent.threads,
      closable: true,
    },
  };

  return {
    storagePrefix: "session-debugger-dock", // Shared prefix for all sessions to preserve layout
    initialLayout: DebuggerDockingConfig.initialLayout,
    initialTabContents: sessionTabContents,
    tabContentMap: { ...DebuggerDockingConfig.tabContentMap, ...dynamicTabContent },
  };
}, [sessionId, dynamicTabContent]);

const loadSession = async () => {
  if (!sessionId) return;
  
  try {
    const sessionData = await invoke<DebugSession | null>("get_debug_session", { sessionId });
    setSession(sessionData);
  } catch (error) {
    console.error("Failed to load debug session:", error);
    toast.error(`Failed to load debug session: ${error}`);
  }
};

const handleSessionUpdate = (sessionData: DebugSession | SessionUpdatePayload) => {
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
};

const handleStep = async () => {
  if (!sessionId) return;
  
  try {
    setIsStepping(true);
    await invoke("step_debug_session", { sessionId });
  } catch (error) {
    console.error("Failed to step debug session:", error);
    toast.error(`Failed to step debug session: ${error}`);
  } finally {
    setIsStepping(false);
  }
};

const handleStop = async () => {
  if (!sessionId) return;
  
  try {
    setIsStopping(true);
    await invoke("stop_debug_session", { sessionId });
    toast.success("Debug session stopped");
  } catch (error) {
    console.error("Failed to stop debug session:", error);
    toast.error(`Failed to stop debug session: ${error}`);
  } finally {
    setIsStopping(false);
  }
};

// Hotkey handlers
useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'F8') {
      event.preventDefault();
      if (session && canStep(session.status, session.current_event)) {
        handleStep();
      }
    }
    
    if (!event.ctrlKey) return;

    switch (event.key.toLowerCase()) {
      case 'd':
        event.preventDefault();
        dockingRef.current?.toggleTab("disassembly");
        break;
      case 'r':
        event.preventDefault();
        dockingRef.current?.toggleTab("registers");
        break;
      case 'm':
        event.preventDefault();
        dockingRef.current?.toggleTab("modules");
        break;
      case 't':
        event.preventDefault();
        dockingRef.current?.toggleTab("threads");
        break;
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [session]);

// Initial setup and event listeners
useEffect(() => {
  const setupSession = async () => {
    setIsLoading(true);
    
    await loadSession();
    
    try {
      const unlistenSession = await listen<DebugSession | SessionUpdatePayload>("session-updated", (event) => {
        console.log("Received session update:", event.payload);
        handleSessionUpdate(event.payload);
      });
      unlistenSessionRef.current = unlistenSession;
    } catch (error) {
      console.error("Failed to set up session update listener:", error);
      toast.error("Failed to set up real-time updates");
    }
    
    setIsLoading(false);
  };
  
  setupSession();

  return () => {
    if (unlistenSessionRef.current) {
      unlistenSessionRef.current();
      unlistenSessionRef.current = null;
    }
  };
}, [sessionId]);

const getStatusBadge = (status: SessionStatus) => {
  if (typeof status === "string") {
    switch (status) {
      case "Created":
        return <Badge variant="secondary">Created</Badge>;
      case "Connecting":
        return <Badge variant="outline" className="animate-pulse">Connecting...</Badge>;
      case "Connected":
        return <Badge variant="default" className="bg-blue-600">Connected</Badge>;
      case "Running":
        return <Badge variant="default" className="bg-green-600 animate-pulse">Running</Badge>;
      case "Paused":
        return <Badge variant="default" className="bg-yellow-600">Paused</Badge>;
      case "Finished":
        return <Badge variant="outline">Finished</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  } else {
    return <Badge variant="destructive">Error</Badge>;
  }
};

const getStatusDescription = (status: SessionStatus | undefined) => {
  if (!status) return "Unknown";
  
  if (typeof status === "string") {
    switch (status) {
      case "Created": return "Session created, not started yet";
      case "Connecting": return "Connecting to debug server...";
      case "Connected": return "Connected, waiting for debug events";
      case "Running": return "Debug session is running";
      case "Paused": return "Debug session is paused on an event";
      case "Finished": return "Debug session has finished";
      default: return status;
    }
  } else {
    return `Error: ${status.Error}`;
  }
};

const canStep = (status: SessionStatus, currentEvent: DebugEventInfo | null) => {
  if (typeof status === "string") {
    return status === "Paused" && currentEvent?.can_continue === true;
  }
  return false;
};

const canStop = (status: SessionStatus) => {
  if (typeof status === "string") {
    return ["Connected", "Running", "Paused"].includes(status);
  }
  return false;
};

if (isLoading) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="flex items-center gap-2">
        <div className="animate-spin h-6 w-6 border-2 border-current border-t-transparent rounded-full" />
        <span>Loading session...</span>
      </div>
    </div>
  );
}

if (!sessionId || !session) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-center">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-500" />
        <h1 className="text-2xl font-bold text-red-600 mb-2">Session Not Found</h1>
        <p className="text-muted-foreground mb-4">
          The requested debug session could not be found or has been removed.
        </p>
        <Button onClick={() => navigate("/debugger")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Debugger
        </Button>
      </div>
    </div>
  );
}

return (
  <SessionContext.Provider value={{
    session,
    modules,
    threads,
    loadModules,
    loadThreads
  }}>
    <div
      style={{
        position: "absolute",
        left: 10,
        top: 80,
        right: 10,
        bottom: 10,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: "0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Button variant="outline" size="sm" onClick={() => navigate("/debugger")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <h1 className="text-xl font-bold">{session.name}</h1>
            {getStatusBadge(session.status)}
          </div>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {canStep(session.status, session.current_event) && (
            <Button
              onClick={handleStep}
              disabled={isStepping}
              size="sm"
              variant="default"
            >
              <ChevronRight className="h-4 w-4 mr-2" />
              {isStepping ? "Stepping..." : "Step (F8)"}
            </Button>
          )}
          
          {canStop(session.status) && (
            <Button
              onClick={handleStop}
              disabled={isStopping}
              size="sm"
              variant="destructive"
            >
              <Square className="h-4 w-4 mr-2" />
              {isStopping ? "Stopping..." : "Stop"}
            </Button>
          )}

          <div style={{ display: "flex", gap: "0.25rem", marginLeft: "0.5rem" }}>
            <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("disassembly")} title="Show Disassembly (Ctrl+D)">
              D
            </Button>
            <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("registers")} title="Show Registers (Ctrl+R)">
              R
            </Button>
            <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("modules")} title="Show Modules (Ctrl+M)">
              M
            </Button>
            <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("threads")} title="Show Threads (Ctrl+T)">
              T
            </Button>
            <Button variant="outline" size="sm" onClick={() => dockingRef.current?.resetLayout()} title="Reset Layout">
              Reset
            </Button>
          </div>
        </div>
      </div>

      {/* Docking Layout */}
      <div style={{ flex: 1, position: "relative" }}>
        <DockingLayout
          ref={dockingRef}
          {...dockingConfig}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
          }}
        />
      </div>
    </div>
  </SessionContext.Provider>
);
} 