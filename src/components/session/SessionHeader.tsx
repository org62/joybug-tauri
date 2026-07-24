import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Square, Play, MoveRight, CornerDownRight, CornerUpLeft, Pause, Plus, ChevronDown, Unplug, Loader2, AlertTriangle, Search, RotateCcw } from 'lucide-react';
import { exceptionName, formatExceptionCode, EXCEPTION_SINGLE_STEP } from '@/lib/exceptionNames';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';
import { DockWindowsMenu, DockWindowsMenuGroup } from '@/components/DockWindowsMenu';
import { SESSION_TAB_DEFS, SESSION_TAB_CATEGORIES } from '@/lib/sessionTabs';
import { DebugEventInfo, DebugSession, SessionStatus } from '@/contexts/SessionContext';
import { useKeybindingContext } from '@/contexts/KeybindingContext';
import { useCommandPaletteContext } from '@/contexts/CommandPaletteContext';

export interface SessionHeaderProps {
  session: DebugSession;
  busyAction: "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "restart" | "pause" | "detach" | "attach" | null;
  handleGo: () => void;
  handleGoPassException: () => void;
  handleStepIn: () => void;
  handleStepOver: () => void;
  handleStepOut: () => void;
  handleStop: () => void;
  handleStart: () => void;
  handleRestart: () => void;
  handlePause: () => void;
  handleDetach: () => void;
  handleAttach: () => void;
  canStep: boolean;
  canPassException: boolean;
  canStop: boolean;
  canStart: boolean;
  canPause: boolean;
  canDetach: boolean;
  dockingRef: React.RefObject<{ getActiveTabs: () => string[] }>; // rc-dock doesn't export DockingLayoutRef type properly
  getStatusBadge: (status: SessionStatus) => React.ReactNode;
  toggleTab: (tabId: string) => void;
  resetLayout: () => void;
  addNewMemoryTab?: () => void;
  /** Number of modules whose symbols are still downloading (0 hides the indicator). */
  symbolLoadingCount?: number;
}

const ExceptionBadge: React.FC<{ event: DebugEventInfo | null }> = ({ event }) => {
  if (event?.event_type !== "Exception" || event.exception_code == null) return null;
  const code = event.exception_code;
  const name = exceptionName(code);
  const secondChance = event.exception_first_chance === false;
  // A single-step exception reaching us is always program-raised — the
  // debugger's own steps surface as StepComplete, never as an Exception.
  // Spell that out so the user isn't misled into thinking they stepped.
  const isProgramSingleStep = code === EXCEPTION_SINGLE_STEP;
  const label = isProgramSingleStep
    ? `${name} · raised by program`
    : `${name}${secondChance ? " · second-chance" : ""}`;
  const title = isProgramSingleStep
    ? "The debuggee raised this single-step exception itself — this is NOT a debugger step. Use Go ▸ Pass Exception to deliver it to the program's own handler, or Go ▸ Handle Exception to swallow it."
    : `${name} (${formatExceptionCode(code)}) — ${secondChance ? "second" : "first"}-chance`;
  return (
    <Badge variant="destructive" size="xs" title={title}>
      <AlertTriangle className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
};

export const SessionHeader: React.FC<SessionHeaderProps> = ({
  session,
  busyAction,
  handleGo,
  handleGoPassException,
  handleStepIn,
  handleStepOver,
  handleStepOut,
  handleStop,
  handleStart,
  handleRestart,
  handlePause,
  handleDetach,
  handleAttach,
  canStep,
  canPassException,
  canStop,
  canStart,
  canPause,
  canDetach,
  getStatusBadge,
  toggleTab,
  resetLayout,
  addNewMemoryTab,
  dockingRef,
  symbolLoadingCount = 0,
}) => {
  const navigate = useNavigate();
  const { getKeybinding } = useKeybindingContext();
  const { setOpen: setPaletteOpen } = useCommandPaletteContext();

  // Non-invasive Open session: no debug loop, so no stepping/pause. The single
  // Attach/Detach button becomes "Attach" here and "Detach" once attached.
  const isOpen = session.status === 'Open';

  // One submenu per category — twenty windows are too many to scan flat.
  // "Add Memory Window" lives inside the Memory submenu, next to the tabs it
  // creates, rather than at the top level.
  const windowGroups: DockWindowsMenuGroup[] = SESSION_TAB_CATEGORIES.map((category) => ({
    label: category,
    tabs: SESSION_TAB_DEFS
      .filter((d) => d.category === category)
      .map((d) => ({
        id: d.id,
        label: d.title,
        shortcut: d.action ? getKeybinding(d.action) : undefined,
      })),
    children: category === "Memory" && addNewMemoryTab && (
      <DropdownMenuItem onSelect={(e: Event) => { e.preventDefault(); addNewMemoryTab(); }}>
        <Plus />
        <span className="flex-1">Add Memory Window</span>
        <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.addMemory")}</span>
      </DropdownMenuItem>
    ),
  }));

  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => navigate("/debugger")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{session.name}</h1>
          {getStatusBadge(session.status)}
          <ExceptionBadge event={session.current_event} />
          {symbolLoadingCount > 0 && (
            <Badge variant="outline" size="xs" title="Symbol downloads in progress">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Downloading symbols ({symbolLoadingCount})
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Quiet discoverability hint: everything in the app is reachable from
            the command palette, but users don't find the shortcut on their own. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setPaletteOpen(true)}
          title={`Command palette — jump to any window, action, or address (${getKeybinding("palette.open")})`}
          aria-label="Open command palette"
        >
          <Search className="h-3.5 w-3.5 mr-1.5" />
          <kbd className="rounded border px-1 py-0.5 text-[10px] font-mono">
            {getKeybinding("palette.open")}
          </kbd>
        </Button>
        <div className="w-px h-6 bg-border mx-1" />

        {canStart && (
          <Button
            onClick={handleStart}
            size="sm"
            variant="outline"
            title={`Start (${getKeybinding("debug.go")})`}
          >
            <Play className="h-4 w-4 mr-2" />
            Start
          </Button>
        )}
        {!canStart && !isOpen && (
          <Button
            onClick={handlePause}
            disabled={!canPause || busyAction !== null}
            size="sm"
            variant="default"
            title={`Pause (${getKeybinding("debug.go")})`}
            aria-label="Pause"
          >
            <Pause className="h-4 w-4" />
          </Button>
        )}
        {/* Step buttons group with tighter spacing */}
        {!canStart && !isOpen && (
          <div className="inline-flex items-center gap-1">
            <div className="inline-flex">
              <Button
                onClick={handleGo}
                disabled={!canStep || busyAction !== null}
                size="sm"
                variant="default"
                title={`Go (${getKeybinding("debug.go")})`}
                aria-label="Go"
                className="rounded-r-none"
              >
                <Play className="h-4 w-4" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    disabled={!canStep || busyAction !== null}
                    size="sm"
                    variant="default"
                    className="rounded-l-none border-l border-l-primary-foreground/20 px-1"
                    aria-label="Go options"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={handleGo}>
                    <span className="flex-1">Go (Handle Exception)</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.go")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleGoPassException}
                    disabled={!canPassException}
                  >
                    <span className="flex-1">Go (Pass Exception)</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.goPassException")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Button
              onClick={handleStepOver}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="default"
              title={`Step Over (${getKeybinding("debug.stepOver")})`}
              aria-label="Step Over"
            >
              <MoveRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepIn}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="default"
              title={`Step In (${getKeybinding("debug.stepIn")})`}
              aria-label="Step In"
            >
              <CornerDownRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepOut}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="default"
              title={`Step Out (${getKeybinding("debug.stepOut")})`}
              aria-label="Step Out"
            >
              <CornerUpLeft className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Separator between debug/step controls and session-lifecycle actions */}
        {!canStart && !isOpen && <div className="w-px h-6 bg-border mx-1" />}

        {!canStart && isOpen && (
          <Button
            onClick={handleAttach}
            disabled={busyAction !== null}
            size="sm"
            variant="outline"
            title="Attach the debugger to this process to enable breakpoints and stepping"
          >
            <Unplug className="h-4 w-4 mr-2" />
            {busyAction === "attach" ? "Attaching..." : "Attach"}
          </Button>
        )}

        {/* Stop with Detach folded into a split dropdown, mirroring the Go
            (Handle/Pass Exception) split button. */}
        {!canStart && (
          <div className="inline-flex">
            <Button
              onClick={handleStop}
              disabled={!canStop || busyAction === "stop"}
              size="sm"
              variant="destructive"
              className={isOpen ? undefined : "rounded-r-none"}
              title={`Stop Session (${getKeybinding("debug.stop")})`}
              aria-label="Stop"
            >
              <Square className="h-4 w-4" />
            </Button>
            {!isOpen && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    disabled={busyAction !== null || (!canStop && !canDetach)}
                    size="sm"
                    variant="destructive"
                    className="rounded-l-none border-l border-l-white/20 px-1"
                    aria-label="Stop options"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={handleRestart}
                    disabled={!canStop}
                    title="Stop the session and start a fresh run"
                  >
                    <RotateCcw className="h-4 w-4" />
                    <span className="flex-1">Restart Session</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.restart")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleDetach}
                    disabled={!canDetach}
                    title="Detach from the target and leave it running (available while paused)"
                  >
                    <Unplug className="h-4 w-4" />
                    <span className="flex-1">Detach (leave running)</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.detach")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {/* Separator before the Windows menu */}
        <div className="w-px h-6 bg-border mx-1" />

        <DockWindowsMenu
          dockingRef={dockingRef}
          groups={windowGroups}
          onToggleTab={toggleTab}
          onResetLayout={resetLayout}
        />
      </div>
    </div>
  );
};
