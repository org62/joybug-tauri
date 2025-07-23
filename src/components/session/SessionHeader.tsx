import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Square, ChevronRight, Play } from 'lucide-react';
import { DebugSession, SessionStatus } from '@/contexts/SessionContext';

interface SessionHeaderProps {
  session: DebugSession;
  isProcessing: boolean;
  isSteppingIn: boolean;
  isStopping: boolean;
  handleGo: () => void;
  handleStepIn: () => void;
  handleStop: () => void;
  handleStart: () => void;
  canStep: boolean;
  canStop: boolean;
  canStart: boolean;
  dockingRef: React.RefObject<any>; // rc-dock doesn't export DockingLayoutRef type properly
  getStatusBadge: (status: SessionStatus) => React.ReactNode;
}

export const SessionHeader: React.FC<SessionHeaderProps> = ({
  session,
  isProcessing,
  isSteppingIn,
  isStopping,
  handleGo,
  handleStepIn,
  handleStop,
  handleStart,
  canStep,
  canStop,
  canStart,
  dockingRef,
  getStatusBadge,
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
      
      <div className="flex items-center gap-2">
        {canStart && (
          <Button
            onClick={handleStart}
            size="sm"
            variant="outline"
          >
            <Play className="h-4 w-4 mr-2" />
            Start
          </Button>
        )}
        {canStep && (
          <Button
            onClick={handleGo}
            disabled={isProcessing}
            size="sm"
            variant="default"
          >
            <ChevronRight className="h-4 w-4 mr-2" />
            {isProcessing ? "Processing..." : "Go (F8)"}
          </Button>
        )}
        {canStep && (
          <Button
            onClick={handleStepIn}
            disabled={isSteppingIn}
            size="sm"
            variant="default"
          >
            <ChevronRight className="h-4 w-4 mr-2" />
            {isSteppingIn ? "Stepping..." : "Step In (F7)"}
          </Button>
        )}
        
        {canStop && (
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

        <div className="ml-2 flex gap-1">
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
          <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("callstack")} title="Show Call Stack (Ctrl+C)">
            C
          </Button>
          <Button variant="outline" size="sm" onClick={() => dockingRef.current?.toggleTab("symbols")} title="Show Symbols (Ctrl+S)">
            S
          </Button>
          <Button variant="outline" size="sm" onClick={() => dockingRef.current?.resetLayout()} title="Reset Layout">
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
};