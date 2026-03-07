import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Square, Play, MoveRight, CornerDownRight, CornerUpLeft, Pause, Plus, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { DebugSession, SessionStatus } from '@/contexts/SessionContext';
import { useKeybindingContext } from '@/contexts/KeybindingContext';

export interface SessionHeaderProps {
  session: DebugSession;
  busyAction: "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "pause" | null;
  handleGo: () => void;
  handleGoPassException: () => void;
  handleStepIn: () => void;
  handleStepOver: () => void;
  handleStepOut: () => void;
  handleStop: () => void;
  handleStart: () => void;
  handlePause: () => void;
  canStep: boolean;
  canStop: boolean;
  canStart: boolean;
  canPause: boolean;
  dockingRef: React.RefObject<{ getActiveTabs: () => string[] }>; // rc-dock doesn't export DockingLayoutRef type properly
  getStatusBadge: (status: SessionStatus) => React.ReactNode;
  toggleTab: (tabId: string) => void;
  resetLayout: () => void;
  addNewMemoryTab?: () => void;
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
  canStep,
  canStop,
  canStart,
  canPause,
  getStatusBadge,
  toggleTab,
  resetLayout,
  addNewMemoryTab,
  dockingRef,
}) => {
  const navigate = useNavigate();
  const { getKeybinding } = useKeybindingContext();

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
        </div>
      </div>

      <div className="flex items-center">
        {canStart && (
          <Button
            onClick={handleStart}
            size="sm"
            variant="outline"
            className="mr-4"
          >
            <Play className="h-4 w-4 mr-2" />
            Start
          </Button>
        )}
        {!canStart && canPause && (
          <div className="inline-flex items-center gap-1 ml-4">
            <Button
              onClick={handlePause}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title="Pause (Ctrl+Break)"
              aria-label="Pause"
            >
              <Pause className="h-4 w-4" />
            </Button>
          </div>
        )}
        {/* Step buttons group with tighter spacing */}
        {canStep && (
          <div className="inline-flex items-center gap-1 ml-4">
            <div className="inline-flex">
              <Button
                onClick={handleGo}
                disabled={busyAction !== null}
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
                    disabled={busyAction !== null}
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
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title={`Step Over (${getKeybinding("debug.stepOver")})`}
              aria-label="Step Over"
            >
              <MoveRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepIn}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title={`Step In (${getKeybinding("debug.stepIn")})`}
              aria-label="Step In"
            >
              <CornerDownRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepOut}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title={`Step Out (${getKeybinding("debug.stepOut")})`}
              aria-label="Step Out"
            >
              <CornerUpLeft className="h-4 w-4" />
            </Button>
          </div>
        )}

        {canStop && (
          <Button
            onClick={handleStop}
            disabled={busyAction === "stop"}
            size="sm"
            variant="destructive"
            className="ml-4 mr-4"
          >
            <Square className="h-4 w-4 mr-2" />
            {busyAction === "stop" ? "Stopping..." : "Stop"}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">Windows</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            {(() => {
              const activeTabs = dockingRef.current?.getActiveTabs?.() || [];
              const active = new Set<string>(activeTabs);
              return (
                <>
                  <DropdownMenuCheckboxItem
                    checked={active.has('disassembly')}
                    onCheckedChange={() => toggleTab('disassembly')}
                  >
                    <span className="flex-1">Disassembly</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.disassembly")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('registers')}
                    onCheckedChange={() => toggleTab('registers')}
                  >
                    <span className="flex-1">Registers</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.registers")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('modules')}
                    onCheckedChange={() => toggleTab('modules')}
                  >
                    <span className="flex-1">Modules</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.modules")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('threads')}
                    onCheckedChange={() => toggleTab('threads')}
                  >
                    <span className="flex-1">Threads</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.threads")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('callstack')}
                    onCheckedChange={() => toggleTab('callstack')}
                  >
                    <span className="flex-1">Call Stack</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.callstack")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('symbols')}
                    onCheckedChange={() => toggleTab('symbols')}
                  >
                    <span className="flex-1">Symbols</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.symbols")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('memory_regions')}
                    onCheckedChange={() => toggleTab('memory_regions')}
                  >
                    <span className="flex-1">Memory Regions</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.memoryRegions")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('breakpoints')}
                    onCheckedChange={() => toggleTab('breakpoints')}
                  >
                    <span className="flex-1">Breakpoints</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.breakpoints")}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('peviewer')}
                    onCheckedChange={() => toggleTab('peviewer')}
                  >
                    <span className="flex-1">PE Viewer</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.peViewer")}</span>
                  </DropdownMenuCheckboxItem>
                  {addNewMemoryTab && (
                    <DropdownMenuItem onSelect={(e: Event) => { e.preventDefault(); addNewMemoryTab(); }}>
                      <Plus />
                      <span className="flex-1">Add Memory Window</span>
                      <span className="ml-auto text-xs text-muted-foreground">{getKeybinding("panel.addMemory")}</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={(e: Event) => { e.preventDefault(); resetLayout(); }}>
                    Reset Layout
                  </DropdownMenuItem>
                </>
              );
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
