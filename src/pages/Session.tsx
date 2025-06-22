import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Square, ChevronRight, AlertCircle, Layers, Cpu } from "lucide-react";
import { toast } from "sonner";
import { AssemblyView } from "@/components/AssemblyView";

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

// Event payload for session updates
interface SessionUpdatePayload {
  session_id: string;
  status: SessionStatus;
  current_event?: DebugEventInfo | null;
}

export default function Session() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  
  const [session, setSession] = useState<DebugSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStepping, setIsStepping] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [modules, setModules] = useState<Module[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeTab, setActiveTab] = useState("overview");
  
  // Refs for cleanup
  const unlistenRef = useRef<(() => void) | null>(null);

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

  // Handle session update events from backend
  const handleSessionUpdate = (sessionData: DebugSession | SessionUpdatePayload) => {
    if (!sessionId) return;
    
    // Check if this update is for the current session
    const updateSessionId = 'session_id' in sessionData ? sessionData.session_id : sessionData.id;
    if (updateSessionId !== sessionId) return;
    
    setSession(currentSession => {
      if (!currentSession) return currentSession;
      
      // If it's a SessionUpdatePayload, merge with current session
      if ('session_id' in sessionData) {
        return {
          ...currentSession,
          status: sessionData.status,
          current_event: sessionData.current_event !== undefined ? sessionData.current_event : currentSession.current_event
        };
      }
      
      // If it's a full DebugSession, replace entirely
      return sessionData as DebugSession;
    });
  };

  // Initial load and event listener setup
  useEffect(() => {
    const setupSession = async () => {
      setIsLoading(true);
      
      // Load initial session data
      await loadSession();
      
      // Set up event listener for session updates
      try {
        const unlisten = await listen<DebugSession | SessionUpdatePayload>("session-updated", (event) => {
          console.log("Received session update:", event.payload);
          handleSessionUpdate(event.payload);
        });
        unlistenRef.current = unlisten;
      } catch (error) {
        console.error("Failed to set up session update listener:", error);
        toast.error("Failed to set up real-time updates");
      }
      
      setIsLoading(false);
    };
    
    setupSession();

    // Cleanup on unmount
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [sessionId]);

  // Load tab-specific data when tab changes
  useEffect(() => {
    if (activeTab === "modules") {
      loadModules();
    } else if (activeTab === "threads") {
      loadThreads();
    }
  }, [activeTab, sessionId]);

  // Handle F8 to step
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F8') {
        event.preventDefault();
        if (session && canStep(session.status, session.current_event)) {
          handleStep();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [session]); // Dependency on session to get the latest status

  const handleStep = async () => {
    if (!sessionId) return;
    
    try {
      setIsStepping(true);
      await invoke("step_debug_session", { sessionId });
      toast.success("Debug step sent");
      
      // No need to manually refresh - the backend will emit an event
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
      
      // No need to manually refresh - the backend will emit an event
    } catch (error) {
      console.error("Failed to stop debug session:", error);
      toast.error(`Failed to stop debug session: ${error}`);
    } finally {
      setIsStopping(false);
    }
  };

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

  const getStatusDescription = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Created":
          return "Session created, not started yet";
        case "Connecting":
          return "Connecting to debug server...";
        case "Connected":
          return "Connected, waiting for debug events";
        case "Running":
          return "Debug session is running";
        case "Paused":
          return "Debug session is paused on an event";
        case "Finished":
          return "Debug session has finished";
        default:
          return status;
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

  const getEventTypeColor = (eventType: string) => {
    switch (eventType) {
      case "ProcessCreated":
        return "bg-green-100 text-green-800 border-green-200";
      case "ProcessExited":
        return "bg-red-100 text-red-800 border-red-200";
      case "ThreadCreated":
        return "bg-blue-100 text-blue-800 border-blue-200";
      case "ThreadExited":
        return "bg-gray-100 text-gray-800 border-gray-200";
      case "DllLoaded":
        return "bg-purple-100 text-purple-800 border-purple-200";
      case "DllUnloaded":
        return "bg-pink-100 text-pink-800 border-pink-200";
      case "Breakpoint":
        return "bg-orange-100 text-orange-800 border-orange-200";
      case "Exception":
        return "bg-red-100 text-red-800 border-red-200";
      case "Output":
        return "bg-cyan-100 text-cyan-800 border-cyan-200";
      case "RipEvent":
        return "bg-yellow-100 text-yellow-800 border-yellow-200";
      default:
        return "bg-gray-100 text-gray-800 border-gray-200";
    }
  };

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

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-8 w-8 border-2 border-current border-t-transparent rounded-full" />
            <span className="ml-2">Loading session...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!sessionId || !session) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto text-center">
          <div className="flex items-center justify-center mb-4">
            <AlertCircle className="h-12 w-12 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-red-600 mb-2">Session Not Found</h1>
          <p className="text-muted-foreground mb-4">
            The requested debug session could not be found or has been removed.
          </p>
          <Button onClick={() => navigate("/debugger")} className="mt-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Debugger
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => navigate("/debugger")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold">{session.name}</h1>
                {getStatusBadge(session.status)}
              </div>
              <p className="text-muted-foreground">{getStatusDescription(session.status)}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {canStep(session.status, session.current_event) && (
              <Button
                onClick={handleStep}
                disabled={isStepping}
                variant="default"
              >
                <ChevronRight className="h-4 w-4 mr-2" />
                {isStepping ? "Stepping..." : "Step"}
              </Button>
            )}
            
            {canStop(session.status) && (
              <Button
                onClick={handleStop}
                disabled={isStopping}
                variant="destructive"
              >
                <Square className="h-4 w-4 mr-2" />
                {isStopping ? "Stopping..." : "Stop"}
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="modules" className="flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Modules
            </TabsTrigger>
            <TabsTrigger value="threads" className="flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              Threads
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* Session Info */}
            <Card>
              <CardHeader>
                <CardTitle>Session Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <strong>Server URL:</strong> {session.server_url}
                  </div>
                  <div>
                    <strong>Created:</strong> {session.created_at}
                  </div>
                  <div className="col-span-2">
                    <strong>Launch Command:</strong> {session.launch_command}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Current Debug Event */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Current Debug Event</CardTitle>
                  {session.current_event && (
                    <Badge 
                      variant="outline"
                      className={`${getEventTypeColor(session.current_event.event_type)} border`}
                    >
                      {session.current_event.event_type}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {session.current_event ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <strong>Process ID:</strong> {session.current_event.process_id}
                      </div>
                      <div>
                        <strong>Thread ID:</strong> {session.current_event.thread_id}
                      </div>
                    </div>
                    
                    <div>
                      <strong>Details:</strong>
                      <div className="mt-1 p-3 bg-gray-50 dark:bg-gray-900 rounded-md font-mono text-sm">
                        {session.current_event.details}
                      </div>
                    </div>
                    
                    {canStep(session.status, session.current_event) && (
                      <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md">
                        <div className="flex-1 text-sm">
                          This event can be continued. Click the "Step" button to proceed to the next debug event.
                        </div>
                        <Button
                          onClick={handleStep}
                          disabled={isStepping}
                          size="sm"
                        >
                          <ChevronRight className="h-4 w-4 mr-1" />
                          {isStepping ? "Stepping..." : "Step"}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    {session.status === "Created" && (
                      <div>
                        <p>Session created but not started yet.</p>
                        <p className="text-sm mt-1">Go back to the Debugger page to start this session.</p>
                      </div>
                    )}
                    {session.status === "Connecting" && (
                      <div className="flex items-center justify-center gap-2">
                        <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                        <span>Connecting to debug server...</span>
                      </div>
                    )}
                    {session.status === "Connected" && (
                      <div className="flex items-center justify-center gap-2">
                        <div className="animate-pulse h-4 w-4 bg-blue-500 rounded-full" />
                        <span>Waiting for first debug event...</span>
                      </div>
                    )}
                    {session.status === "Running" && (
                      <div className="flex items-center justify-center gap-2">
                        <div className="animate-spin h-4 w-4 border-2 border-green-500 border-t-transparent rounded-full" />
                        <span>Debug session is running, waiting for next event...</span>
                      </div>
                    )}
                    {session.status === "Finished" && (
                      <div>
                        <p>Debug session has finished.</p>
                        <p className="text-sm mt-1">No more debug events will be received.</p>
                      </div>
                    )}
                    {typeof session.status !== "string" && (
                      <div className="text-red-600">
                        <p>Session encountered an error:</p>
                        <p className="text-sm mt-1 font-mono">{session.status.Error}</p>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Disassembly View */}
            <h1>Disassembly</h1>
            {session.current_event?.address && (
              <AssemblyView sessionId={session.id} address={session.current_event.address} />
            )}

            {/* Controls Help */}
            <Card>
              <CardHeader>
                <CardTitle>Controls</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <ChevronRight className="h-4 w-4" />
                    <strong>Step:</strong> Continue execution to the next debug event (only available when paused)
                  </div>
                  <div className="flex items-center gap-2">
                    <Square className="h-4 w-4" />
                    <strong>Stop:</strong> Terminate the debug session completely
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="modules" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Loaded Modules</CardTitle>
              </CardHeader>
              <CardContent>
                {modules.length > 0 ? (
                  <div className="space-y-4">
                    {modules.map((module, index) => (
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
                  <div className="text-center py-8 text-muted-foreground">
                    <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No modules loaded yet.</p>
                    <p className="text-sm mt-1">Modules will appear here as they are loaded during debugging.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="threads" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Active Threads</CardTitle>
              </CardHeader>
              <CardContent>
                {threads.length > 0 ? (
                  <div className="space-y-4">
                    {threads.map((thread, index) => (
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
                  <div className="text-center py-8 text-muted-foreground">
                    <Cpu className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No threads found.</p>
                    <p className="text-sm mt-1">Threads will appear here as they are created during debugging.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
} 