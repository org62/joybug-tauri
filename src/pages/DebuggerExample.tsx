import React from "react";
import { Button } from "@/components/ui/button";
import { 
  Play, 
  Pause, 
  Square, 
  SkipForward, 
  ChevronRight, 
  MemoryStick
} from "lucide-react";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DebuggerDockingConfig } from "@/lib/dockingConfigs";

export default function DebuggerExample() {
  const dockingRef = React.useRef<DockingLayoutRef>(null);

  const handleShowRegisters = () => {
    dockingRef.current?.toggleTab("registers");
  };

  const handleShowMemory = () => {
    dockingRef.current?.toggleTab("memory");
  };

  const handleShowStack = () => {
    dockingRef.current?.toggleTab("stack");
  };

  const handleShowConsole = () => {
    dockingRef.current?.toggleTab("console");
  };

  const handleShowDisassembly = () => {
    dockingRef.current?.toggleTab("disassembly");
  };

  const handleResetLayout = () => {
    dockingRef.current?.resetLayout();
  };

  // Hotkey handler
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle hotkeys if Ctrl is pressed
      if (!event.ctrlKey) return;

      // Prevent default browser behavior for our hotkeys
      switch (event.key.toLowerCase()) {
        case 'd':
          event.preventDefault();
          handleShowDisassembly();
          break;
        case 'r':
          event.preventDefault();
          handleShowRegisters();
          break;
        case 'm':
          event.preventDefault();
          handleShowMemory();
          break;
        case 's':
          event.preventDefault();
          handleShowStack();
          break;
        case 'c':
          event.preventDefault();
          handleShowConsole();
          break;
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup event listener on component unmount
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Empty dependency array means this effect runs once on mount and cleanup on unmount

  return (
    <div
      style={{
        position: "absolute",
        left: 10,
        top: 80,
        right: 10,
        bottom: 10,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Debugger Controls */}
      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        {/* Execution Controls */}
        <div style={{ display: "flex", gap: "0.25rem", marginRight: "1rem" }}>
          <Button variant="outline" size="sm">
            <Play className="h-4 w-4 mr-1" />
            Run
          </Button>
          <Button variant="outline" size="sm">
            <Pause className="h-4 w-4 mr-1" />
            Pause
          </Button>
          <Button variant="outline" size="sm">
            <Square className="h-4 w-4 mr-1" />
            Stop
          </Button>
          <Button variant="outline" size="sm">
            <SkipForward className="h-4 w-4 mr-1" />
            Step
          </Button>
          <Button variant="outline" size="sm">
            <ChevronRight className="h-4 w-4 mr-1" />
            Step Over
          </Button>
        </div>

        {/* View Controls */}
        <div style={{ display: "flex", gap: "0.25rem", marginRight: "1rem" }}>
          <Button variant="outline" size="icon" onClick={handleShowDisassembly} title="Show Disassembly (Ctrl+D)">
            <div className="h-4 w-4 flex items-center justify-center text-xs font-bold">D</div>
          </Button>
          <Button variant="outline" size="icon" onClick={handleShowRegisters} title="Show Registers (Ctrl+R)">
            <div className="h-4 w-4 flex items-center justify-center text-xs font-bold">R</div>
          </Button>
          <Button variant="outline" size="icon" onClick={handleShowMemory} title="Show Memory (Ctrl+M)">
            <MemoryStick className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleShowStack} title="Show Stack (Ctrl+S)">
            <div className="h-4 w-4 flex items-center justify-center text-xs font-bold">S</div>
          </Button>
          <Button variant="outline" size="icon" onClick={handleShowConsole} title="Show Console (Ctrl+C)">
            <div className="h-4 w-4 flex items-center justify-center text-xs font-bold">C</div>
          </Button>
        </div>

        {/* Layout Controls */}
        <Button variant="outline" size="sm" onClick={handleResetLayout}>
          Reset Layout
        </Button>
      </div>

      {/* Docking Layout */}
      <div style={{ flex: 1, position: "relative" }}>
        <DockingLayout
          ref={dockingRef}
          {...DebuggerDockingConfig}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
          }}
        />
      </div>
    </div>
  );
} 