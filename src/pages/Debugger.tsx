import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, Eye, Pencil, Trash2, XSquare, FileCode2 } from "lucide-react";
import { toast } from "sonner";
import { 
  loadSessionsFromStorage, 
  addSessionToStorage, 
  updateSessionInStorage, 
  removeSessionFromStorage,
  sessionToConfig,
  syncSessionsToStorage 
} from "@/lib/sessionStorage";

const DEFAULT_SESSION_NAME = "Unnamed Session";

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
}

type SessionStatus = 
  | "Created"
  | "Connecting" 
  | "Connected"
  | "Running"
  | "Paused"
  | "Finished"
  | { Error: string };

export default function Debugger() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<DebugSession[]>([]);
  const [sessionToEdit, setSessionToEdit] = useState<DebugSession | null>(null);
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  
  // Form state for dialog
  const [formName, setFormName] = useState("");
  const [formServerUrl, setFormServerUrl] = useState("127.0.0.1:9000");
  const [formLaunchCommand, setFormLaunchCommand] = useState("cmd.exe /c echo Hello World!");

  // Load sessions from backend with storage restoration
  const loadSessions = async () => {
    try {
      const sessionList = await invoke<DebugSession[]>("get_debug_sessions");
      setSessions(sessionList);
      
      // Sync storage with current sessions
      const sessionConfigs = sessionList.map(sessionToConfig);
      syncSessionsToStorage(sessionConfigs);
    } catch (error) {
      console.error("Failed to load debug sessions:", error);
      toast.error(`Failed to load debug sessions: ${error}`);
    }
  };

  // Restore sessions from storage on app startup
  const restoreSessionsFromStorage = async () => {
    try {
      const storedSessions = loadSessionsFromStorage();
      
      // First, get existing sessions from backend
      const existingSessions = await invoke<DebugSession[]>("get_debug_sessions");
      const existingIds = new Set(existingSessions.map(s => s.id));
      
      // Create sessions in backend from stored configs that don't already exist
      for (const config of storedSessions) {
        if (!existingIds.has(config.id)) {
          try {
            await invoke("create_debug_session", {
              name: config.name,
              serverUrl: config.server_url,
              launchCommand: config.launch_command,
            });
          } catch (error) {
            console.warn(`Failed to restore session ${config.name}:`, error);
          }
        }
      }
      
      // Load current state from backend
      await loadSessions();
    } catch (error) {
      console.error("Failed to restore sessions from storage:", error);
      // Fall back to just loading current sessions
      await loadSessions();
    }
  };

  // Initial load - restore sessions from storage
  useEffect(() => {
    restoreSessionsFromStorage();
  }, []);

  // Auto-refresh sessions every 1 second
  useEffect(() => {
    const interval = setInterval(loadSessions, 1000);
    return () => clearInterval(interval);
  }, []);

  // Handle Ctrl+O to open new session dialog
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Use metaKey for Command key on macOS
      if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
        event.preventDefault();
        handleOpenNewSessionDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Empty dependency array ensures this runs only once

  const handleOpenNewSessionDialog = () => {
    setSessionToEdit(null);
    setFormName("");
    setFormServerUrl("127.0.0.1:9000");
    setFormLaunchCommand("cmd.exe /c echo Hello World!");
    setIsSessionDialogOpen(true);
  };

  const handleOpenEditSessionDialog = (session: DebugSession) => {
    setSessionToEdit(session);
    setFormName(session.name === DEFAULT_SESSION_NAME ? "" : session.name);
    setFormServerUrl(session.server_url);
    setFormLaunchCommand(session.launch_command);
    setIsSessionDialogOpen(true);
  };

  const handleCreateSession = async () => {
    const sessionName = formName.trim() || DEFAULT_SESSION_NAME;

    try {
      const sessionId = await invoke<string>("create_debug_session", {
        name: sessionName,
        serverUrl: formServerUrl,
        launchCommand: formLaunchCommand,
      });

      // Save session config to storage
      addSessionToStorage({
        id: sessionId,
        name: sessionName,
        server_url: formServerUrl,
        launch_command: formLaunchCommand,
        created_at: new Date().toISOString(),
      });

      toast.success("Debug session created successfully");
      setIsSessionDialogOpen(false);
      
      // Clear form
      setFormName("");
      setFormServerUrl("127.0.0.1:9000");
      setFormLaunchCommand("cmd.exe /c echo Hello World!");
      
      // Note: Auto-refresh will pick up the new session within 2 seconds
      
      return sessionId;
    } catch (error) {
      console.error("Failed to create debug session:", error);
      toast.error(error as string);
      throw error;
    }
  };

  const handleUpdateSession = async () => {
    if (!sessionToEdit) return;

    const sessionName = formName.trim() || DEFAULT_SESSION_NAME;

    try {
      await invoke("update_debug_session", {
        sessionId: sessionToEdit.id,
        name: sessionName,
        serverUrl: formServerUrl,
        launchCommand: formLaunchCommand,
      });

      // Update session config in storage
      updateSessionInStorage({
        id: sessionToEdit.id,
        name: sessionName,
        server_url: formServerUrl,
        launch_command: formLaunchCommand,
        created_at: sessionToEdit.created_at,
      });

      toast.success("Debug session updated successfully");
      setIsSessionDialogOpen(false);
      setSessionToEdit(null);
      // Auto-refresh will pick up changes
    } catch (error) {
      console.error("Failed to update debug session:", error);
      toast.error(error as string);
      throw error;
    }
  };

  const handleStartSession = async (sessionId: string) => {
    try {
      await invoke("start_debug_session", { sessionId });
      toast.success("Debug session started");
      // Note: Auto-refresh will pick up the status change within 2 seconds
    } catch (error) {
      console.error("Failed to start debug session:", error);
      toast.error(`Failed to start debug session: ${error}`);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    try {
      await invoke("stop_debug_session", { sessionId });
      toast.success("Debug session stopped");
    } catch (error) {
      console.error("Failed to stop debug session:", error);
      toast.error(error as string);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await invoke("delete_debug_session", { sessionId });
      
      // Remove session from storage
      removeSessionFromStorage(sessionId);
      
      toast.success("Debug session deleted");
    } catch (error) {
      console.error("Failed to delete debug session:", error);
      toast.error(error as string);
    }
  };

  const handleCreateAndStart = async () => {
    try {
      const sessionId = await handleCreateSession();
      // Small delay to ensure session is created
      setTimeout(() => {
        handleStartSession(sessionId);
      }, 100);
    } catch (error) {
      // Error already handled in handleCreateSession
    }
  };

  const handleViewSession = (sessionId: string) => {
    navigate(`/session/${sessionId}`);
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
      // Error case
      return <Badge variant="destructive">Error</Badge>;
    }
  };

  const getStatusDescription = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Created":
          return "Session created, ready to start";
        case "Connecting":
          return "Connecting to debug server...";
        case "Connected":
          return "Connected to debug server";
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

  const canStart = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to retry on error
    return ["Created", "Finished"].includes(status);
  };

  const canEdit = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to edit on error
    return ["Created", "Finished"].includes(status);
  };

  const canView = (status: SessionStatus) => {
    if (typeof status === "string") {
      return ["Connected", "Running", "Paused"].includes(status);
    }
    return false;
  };

  const canStop = (status: SessionStatus) => {
    if (typeof status === "string") {
      return ["Connecting", "Connected", "Running", "Paused"].includes(status);
    }
    return false;
  };

  const canDelete = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to delete on error
    return ["Created", "Finished"].includes(status);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Debug Sessions</h1>
            <p className="text-muted-foreground">Manage your debug sessions</p>
          </div>
          
          <Dialog open={isSessionDialogOpen} onOpenChange={setIsSessionDialogOpen}>
            <DialogTrigger asChild>
              <Button variant={sessions.length > 0 ? "default" : "outline"} className="flex items-center gap-2" onClick={handleOpenNewSessionDialog}>
                <Plus className="h-4 w-4" />
                New Session
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>{sessionToEdit ? "Edit Debug Session" : "Create New Debug Session"}</DialogTitle>
                <DialogDescription>
                  {sessionToEdit 
                    ? "Update the details for this debug session."
                    : "Configure a new debug session with server connection and launch command"
                  }
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="sessionName">Session Name</Label>
                  <Input
                    id="sessionName"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="My Debug Session"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="serverUrl">Debug Server URL</Label>
                  <Input
                    id="serverUrl"
                    value={formServerUrl}
                    onChange={(e) => setFormServerUrl(e.target.value)}
                    placeholder="127.0.0.1:9000"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="launchCommand">Launch Command</Label>
                  <Input
                    id="launchCommand"
                    value={formLaunchCommand}
                    onChange={(e) => setFormLaunchCommand(e.target.value)}
                    placeholder="cmd.exe /c echo Hello World!"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsSessionDialogOpen(false)}>
                  Cancel
                </Button>
                {sessionToEdit ? (
                  <Button onClick={() => handleUpdateSession().catch(() => {})}>Update Session</Button>
                ) : (
                  <>
                    <Button onClick={() => handleCreateSession().catch(() => { /* error already toasted */})}>
                      Create Session
                    </Button>
                    <Button onClick={handleCreateAndStart} variant="default">
                      Create & Start
                    </Button>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center text-center">
              <FileCode2 className="h-12 w-12 mb-4 text-muted-foreground opacity-40" />
              <h2 className="text-xl font-semibold text-muted-foreground mb-2">No debug sessions yet</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Create your first debug session to get started
              </p>
              <Button onClick={handleOpenNewSessionDialog} className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Create Session
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {sessions
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
              .map((session) => (
              <Card key={session.id} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-xl">{session.name}</CardTitle>
                        {getStatusBadge(session.status)}
                      </div>
                      <CardDescription className="mt-1">
                        {getStatusDescription(session.status)}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="icon" onClick={() => handleStartSession(session.id)} disabled={!canStart(session.status)} title="Start">
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleStopSession(session.id)} disabled={!canStop(session.status)} title="Stop">
                        <XSquare className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleOpenEditSessionDialog(session)} disabled={!canEdit(session.status)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant={canView(session.status) ? "default" : "ghost"} size="icon" onClick={() => handleViewSession(session.id)} disabled={!canView(session.status)} title="View">
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <span tabIndex={canDelete(session.status) ? 0 : -1}>
                            <Button variant="ghost" size="icon" disabled={!canDelete(session.status)} title="Delete">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </span>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Are you sure?</DialogTitle>
                            <DialogDescription>
                              This action will permanently delete the session "{session.name}".
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button variant="outline">Cancel</Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button
                                variant="destructive"
                                onClick={() => handleDeleteSession(session.id)}
                              >
                                Delete
                              </Button>
                            </DialogClose>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div>
                      <strong>Server:</strong> {session.server_url}
                    </div>
                    <div>
                      <strong>Command:</strong> {session.launch_command}
                    </div>
                    <div>
                      <strong>Created:</strong> {session.created_at}
                    </div>
                    {session.current_event && (
                      <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-md">
                        <div className="font-medium">Current Event:</div>
                        <div className="text-sm text-muted-foreground">
                          {session.current_event.event_type} - {session.current_event.details}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
} 