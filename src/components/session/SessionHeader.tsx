import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Square, Play, RedoDot, ArrowDownToDot, ArrowUpFromDot, Pause, Plus, ChevronDown, Unplug, Loader2, AlertTriangle, RotateCcw, HardDriveDownload, FileDown } from 'lucide-react';
import { exceptionName, formatExceptionCode, EXCEPTION_SINGLE_STEP } from '@/lib/exceptionNames';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { DockWindowsMenu, DockWindowsMenuGroup } from '@/components/DockWindowsMenu';
import { SESSION_TAB_DEFS, SESSION_TAB_CATEGORIES } from '@/lib/sessionTabs';
import { DebugEventInfo, DebugSession, SessionStatus } from '@/contexts/SessionContext';
import { sessionDisplayName } from '@/lib/sessionHelpers';
import { useKeybindingContext } from '@/contexts/KeybindingContext';

export interface SessionHeaderProps {
  session: DebugSession;
  busyAction: "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "restart" | "pause" | "detach" | "attach" | "dump" | null;
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
  handleCreateDump: (fullMemory: boolean) => void;
  handleAttach: () => void;
  canStep: boolean;
  canPassException: boolean;
  canStop: boolean;
  canStart: boolean;
  canPause: boolean;
  canDetach: boolean;
  canDump: boolean;
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
  handleCreateDump,
  handleAttach,
  canStep,
  canPassException,
  canStop,
  canStart,
  canPause,
  canDetach,
  canDump,
  getStatusBadge,
  toggleTab,
  resetLayout,
  addNewMemoryTab,
  dockingRef,
  symbolLoadingCount = 0,
}) => {
  const { getKeybinding } = useKeybindingContext();

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
    <div className="mb-2 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {/* The Back button moved to the app header (brand + nav). The name
            stays: this bar anchors the top-left of the session view, and an
            empty corner reads as a bug. It is smaller than the old page-title
            h1 because the header's pill already carries the name globally.
            The status badge stays too — its data-session-status attribute is
            the e2e suite's paused signal (e2e/helpers/wait-helpers.ts) and
            must resolve to exactly one node. */}
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold truncate max-w-[28ch]">
            {sessionDisplayName(session)}
          </h1>
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
        {/* The command-palette hint lives in the app header now — one per
            screen, not one per bar. */}
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
            variant="outline"
            title={`Pause (${getKeybinding("debug.go")})`}
            aria-label="Pause"
          >
            <Pause className="h-4 w-4" />
          </Button>
        )}
        {/* Step buttons group with tighter spacing. Every transport control is
            outlined and equally weighted — Go, the three steps, and Stop are all
            first-class actions, so none of them gets promoted over the others. */}
        {!canStart && !isOpen && (
          <div className="inline-flex items-center gap-1">
            <div className="inline-flex">
              <Button
                onClick={handleGo}
                disabled={!canStep || busyAction !== null}
                size="sm"
                variant="outline"
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
                    variant="outline"
                    className="rounded-l-none border-l border-l-border px-1"
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
            {/* The three share a dot motif and differ only in how the arrow meets
                it — over, into, out of — which is the same language VS Code and
                friends use. The previous three corner arrows were near-identical
                at 16px and said nothing about what each one does. */}
            <Button
              onClick={handleStepOver}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="outline"
              title={`Step Over (${getKeybinding("debug.stepOver")})`}
              aria-label="Step Over"
            >
              <RedoDot className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepIn}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="outline"
              title={`Step In (${getKeybinding("debug.stepIn")})`}
              aria-label="Step In"
            >
              <ArrowDownToDot className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepOut}
              disabled={!canStep || busyAction !== null}
              size="sm"
              variant="outline"
              title={`Step Out (${getKeybinding("debug.stepOut")})`}
              aria-label="Step Out"
            >
              <ArrowUpFromDot className="h-4 w-4" />
            </Button>
          </div>
        )}

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
            {/* Neutral, not destructive: stopping is routine and recoverable (Restart
                is one item down this very menu), and red is reserved for error and
                changed-since-last-step. The filled square carries the meaning. */}
            <Button
              onClick={handleStop}
              disabled={!canStop || busyAction === "stop"}
              size="sm"
              variant="outline"
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
                    disabled={busyAction !== null || (!canStop && !canDetach && !canDump)}
                    size="sm"
                    variant="outline"
                    className="rounded-l-none border-l border-l-border px-1"
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
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => handleCreateDump(true)}
                    disabled={!canDump}
                    title="Write a full-memory minidump (.dmp) of the paused target"
                  >
                    <HardDriveDownload className="h-4 w-4" />
                    <span className="flex-1">Create Full Memory Dump…</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.dumpFull")}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => handleCreateDump(false)}
                    disabled={!canDump}
                    title="Write a small minidump (.dmp) of the paused target: stacks, modules, thread info and the memory they reference"
                  >
                    <FileDown className="h-4 w-4" />
                    <span className="flex-1">Create Minidump…</span>
                    <DropdownMenuShortcut>{getKeybinding("debug.dumpMini")}</DropdownMenuShortcut>
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
