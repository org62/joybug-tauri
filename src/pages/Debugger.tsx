import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HistoryInput } from "@/components/ui/history-input";
import { pushInputHistory } from "@/lib/inputHistory";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { SessionStatusBadge } from "@/components/session/SessionStatusBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Page } from "@/components/ui/page";
import { Plus, Play, Eye, Pencil, Trash2, XSquare, FileCode2, FolderOpen, Unplug, RefreshCw, Search } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { 
  loadSessionsFromStorage, 
  addSessionToStorage, 
  updateSessionInStorage, 
  removeSessionFromStorage,
  sessionToConfig,
  syncSessionsToStorage,
  touchSessionInStorage,
} from "@/lib/sessionStorage";

import { DebugSession, SessionStatus } from "@/contexts/SessionContext";
import { isProcessAvailable, formatTauriError, moduleBasename, pathDirname, buildLaunchCommand } from "@/lib/sessionHelpers";
import { useFileDrop, pickDroppedFile } from "@/hooks/useFileDrop";
import { FileDropOverlay } from "@/components/FileDropOverlay";

const DEFAULT_SESSION_NAME = "Unnamed Session";

interface ProcessInfo {
  pid: number;
  name: string;
}

export default function Debugger() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<DebugSession[]>([]);
  const [sessionToEdit, setSessionToEdit] = useState<DebugSession | null>(null);
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  
  // Form state for dialog
  const [formName, setFormName] = useState("");
  const [formServerUrl, setFormServerUrl] = useState("127.0.0.1:9000");
  const [formLaunchCommand, setFormLaunchCommand] = useState("cmd.exe /c echo Hello World!");
  const [formWorkingDirectory, setFormWorkingDirectory] = useState("");
  const [formLocalRun, setFormLocalRun] = useState(true);

  // Attach-to-process dialog state
  const [isAttachDialogOpen, setIsAttachDialogOpen] = useState(false);
  const [attachServerUrl, setAttachServerUrl] = useState("");
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [processFilter, setProcessFilter] = useState("");
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [attachingPid, setAttachingPid] = useState<number | null>(null);
  // When true, the chosen process is opened non-invasively (OpenProcess only, no
  // debugger attach) — memory/enumeration/scan features only, no breakpoints/stepping.
  const [attachNonInvasive, setAttachNonInvasive] = useState(false);
  // When set, the attach dialog re-attaches this existing (stopped) session to
  // the chosen PID instead of creating a new session.
  const [attachTargetSessionId, setAttachTargetSessionId] = useState<string | null>(null);

  // Load sessions from backend with storage restoration
  const loadSessions = async () => {
    try {
      const sessionList = await invoke<DebugSession[]>("get_debug_sessions");
      setSessions(sessionList);

      // Sync storage with current sessions. Attach sessions are bound to a live
      // PID that won't exist next launch, so they're never persisted/restored.
      const sessionConfigs = sessionList
        .filter((s) => s.attach_pid == null)
        .map(sessionToConfig);
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

      // Match by content (name + command + mode), not by ID, because IDs change across restarts
      const existingByContent = new Set(
        existingSessions.map(s => `${s.name}\0${s.launch_command}\0${s.is_local_run}`)
      );

      // Create sessions in backend from stored configs that don't already exist
      for (const config of storedSessions) {
        const contentKey = `${config.name}\0${config.launch_command}\0${config.is_local_run}`;
        if (!existingByContent.has(contentKey)) {
          try {
            await invoke("create_debug_session", {
              name: config.name,
              serverUrl: config.server_url,
              launchCommand: config.launch_command,
              workingDirectory: config.working_directory ?? null,
              isLocalRun: config.is_local_run ?? true,
              attachPid: null,
            });
            existingByContent.add(contentKey);
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

  // Initial load - restore sessions from storage (useRef guard prevents StrictMode double-execution)
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    restoreSessionsFromStorage();
  }, []);

  // No polling: updates handled via events and explicit refreshes after actions

  // Live updates via backend events
  useEffect(() => {
    let unlistenUpdated: (() => void) | null = null;
    let unlistenRemoved: (() => void) | null = null;
    const attach = async () => {
      unlistenUpdated = await listen<DebugSession>("session-updated", (event) => {
        const updated = event.payload;
        setSessions((prev) => {
          const index = prev.findIndex((s) => s.id === updated.id);
          if (index === -1) {
            return [updated, ...prev];
          }
          const copy = prev.slice();
          copy[index] = updated;
          return copy;
        });
      });
      unlistenRemoved = await listen<string>("session-removed", (event) => {
        const removedId = event.payload;
        setSessions((prev) => prev.filter((s) => s.id !== removedId));
      });
    };
    attach();
    return () => {
      if (unlistenUpdated) unlistenUpdated();
      if (unlistenRemoved) unlistenRemoved();
    };
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

  const handleBrowseExecutable = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Executables", extensions: ["exe", "com", "bat", "cmd"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (selected) {
        setFormLaunchCommand(buildLaunchCommand(selected));
      }
    } catch (error) {
      console.error("Failed to open file dialog:", error);
      toast.error(`Failed to open file dialog: ${error}`);
    }
  };

  const handleBrowseWorkingDirectory = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
      });
      if (selected) {
        setFormWorkingDirectory(selected);
      }
    } catch (error) {
      console.error("Failed to open directory dialog:", error);
      toast.error(`Failed to open directory dialog: ${error}`);
    }
  };

  const handleOpenNewSessionDialog = () => {
    setSessionToEdit(null);
    setFormName("");
    setFormServerUrl("127.0.0.1:9000");
    setFormLaunchCommand("cmd.exe /c echo Hello World!");
    setFormWorkingDirectory("");
    setFormLocalRun(true);
    setIsSessionDialogOpen(true);
  };

  const handleOpenEditSessionDialog = (session: DebugSession) => {
    setSessionToEdit(session);
    setFormName(session.name === DEFAULT_SESSION_NAME ? "" : session.name);
    setFormServerUrl(session.server_url);
    setFormLaunchCommand(session.launch_command);
    setFormWorkingDirectory(session.working_directory ?? "");
    setFormLocalRun(session.is_local_run);
    setIsSessionDialogOpen(true);
  };

  // Record the launch-form values for ArrowUp/Down recall next time the dialog
  // is used; called only after the backend accepts them.
  const pushLaunchFormHistory = () => {
    pushInputHistory("launch-command", formLaunchCommand);
    pushInputHistory("launch-cwd", formWorkingDirectory);
    if (!formLocalRun) pushInputHistory("server-url", formServerUrl);
  };

  // Backend create + storage persistence, shared by the dialog and the
  // drag-drop path. Returns the new session id.
  const createSessionRecord = async (cfg: {
    name: string;
    serverUrl: string;
    launchCommand: string;
    workingDirectory: string | null;
    isLocalRun: boolean;
  }): Promise<string> => {
    const sessionId = await invoke<string>("create_debug_session", {
      name: cfg.name,
      serverUrl: cfg.serverUrl,
      launchCommand: cfg.launchCommand,
      workingDirectory: cfg.workingDirectory,
      isLocalRun: cfg.isLocalRun,
      attachPid: null,
    });

    addSessionToStorage({
      id: sessionId,
      name: cfg.name,
      server_url: cfg.serverUrl,
      launch_command: cfg.launchCommand,
      working_directory: cfg.workingDirectory,
      is_local_run: cfg.isLocalRun,
      created_at: new Date().toISOString(),
    });

    return sessionId;
  };

  const handleCreateSession = async () => {
    const sessionName = formName.trim() || DEFAULT_SESSION_NAME;

    try {
      const sessionId = await createSessionRecord({
        name: sessionName,
        serverUrl: formLocalRun ? "" : formServerUrl,
        launchCommand: formLaunchCommand,
        workingDirectory: formWorkingDirectory.trim() || null,
        isLocalRun: formLocalRun,
      });

      pushLaunchFormHistory();
      toast.success("Debug session created successfully");
      setIsSessionDialogOpen(false);

      // Clear form
      setFormName("");
      setFormServerUrl("127.0.0.1:9000");
      setFormLaunchCommand("cmd.exe /c echo Hello World!");
      setFormWorkingDirectory("");
      setFormLocalRun(true);

      // Live updates will arrive via events; no manual refresh

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
      const workingDirectory = formWorkingDirectory.trim() || null;

      await invoke("update_debug_session", {
        sessionId: sessionToEdit.id,
        name: sessionName,
        serverUrl: formLocalRun ? "" : formServerUrl,
        launchCommand: formLaunchCommand,
        workingDirectory,
        isLocalRun: formLocalRun,
        attachPid: null,
      });

      // Update session config in storage
      updateSessionInStorage({
        id: sessionToEdit.id,
        name: sessionName,
        server_url: formLocalRun ? "" : formServerUrl,
        launch_command: formLaunchCommand,
        working_directory: workingDirectory,
        is_local_run: formLocalRun,
        created_at: sessionToEdit.created_at,
      });

      pushLaunchFormHistory();
      toast.success("Debug session updated successfully");
      setIsSessionDialogOpen(false);
      setSessionToEdit(null);
      // Live updates will arrive via events; no manual refresh
    } catch (error) {
      console.error("Failed to update debug session:", error);
      toast.error(error as string);
      throw error;
    }
  };

  // Bumped whenever a session's last_used_at changes so the MRU sort re-runs.
  const [lastUsedTick, setLastUsedTick] = useState(0);

  const touchSession = (sessionId: string) => {
    touchSessionInStorage(sessionId);
    setLastUsedTick((t) => t + 1);
  };

  const startAndNavigate = async (sessionId: string) => {
    await invoke("start_debug_session", { sessionId });
    touchSession(sessionId);
    toast.success("Debug session started");
    navigate(`/session/${sessionId}`);
  };

  // Drag-drop an .exe onto the page: create a local-run session (embedded
  // debug server) for it, start it, and jump into the session view.
  const handleFileDrop = async (paths: string[]) => {
    const dropped = pickDroppedFile(paths, {
      pattern: /\.exe$/i,
      rejectMessage: "Only .exe files can be launched — use the PE Viewer for other PE files",
    });
    if (!dropped) return;

    const name = moduleBasename(dropped).replace(/\.exe$/i, "");
    const workingDirectory = pathDirname(dropped) || null;

    try {
      const sessionId = await createSessionRecord({
        name,
        serverUrl: "",
        launchCommand: buildLaunchCommand(dropped),
        workingDirectory,
        isLocalRun: true,
      });
      await startAndNavigate(sessionId);
    } catch (error) {
      console.error("Failed to launch dropped executable:", error);
      toast.error(formatTauriError(error));
    }
  };

  const { isDragOver } = useFileDrop({
    onDrop: handleFileDrop,
    enabled: !isSessionDialogOpen && !isAttachDialogOpen,
  });

  const updateAttachPid = async (session: DebugSession, pid: number) => {
    await invoke("update_debug_session", {
      sessionId: session.id,
      name: session.name,
      serverUrl: session.is_local_run ? "" : session.server_url,
      launchCommand: session.launch_command,
      workingDirectory: session.working_directory ?? null,
      isLocalRun: session.is_local_run,
      attachPid: pid,
      nonInvasive: session.non_invasive,
    });
  };

  const handleStartSession = async (session: DebugSession) => {
    try {
      // Attach sessions: the stored PID may be stale if the target restarted.
      // Keep it if still alive; otherwise resolve by image name — auto-attach a
      // lone match, or let the user pick when several instances are running.
      if (session.attach_pid != null) {
        const serverUrl = session.is_local_run ? null : session.server_url;
        const list = await invoke<ProcessInfo[]>("list_processes", { serverUrl });
        const pidAlive = list.some((p) => p.pid === session.attach_pid);

        if (!pidAlive) {
          const want = session.launch_command.toLowerCase();
          const matches = list.filter((p) => p.name.toLowerCase() === want);

          if (matches.length === 0) {
            toast.error(`"${session.launch_command}" is not running`);
            return;
          }
          if (matches.length === 1) {
            await updateAttachPid(session, matches[0].pid);
          } else {
            // Several instances — let the user choose which one to re-attach to.
            setAttachTargetSessionId(session.id);
            setAttachServerUrl(session.is_local_run ? "" : session.server_url);
            setProcesses(list);
            setProcessFilter(session.launch_command);
            setIsAttachDialogOpen(true);
            return;
          }
        }
      }

      await startAndNavigate(session.id);
    } catch (error) {
      console.error("Failed to start debug session:", error);
      toast.error(`Failed to start debug session: ${error}`);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    try {
      await invoke("stop_debug_session", { sessionId });
      toast.success("Debug session stopped");
      // Live updates will arrive via events; no manual refresh
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
      // Live updates will arrive via events; no manual refresh
    } catch (error) {
      console.error("Failed to delete debug session:", error);
      toast.error(error as string);
    }
  };

  const handleCreateAndStart = async () => {
    try {
      const sessionId = await handleCreateSession();
      if (sessionId) {
        await startAndNavigate(sessionId);
      }
    } catch (error) {
      // Error already handled in handleCreateSession/startAndNavigate
    }
  };

  const handleViewSession = (sessionId: string) => {
    touchSession(sessionId);
    navigate(`/session/${sessionId}`);
  };

  const loadProcesses = async () => {
    setIsLoadingProcesses(true);
    try {
      const serverUrl = attachServerUrl.trim() || null;
      const list = await invoke<ProcessInfo[]>("list_processes", { serverUrl });
      setProcesses(list);
    } catch (error) {
      console.error("Failed to list processes:", error);
      toast.error(`Failed to list processes: ${error}`);
    } finally {
      setIsLoadingProcesses(false);
    }
  };

  const handleOpenAttachDialog = async () => {
    setAttachTargetSessionId(null);
    setProcessFilter("");
    setProcesses([]);
    setAttachNonInvasive(false);
    setIsAttachDialogOpen(true);
    await loadProcesses();
  };

  const handleAttachToProcess = async (proc: ProcessInfo) => {
    const remoteUrl = attachServerUrl.trim();
    pushInputHistory("server-url", remoteUrl);
    setAttachingPid(proc.pid);
    try {
      // Re-attach an existing stopped session, or create a fresh one.
      if (attachTargetSessionId) {
        const existing = sessions.find((s) => s.id === attachTargetSessionId);
        if (existing) {
          await updateAttachPid(existing, proc.pid);
          toast.success(`Re-attaching to ${proc.name} (${proc.pid})`);
          setIsAttachDialogOpen(false);
          setAttachTargetSessionId(null);
          await startAndNavigate(existing.id);
          return;
        }
      }

      const label = attachNonInvasive ? "Open" : "Attach";
      const sessionId = await invoke<string>("create_debug_session", {
        name: `${label}: ${proc.name} (${proc.pid})`,
        serverUrl: remoteUrl,
        launchCommand: proc.name,
        workingDirectory: null,
        isLocalRun: remoteUrl === "",
        attachPid: proc.pid,
        nonInvasive: attachNonInvasive,
      });

      await invoke("start_debug_session", { sessionId });
      toast.success(`${attachNonInvasive ? "Opening" : "Attaching to"} ${proc.name} (${proc.pid})`);
      setIsAttachDialogOpen(false);
      navigate(`/session/${sessionId}`);
    } catch (error) {
      console.error("Failed to attach:", error);
      toast.error(`Failed to attach: ${error}`);
    } finally {
      setAttachingPid(null);
    }
  };

  // Most-recently-used first; sessions never started/viewed fall back to
  // creation time. last_used_at / created_at live in localStorage, at
  // millisecond precision (see sessionStorage.ts).
  const sortedSessions = useMemo(() => {
    // Prefer the storage timestamps (ms precision, UTC ISO) so same-second
    // creations still order correctly; fall back to the backend created_at.
    const timeById = new Map<string, string>();
    for (const config of loadSessionsFromStorage()) {
      const t = config.last_used_at ?? config.created_at;
      if (t) timeById.set(config.id, t);
    }
    // The backend's created_at is UTC formatted WITHOUT a timezone marker
    // ("YYYY-MM-DD HH:MM:SS"), which new Date() would parse as *local* time —
    // shifting it hours away from the UTC-with-Z last_used_at and inverting the
    // order. Parse un-zoned timestamps as UTC so both are on the same clock.
    const toMs = (s?: string | null): number => {
      if (!s) return 0;
      if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s).getTime(); // already zoned
      return new Date(s.replace(" ", "T") + "Z").getTime();
    };
    // Parse once per session, not once per comparison.
    const msById = new Map(sessions.map((s) => [s.id, toMs(timeById.get(s.id) ?? s.created_at)]));
    return [...sessions].sort((a, b) => msById.get(b.id)! - msById.get(a.id)!);
  }, [sessions, lastUsedTick]);

  const filteredProcesses = useMemo(() => {
    const q = processFilter.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter(
      (p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
    );
  }, [processes, processFilter]);

  const getStatusBadge = (status: SessionStatus) => <SessionStatusBadge status={status} />;

  const getStatusDescription = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Stopped":
          return "Session is stopped";
        case "Running":
          return "Debug session is running";
        case "Paused":
          return "Debug session is paused on an event";
        case "Open":
          return "Process opened non-invasively (no debugger attached)";
        default:
          return status;
      }
    } else {
      return `Error: ${status.Error}`;
    }
  };

  const canStart = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to retry on error
    return ["Stopped"].includes(status);
  };

  const canEdit = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to edit on error
    return ["Stopped"].includes(status);
  };

  const canView = (status: SessionStatus) => isProcessAvailable(status);

  const canStop = (status: SessionStatus) => isProcessAvailable(status);

  const canDelete = (status: SessionStatus) => {
    if (typeof status !== "string") return true; // Allow to delete on error
    return ["Stopped"].includes(status);
  };

  return (
    <Page>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Debug Sessions</h1>
            <p className="text-muted-foreground">Manage your debug sessions</p>
          </div>
          
          <div className="flex items-center gap-2">
          <Button variant="outline" className="flex items-center gap-2" onClick={handleOpenAttachDialog}>
            <Unplug className="h-4 w-4" />
            Attach to Process
          </Button>
          <Dialog open={isSessionDialogOpen} onOpenChange={setIsSessionDialogOpen}>
            <DialogTrigger asChild>
              <Button variant={sessions.length > 0 ? "default" : "outline"} className="flex items-center gap-2" onClick={handleOpenNewSessionDialog}>
                <Plus className="h-4 w-4" />
                Create Process
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <DialogTitle>{sessionToEdit ? "Edit Process" : "Create Process"}</DialogTitle>
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
                <div className="flex items-center space-x-2">
                  <Switch
                    id="localRun"
                    checked={formLocalRun}
                    onCheckedChange={(checked: boolean) => setFormLocalRun(checked)}
                  />
                  <Label
                    htmlFor="localRun"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Local Run (start embedded debug server)
                  </Label>
                </div>
                {!formLocalRun && (
                  <div className="space-y-2">
                    <Label htmlFor="serverUrl">Debug Server URL</Label>
                    <HistoryInput
                      historyKey="server-url"
                      id="serverUrl"
                      value={formServerUrl}
                      onChange={(e) => setFormServerUrl(e.target.value)}
                      placeholder="127.0.0.1:9000"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="launchCommand">Launch Command</Label>
                  <div className="flex gap-2">
                    <HistoryInput
                      historyKey="launch-command"
                      id="launchCommand"
                      value={formLaunchCommand}
                      onChange={(e) => setFormLaunchCommand(e.target.value)}
                      placeholder="cmd.exe /c echo Hello World!"
                    />
                    {formLocalRun && (
                      <Button variant="outline" size="icon" onClick={handleBrowseExecutable} title="Browse for executable" type="button">
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="workingDirectory">Working Directory (optional)</Label>
                  <div className="flex gap-2">
                    <HistoryInput
                      historyKey="launch-cwd"
                      id="workingDirectory"
                      value={formWorkingDirectory}
                      onChange={(e) => setFormWorkingDirectory(e.target.value)}
                      placeholder="Defaults to the debugger's directory"
                    />
                    {formLocalRun && (
                      <Button variant="outline" size="icon" onClick={handleBrowseWorkingDirectory} title="Browse for working directory" type="button">
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
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
                    <Button variant="outline" onClick={() => handleCreateSession().catch(() => { /* error already toasted */})}>
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

          <Dialog open={isAttachDialogOpen} onOpenChange={setIsAttachDialogOpen}>
            <DialogContent className="sm:max-w-[560px]">
              <DialogHeader>
                <DialogTitle>{attachNonInvasive ? "Open Running Process" : "Attach to Running Process"}</DialogTitle>
                <DialogDescription>
                  {attachNonInvasive
                    ? "Pick a process to open non-invasively. Memory, threads, modules, search and scan are available; the process is never attached, paused, or debugged."
                    : "Pick a process to attach the debugger to. It will pause once attached."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="flex items-center justify-between rounded-md border p-2">
                  <div className="min-w-0 pr-3 space-y-0.5">
                    <Label htmlFor="attachNonInvasive">Non-invasive (don't attach debugger)</Label>
                    <p className="text-xs text-muted-foreground">Open the process for memory/enumeration only — no breakpoints or stepping.</p>
                  </div>
                  <Switch id="attachNonInvasive" checked={attachNonInvasive} onCheckedChange={setAttachNonInvasive} className="shrink-0" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="attachServerUrl">Debug Server URL (optional)</Label>
                  <div className="flex gap-2">
                    <HistoryInput
                      historyKey="server-url"
                      id="attachServerUrl"
                      value={attachServerUrl}
                      onChange={(e) => setAttachServerUrl(e.target.value)}
                      placeholder="Leave empty to use a local embedded server"
                    />
                    <Button variant="outline" size="icon" onClick={loadProcesses} title="Refresh process list" type="button" disabled={isLoadingProcesses}>
                      <RefreshCw className={`h-4 w-4 ${isLoadingProcesses ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </div>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={processFilter}
                    onChange={(e) => setProcessFilter(e.target.value)}
                    placeholder="Filter by name or PID"
                    className="pl-8"
                  />
                </div>
                <ScrollArea className="h-72 rounded-md border">
                  {isLoadingProcesses ? (
                    <div className="p-4 text-sm text-muted-foreground">Loading processes…</div>
                  ) : filteredProcesses.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground">No processes found.</div>
                  ) : (
                    <div className="divide-y">
                      {filteredProcesses.map((proc) => (
                        <Button
                          key={proc.pid}
                          type="button"
                          variant="ghost"
                          onClick={() => handleAttachToProcess(proc)}
                          disabled={attachingPid !== null}
                          className="flex w-full items-center justify-between h-auto px-3 py-2 rounded-none text-left text-sm font-normal"
                        >
                          <span className="min-w-0 truncate font-medium">{proc.name}</span>
                          <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                            {attachingPid === proc.pid ? "Attaching…" : `PID ${proc.pid}`}
                          </span>
                        </Button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setIsAttachDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          </div>
        </div>

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center text-center">
              <FileCode2 className="h-12 w-12 mb-4 text-muted-foreground opacity-40" />
              <h2 className="text-xl font-semibold text-muted-foreground mb-2">No processes yet</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Create a new process or attach to a running one to get started
              </p>
              <Button onClick={handleOpenNewSessionDialog} className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Create Process
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {sortedSessions.map((session) => (
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
                      <Button variant="ghost" size="icon" onClick={() => handleStartSession(session)} disabled={!canStart(session.status)} title={session.attach_pid != null ? "Re-attach" : "Start"}>
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
                      <strong>Server:</strong>{" "}
                      {session.is_local_run
                        ? session.server_url
                          ? `Local (${session.server_url})`
                          : "Local (pending)"
                        : session.server_url}
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

      <FileDropOverlay active={isDragOver} message="Drop an executable to debug" />
    </Page>
  );
}