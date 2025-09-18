import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Square, Play, MoveRight, CornerDownRight, CornerUpLeft, Pause } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { DebugSession, SessionStatus } from '@/contexts/SessionContext';

export interface SessionHeaderProps {
  session: DebugSession;
  busyAction: "go" | "stepIn" | "stepOut" | "stepOver" | "stop" | "pause" | null;
  handleGo: () => void;
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
}

export const SessionHeader: React.FC<SessionHeaderProps> = ({
  session,
  busyAction,
  handleGo,
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
  dockingRef,
}) => {
  const navigate = useNavigate();

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
          <div className="inline-flex items-center gap-1">
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
          <div className="inline-flex items-center gap-1">
            <Button
              onClick={handleGo}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title="Go (F5)"
              aria-label="Go"
            >
              <Play className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepOver}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title="Step Over (F10)"
              aria-label="Step Over"
            >
              <MoveRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepIn}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title="Step In (F11)"
              aria-label="Step In"
            >
              <CornerDownRight className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleStepOut}
              disabled={busyAction !== null}
              size="sm"
              variant="default"
              title="Step Out (Shift+F11)"
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
                    Disassembly
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('registers')}
                    onCheckedChange={() => toggleTab('registers')}
                  >
                    Registers
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('modules')}
                    onCheckedChange={() => toggleTab('modules')}
                  >
                    Modules
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('threads')}
                    onCheckedChange={() => toggleTab('threads')}
                  >
                    Threads
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('callstack')}
                    onCheckedChange={() => toggleTab('callstack')}
                  >
                    Call Stack
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={active.has('symbols')}
                    onCheckedChange={() => toggleTab('symbols')}
                  >
                    Symbols
                  </DropdownMenuCheckboxItem>
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