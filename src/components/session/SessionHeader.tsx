import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Square, Play, MoveRight, CornerDownRight, CornerUpLeft, Pause, Plus, ChevronDown, Unplug, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { DockWindowsMenu, DockWindowsMenuTab } from '@/components/DockWindowsMenu';
import { DebugSession, SessionStatus } from '@/contexts/SessionContext';
import { useKeybindingContext } from '@/contexts/KeybindingContext';

export interface SessionHeaderProps {
  session: DebugSession;
  busyAction: "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "pause" | "detach" | "attach" | null;
  handleGo: () => void;
  handleGoPassException: () => void;
  handleStepIn: () => void;
  handleStepOver: () => void;
  handleStepOut: () => void;
  handleStop: () => void;
  handleStart: () => void;
  handlePause: () => void;
  handleDetach: () => void;
  handleAttach: () => void;
  canStep: boolean;
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
  handlePause,
  handleDetach,
  handleAttach,
  canStep,
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

  // Non-invasive Open session: no debug loop, so no stepping/pause. The single
  // Attach/Detach button becomes "Attach" here and "Detach" once attached.
  const isOpen = session.status === 'Open';

  const windowTabs: DockWindowsMenuTab[] = [
    { id: 'disassembly', label: 'Disassembly', shortcut: getKeybinding('panel.disassembly') },
    { id: 'source', label: 'Source', shortcut: getKeybinding('panel.source') },
    { id: 'registers', label: 'Registers', shortcut: getKeybinding('panel.registers') },
    { id: 'modules', label: 'Modules', shortcut: getKeybinding('panel.modules') },
    { id: 'threads', label: 'Threads', shortcut: getKeybinding('panel.threads') },
    { id: 'callstack', label: 'Call Stack', shortcut: getKeybinding('panel.callstack') },
    { id: 'symbols', label: 'Symbols', shortcut: getKeybinding('panel.symbols') },
    { id: 'types', label: 'Types', shortcut: getKeybinding('panel.types') },
    { id: 'memory_regions', label: 'Memory Regions', shortcut: getKeybinding('panel.memoryRegions') },
    { id: 'breakpoints', label: 'Breakpoints', shortcut: getKeybinding('panel.breakpoints') },
    { id: 'patches', label: 'Patches', shortcut: getKeybinding('panel.patches') },
    { id: 'bookmarks', label: 'Bookmarks', shortcut: getKeybinding('panel.bookmarks') },
    { id: 'memory_search', label: 'Memory Search', shortcut: getKeybinding('panel.memorySearch') },
    { id: 'memory_scanner', label: 'Memory Scanner', shortcut: getKeybinding('panel.memoryScanner') },
    { id: 'pointer_scan', label: 'Pointer Scan', shortcut: getKeybinding('panel.pointerScan') },
    { id: 'strings', label: 'Strings', shortcut: getKeybinding('panel.strings') },
    { id: 'code_explorer', label: 'Code Explorer', shortcut: getKeybinding('panel.codeExplorer') },
    { id: 'peviewer', label: 'PE Viewer', shortcut: getKeybinding('panel.peViewer') },
    { id: 'access_trace', label: 'Access Trace' },
  ];

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
          {symbolLoadingCount > 0 && (
            <Badge variant="outline" size="xs" title="Symbol downloads in progress">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Downloading symbols ({symbolLoadingCount})
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
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
                    Go (Handle Exception)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleGoPassException}
                    disabled={session.current_event?.event_type !== "Exception"}
                  >
                    Go (Pass Exception)
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

        {!canStart && (
          <Button
            onClick={isOpen ? handleAttach : handleDetach}
            disabled={(!isOpen && !canDetach) || busyAction !== null}
            size="sm"
            variant="outline"
            title={isOpen
              ? "Attach the debugger to this process to enable breakpoints and stepping"
              : "Detach from the target and leave it running (available while paused)"}
          >
            <Unplug className="h-4 w-4 mr-2" />
            {isOpen
              ? (busyAction === "attach" ? "Attaching..." : "Attach")
              : (busyAction === "detach" ? "Detaching..." : "Detach")}
          </Button>
        )}

        {!canStart && (
          <Button
            onClick={handleStop}
            disabled={!canStop || busyAction === "stop"}
            size="sm"
            variant="destructive"
          >
            <Square className="h-4 w-4 mr-2" />
            {busyAction === "stop" ? "Stopping..." : "Stop"}
          </Button>
        )}

        {/* Separator before the Windows menu */}
        <div className="w-px h-6 bg-border mx-1" />

        <DockWindowsMenu
          dockingRef={dockingRef}
          tabs={windowTabs}
          onToggleTab={toggleTab}
          onResetLayout={resetLayout}
        >
          {addNewMemoryTab && (
            <DropdownMenuItem onSelect={(e: Event) => { e.preventDefault(); addNewMemoryTab(); }}>
              <Plus />
              <span className="flex-1">Add Memory Window</span>
              <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.addMemory")}</span>
            </DropdownMenuItem>
          )}
        </DockWindowsMenu>
      </div>
    </div>
  );
};
