import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HistoryInput } from "@/components/ui/history-input";
import { pushInputHistory } from "@/lib/inputHistory";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatEnvText, parseEnvText, type EnvPairs } from "@/lib/envVars";
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
import { Plus, Play, Eye, Pencil, Trash2, Square, FileCode2, FolderOpen, Unplug, RefreshCw, Search, ChevronRight, Braces, Box, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  contentKey,
  loadSessionsFromStorage,
  updateSessionInStorage,
  removeSessionFromStorage,
  sessionToConfig,
  syncSessionsToStorage,
  touchSessionInStorage,
} from "@/lib/sessionStorage";

import { DebugSession, SessionStatus } from "@/contexts/SessionContext";
import { isProcessAvailable, canStopSession, formatTauriError, pathDirname, buildLaunchCommand, DEFAULT_SESSION_NAME, sessionDisplayName, type ProcessInfo } from "@/lib/sessionHelpers";
import { pickDroppedFile } from "@/hooks/useFileDrop";
import { useFileDropTarget } from "@/contexts/FileDropContext";
import { createSessionRecord, launchExecutable } from "@/lib/launchFile";
import { appNavHistory } from "@/lib/navHistory";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { useSandbox } from "@/hooks/useSandbox";
import { SandboxMountsEditor } from "@/components/session/SandboxMountsEditor";
import { EtwConfigEditor, presetToOps } from "@/components/session/EtwConfigEditor";
import type { SandboxMount, SandboxLaunchConfig, EtwConfig } from "@/lib/sandbox";

type LaunchMode = "local" | "remote" | "sandbox" | "etw";

/**
 * A collapsible option card for the Create/Edit dialog. Collapsed, it shows a
 * one-line summary of its current value on the right; open, it reveals its
 * controls. Header carries an `aria-label` so its accessible name is stable
 * (independent of the summary) for tests and screen readers.
 */
function FoldSection({
  title,
  icon,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: ReactNode;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <Button
        type="button"
        variant="ghost"
        aria-label={title}
        aria-expanded={open}
        onClick={onToggle}
        className="h-auto w-full justify-start gap-2 px-3 py-2 font-normal hover:bg-muted/50"
      >
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {icon}
        <span className="text-sm">{title}</span>
        {summary && !open && (
          <span className="ml-auto max-w-[55%] truncate text-xs font-normal text-muted-foreground">{summary}</span>
        )}
      </Button>
      {open && <div className="space-y-3 border-t p-3">{children}</div>}
    </div>
  );
}

export default function Debugger() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<DebugSession[]>([]);
  const [sessionToEdit, setSessionToEdit] = useState<DebugSession | null>(null);
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  
  // Form state for dialog
  const [formServerUrl, setFormServerUrl] = useState("127.0.0.1:9000");
  const [formLaunchCommand, setFormLaunchCommand] = useState("cmd.exe /c echo Hello World!");
  const [formWorkingDirectory, setFormWorkingDirectory] = useState("");
  // KEY=value lines; parsed on submit (see parseEnvText).
  const [formEnvironment, setFormEnvironment] = useState("");
  // Launch mode: embedded local server, remote URL, ETW-only (no debugger), or Sandbox.
  const [formLaunchMode, setFormLaunchMode] = useState<LaunchMode>("local");
  const [formSandboxMounts, setFormSandboxMounts] = useState<SandboxMount[]>([]);
  const [formSandboxMemoryMb, setFormSandboxMemoryMb] = useState(4096);
  const [formSandboxCollectEtw, setFormSandboxCollectEtw] = useState(true);
  // Shared ETW capture op-set (rich configurator), used by both the sandbox and
  // local (host) ETW forms.
  const [formEtwOps, setFormEtwOps] = useState<string[]>(presetToOps("all"));
  const [formEtwCallstacks, setFormEtwCallstacks] = useState(false);
  const [formSandboxDebug, setFormSandboxDebug] = useState(true);
  // Host ETW on a local (host-debugged) session.
  const [formLocalCollectEtw, setFormLocalCollectEtw] = useState(false);
  // Optional option groups (working dir, env, sandbox, etw) fold independently;
  // this holds which are expanded. Collapsed by default so the dialog stays lean.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggleSection = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const { settings: debugSettings } = useDebugSettings();
  const { status: sandboxStatus, available: sandboxAvailable } = useSandbox();

  // Run-only ("just launch") sandbox mode always traces; debug mode honors the toggle.
  const sandboxCollectsEtw = formSandboxDebug ? formSandboxCollectEtw : true;

  // Collapsed-header summaries.
  const envVarCount = formEnvironment.split("\n").filter((l) => l.trim().includes("=")).length;
  const etwOn =
    formLaunchMode === "etw"
      ? true
      : formLaunchMode === "sandbox"
        ? sandboxCollectsEtw
        : formLocalCollectEtw;

  // The ETW capture config the form describes — shared by the host-ETW and
  // sandbox funnels (both carry the same `EtwConfig` shape).
  const formEtwConfig = (): EtwConfig => ({
    capture: { ops: formEtwOps },
    callstacks: formEtwCallstacks,
  });

  /** Session-level (host) ETW config: standalone "etw" mode, or a local session
   * with ETW collection enabled. */
  const buildEtwConfig = (): EtwConfig | null =>
    formLaunchMode === "etw" || (formLaunchMode === "local" && formLocalCollectEtw)
      ? formEtwConfig()
      : null;

  /** The sandbox config for the current form, or null when not in sandbox mode. */
  const buildSandboxConfig = (): SandboxLaunchConfig | null =>
    formLaunchMode === "sandbox"
      ? {
          mounts: formSandboxMounts,
          memory_mb: formSandboxMemoryMb,
          collect_etw: sandboxCollectsEtw,
          etw: formEtwConfig(),
          debug: formSandboxDebug,
        }
      : null;

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
      const existingByContent = new Set(existingSessions.map(contentKey));

      // Create sessions in backend from stored configs that don't already exist
      for (const config of storedSessions) {
        const key = contentKey(config);
        if (!existingByContent.has(key)) {
          try {
            await invoke("create_debug_session", {
              name: config.name,
              serverUrl: config.server_url,
              launchCommand: config.launch_command,
              workingDirectory: config.working_directory ?? null,
              environment: config.environment ?? null,
              isLocalRun: config.is_local_run ?? true,
              attachPid: null,
              sandbox: config.sandbox ?? null,
              etw: config.etw ?? null,
            });
            existingByContent.add(key);
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
        const dir = pathDirname(selected);
        setFormWorkingDirectory((prev) => (prev.trim() ? prev : dir));
        // In sandbox mode the target must be reachable via a mount — add its
        // folder (read-only) if not already mapped.
        if (formLaunchMode === "sandbox" && dir) {
          setFormSandboxMounts((prev) =>
            prev.some((m) => m.host_path.toLowerCase() === dir.toLowerCase())
              ? prev
              : [...prev, { host_path: dir, read_only: true }],
          );
        }
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

  const resetSessionForm = () => {
    setFormServerUrl("127.0.0.1:9000");
    setFormLaunchCommand("cmd.exe /c echo Hello World!");
    setFormWorkingDirectory("");
    setFormEnvironment("");
    setFormLaunchMode("local");
    setFormSandboxMounts([]);
    setFormSandboxMemoryMb(debugSettings.sandbox_default_memory_mb);
    setFormSandboxCollectEtw(debugSettings.sandbox_collect_etw);
    setFormEtwOps(presetToOps(debugSettings.sandbox_etw_preset));
    setFormEtwCallstacks(false);
    setFormSandboxDebug(true);
    setFormLocalCollectEtw(false);
  };

  /**
   * Parse the environment textarea into the wire shape: `null` for "inherit"
   * (blank), or `undefined` after toasting when a line is malformed — callers
   * abort on `undefined`.
   */
  const readFormEnvironment = (): EnvPairs | null | undefined => {
    const env = parseEnvText(formEnvironment);
    if (!env.ok) {
      toast.error(`Environment variables: ${env.error}`);
      return undefined;
    }
    return env.pairs.length ? env.pairs : null;
  };

  const handleOpenNewSessionDialog = () => {
    setSessionToEdit(null);
    resetSessionForm();
    setOpenSections(new Set()); // fresh dialog: everything folded
    setIsSessionDialogOpen(true);
  };

  const handleOpenEditSessionDialog = (session: DebugSession) => {
    setSessionToEdit(session);
    setFormServerUrl(session.server_url);
    setFormLaunchCommand(session.launch_command);
    setFormWorkingDirectory(session.working_directory ?? "");
    setFormEnvironment(formatEnvText(session.environment));
    setFormLaunchMode(
      session.sandbox ? "sandbox" : session.is_local_run ? "local" : session.etw ? "etw" : "local",
    );
    setFormSandboxMounts(session.sandbox?.mounts ?? []);
    setFormSandboxMemoryMb(session.sandbox?.memory_mb ?? debugSettings.sandbox_default_memory_mb);
    setFormSandboxCollectEtw(session.sandbox?.collect_etw ?? debugSettings.sandbox_collect_etw);
    // Capture config is shared between the sandbox form and host-ETW form; seed
    // from whichever the session carries (empty ⇒ the settings default preset).
    const cap = session.sandbox?.etw?.capture ?? session.etw?.capture;
    setFormEtwOps(
      cap?.ops && cap.ops.length > 0
        ? cap.ops
        : presetToOps(debugSettings.sandbox_etw_preset),
    );
    setFormEtwCallstacks(session.sandbox?.etw?.callstacks ?? session.etw?.callstacks ?? false);
    setFormSandboxDebug(session.sandbox?.debug ?? true);
    setFormLocalCollectEtw(!!session.etw);
    // Editing: pre-open the sections that carry configured values.
    const seed = new Set<string>();
    if (session.working_directory) seed.add("workdir");
    if (session.environment && session.environment.length) seed.add("env");
    if (session.sandbox) seed.add("sandbox");
    if (session.etw || session.sandbox?.collect_etw) seed.add("etw");
    setOpenSections(seed);
    setIsSessionDialogOpen(true);
  };

  // Record the launch-form values for ArrowUp/Down recall next time the dialog
  // is used; called only after the backend accepts them.
  const pushLaunchFormHistory = () => {
    pushInputHistory("launch-command", formLaunchCommand);
    pushInputHistory("launch-cwd", formWorkingDirectory);
    if (formLaunchMode === "remote") pushInputHistory("server-url", formServerUrl);
  };

  const handleCreateSession = async () => {
    // No name field anymore — the list derives a label from the launch command
    // (see sessionDisplayName); the stored name is just the default placeholder.
    const sessionName = DEFAULT_SESSION_NAME;
    const environment = readFormEnvironment();
    if (environment === undefined) return;

    try {
      const sessionId = await createSessionRecord({
        name: sessionName,
        serverUrl: formLaunchMode === "remote" ? formServerUrl : "",
        launchCommand: formLaunchCommand,
        workingDirectory: formWorkingDirectory.trim() || null,
        environment,
        isLocalRun: formLaunchMode === "local",
        sandbox: buildSandboxConfig(),
        etw: buildEtwConfig(),
      });

      pushLaunchFormHistory();
      toast.success("Debug session created successfully");
      setIsSessionDialogOpen(false);

      resetSessionForm();

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

    // Preserve whatever name the session already had (naming is no longer editable).
    const sessionName = sessionToEdit.name || DEFAULT_SESSION_NAME;

    const environment = readFormEnvironment();
    if (environment === undefined) return;

    try {
      const workingDirectory = formWorkingDirectory.trim() || null;

      const sandbox = buildSandboxConfig();
      const etw = buildEtwConfig();
      await invoke("update_debug_session", {
        sessionId: sessionToEdit.id,
        name: sessionName,
        serverUrl: formLaunchMode === "remote" ? formServerUrl : "",
        launchCommand: formLaunchCommand,
        workingDirectory,
        environment,
        isLocalRun: formLaunchMode === "local",
        attachPid: null,
        sandbox,
        etw,
      });

      // Update session config in storage
      updateSessionInStorage({
        id: sessionToEdit.id,
        name: sessionName,
        server_url: formLaunchMode === "remote" ? formServerUrl : "",
        launch_command: formLaunchCommand,
        working_directory: workingDirectory,
        environment,
        is_local_run: formLaunchMode === "local",
        sandbox,
        etw,
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

    try {
      const sessionId = await launchExecutable(dropped);
      setLastUsedTick((t) => t + 1);
      toast.success("Debug session started");
      navigate(`/session/${sessionId}`);
    } catch (error) {
      console.error("Failed to launch dropped executable:", error);
      toast.error(formatTauriError(error));
    }
  };

  useFileDropTarget({
    message: "Drop an executable to debug",
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
      environment: session.environment ?? null,
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
      // Its addresses/tabs in the back/forward trail are meaningless now.
      appNavHistory.invalidateScope(sessionId);

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
        case "Provisioning":
          return "Provisioning Windows Sandbox (booting VM, starting guest server)…";
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

  const canStop = canStopSession;

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
            <DialogContent className={formLaunchMode === "sandbox" || formLaunchMode === "etw" ? "sm:max-w-[560px]" : "sm:max-w-[425px]"}>
              <DialogHeader>
                <DialogTitle>{sessionToEdit ? "Edit Process" : "Create Process"}</DialogTitle>
                <DialogDescription>
                  {sessionToEdit
                    ? "Update the details for this debug session."
                    : "Set a launch command and mode. Expand a section below to tweak its options."
                  }
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {/* Launch Command — the primary field. */}
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
                    <Button variant="outline" size="icon" onClick={handleBrowseExecutable} title="Browse for executable" type="button">
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Launch mode</Label>
                  <Tabs value={formLaunchMode} onValueChange={(v) => setFormLaunchMode(v as LaunchMode)}>
                    <TabsList className="w-full">
                      <TabsTrigger value="local" className="flex-1">Local</TabsTrigger>
                      <TabsTrigger value="etw" className="flex-1" title="Run a target under ETW only (no debugger)">
                        ETW only
                      </TabsTrigger>
                      <TabsTrigger
                        value="sandbox"
                        className="flex-1"
                        disabled={!sandboxAvailable}
                        title={sandboxStatus?.reason ?? undefined}
                      >
                        Sandbox
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {!sandboxAvailable && sandboxStatus?.reason && (
                    <p className="text-xs text-muted-foreground">{sandboxStatus.reason}</p>
                  )}
                  {formLaunchMode === "local" && (
                    <p className="text-xs text-muted-foreground">Starts an embedded debug server on this machine.</p>
                  )}
                </div>
                {/* Optional groups — each folds independently, collapsed by default. */}
                <div className="space-y-3">
                  <FoldSection
                    title="Working directory"
                    icon={<FolderOpen className="size-4 shrink-0 text-muted-foreground" />}
                    summary={formWorkingDirectory || "Default (executable's directory)"}
                    open={openSections.has("workdir")}
                    onToggle={() => toggleSection("workdir")}
                  >
                    <div className="flex gap-2">
                      <HistoryInput
                        historyKey="launch-cwd"
                        id="workingDirectory"
                        aria-label="Working Directory"
                        value={formWorkingDirectory}
                        onChange={(e) => setFormWorkingDirectory(e.target.value)}
                        placeholder="Defaults to the executable's directory"
                      />
                      <Button variant="outline" size="icon" onClick={handleBrowseWorkingDirectory} title="Browse for working directory" type="button">
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </FoldSection>

                  <FoldSection
                    title="Environment variables"
                    icon={<Braces className="size-4 shrink-0 text-muted-foreground" />}
                    summary={envVarCount > 0 ? `${envVarCount} variable${envVarCount === 1 ? "" : "s"}` : "None"}
                    open={openSections.has("env")}
                    onToggle={() => toggleSection("env")}
                  >
                    <Textarea
                      id="environment"
                      aria-label="Environment Variables"
                      rows={3}
                      className="font-mono text-xs"
                      value={formEnvironment}
                      onChange={(e) => setFormEnvironment(e.target.value)}
                      placeholder={"KEY=value, one per line\nMerged over the debugger's own environment"}
                      spellCheck={false}
                    />
                  </FoldSection>

                  {formLaunchMode === "sandbox" && (
                    <FoldSection
                      title="Sandbox settings"
                      icon={<Box className="size-4 shrink-0 text-muted-foreground" />}
                      summary={`${formSandboxDebug ? "Debug" : "Run-only"} · ${formSandboxMemoryMb} MB${formSandboxMounts.length ? ` · ${formSandboxMounts.length} folder${formSandboxMounts.length === 1 ? "" : "s"}` : ""}`}
                      open={openSections.has("sandbox")}
                      onToggle={() => toggleSection("sandbox")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm">Attach debugger</div>
                          <div className="text-xs text-muted-foreground">
                            {formSandboxDebug
                              ? "Debug the target inside the sandbox (breakpoints, stepping, memory)."
                              : "Just run the target under ETW — no debugger (safe detonation)."}
                          </div>
                        </div>
                        <Switch checked={formSandboxDebug} onCheckedChange={setFormSandboxDebug} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Shared folders (mounted into the sandbox)
                        </Label>
                        <SandboxMountsEditor mounts={formSandboxMounts} onChange={setFormSandboxMounts} />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm">Networking</div>
                          <div className="text-xs text-muted-foreground">
                            Required — the debugger connects to the in-sandbox server over the network.
                          </div>
                        </div>
                        <Switch checked disabled />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="sandboxMemory" className="text-sm">Memory (MB)</Label>
                        <Input
                          id="sandboxMemory"
                          type="number"
                          min={1024}
                          step={1024}
                          className="w-28 text-right tabular-nums"
                          value={String(formSandboxMemoryMb)}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isFinite(n)) setFormSandboxMemoryMb(n);
                          }}
                        />
                      </div>
                    </FoldSection>
                  )}

                  <FoldSection
                    title="ETW capture"
                    icon={<Activity className="size-4 shrink-0 text-muted-foreground" />}
                    summary={etwOn ? `${formEtwOps.length} event type${formEtwOps.length === 1 ? "" : "s"}${formEtwCallstacks ? " · callstacks" : ""}` : "Off"}
                    open={openSections.has("etw")}
                    onToggle={() => toggleSection("etw")}
                  >
                    {formLaunchMode === "etw" ? (
                      <>
                        <div className="text-xs text-muted-foreground">
                          Runs the target under ETW with no debugger attached. Starting it prompts for
                          admin (UAC). Callstacks are raw addresses (no debugger for symbols).
                        </div>
                        <EtwConfigEditor
                          ops={formEtwOps}
                          onChange={setFormEtwOps}
                          callstacks={formEtwCallstacks}
                          onCallstacksChange={setFormEtwCallstacks}
                        />
                      </>
                    ) : formLaunchMode === "sandbox" ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm">Collect ETW trace</div>
                            <div className="text-xs text-muted-foreground">
                              {formSandboxDebug
                                ? "Streams process/file/registry/network activity to the Sandbox Events panel."
                                : "Always on in run-only mode — the tracer launches and observes the target."}
                            </div>
                          </div>
                          <Switch
                            checked={sandboxCollectsEtw}
                            disabled={!formSandboxDebug}
                            onCheckedChange={setFormSandboxCollectEtw}
                          />
                        </div>
                        {sandboxCollectsEtw && (
                          <EtwConfigEditor ops={formEtwOps} onChange={setFormEtwOps} callstacks={formEtwCallstacks} onCallstacksChange={setFormEtwCallstacks} />
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm">Collect ETW trace</div>
                            <div className="text-xs text-muted-foreground">
                              Record the target's file/registry/network/process activity via host ETW.
                              Starting it prompts for admin (UAC).
                            </div>
                          </div>
                          <Switch checked={formLocalCollectEtw} onCheckedChange={setFormLocalCollectEtw} />
                        </div>
                        {formLocalCollectEtw && <EtwConfigEditor ops={formEtwOps} onChange={setFormEtwOps} callstacks={formEtwCallstacks} onCallstacksChange={setFormEtwCallstacks} />}
                      </>
                    )}
                  </FoldSection>
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
              <Card key={session.id} data-session-id={session.id} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-xl">{sessionDisplayName(session)}</CardTitle>
                        {getStatusBadge(session.status)}
                      </div>
                      <CardDescription className="mt-1">
                        {getStatusDescription(session.status)}
                      </CardDescription>
                    </div>
                    {/* Three classes of action, separated so they don't read as
                        one undifferentiated row: run the target, manage the
                        session record, then the primary "go debug it". Nothing
                        here uses a solid variant — `disabled` already says what
                        is available, so promoting a button for being *enabled*
                        would just out-shout the name and status. */}
                    <div className="flex items-center gap-1">
                      {/* Lifecycle */}
                      <Button variant="ghost" size="icon" onClick={() => handleStartSession(session)} disabled={!canStart(session.status)} title={session.attach_pid != null ? "Re-attach" : "Start"} aria-label={session.attach_pid != null ? "Re-attach" : "Start"}>
                        <Play className="h-4 w-4" />
                      </Button>
                      {/* Square, not XSquare: it pairs with Play the way every
                          transport control does, and matches SessionHeader. An
                          icon that draws its own box also fights the button. */}
                      <Button variant="ghost" size="icon" onClick={() => handleStopSession(session.id)} disabled={!canStop(session.status)} title="Stop" aria-label="Stop">
                        <Square className="h-4 w-4" />
                      </Button>

                      <div className="w-px h-6 bg-border mx-1" />

                      {/* Manage the session record */}
                      <Button variant="ghost" size="icon" onClick={() => handleOpenEditSessionDialog(session)} disabled={!canEdit(session.status)} title="Edit" aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <span tabIndex={canDelete(session.status) ? 0 : -1}>
                            <Button variant="ghost" size="icon" disabled={!canDelete(session.status)} title="Delete" aria-label="Delete" className="hover:bg-destructive/10 hover:text-destructive">
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

                      <div className="w-px h-6 bg-border mx-1" />

                      {/* The card's one focal point, and the only labelled
                          control: opening the session is what you came here to
                          do, and it shouldn't be a glyph you have to decode. */}
                      <Button variant="outline" onClick={() => handleViewSession(session.id)} disabled={!canView(session.status)} title="Open this session in the debugger">
                        <Eye className="h-4 w-4" />
                        Open
                      </Button>
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
    </Page>
  );
}