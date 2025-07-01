import React from "react";
import { Button } from "@/components/ui/button";
import { Plus, RefreshCcw, TerminalSquare } from "lucide-react";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DefaultDockingConfig } from "@/lib/dockingConfigs";

export default function RcDock() {
  const dockingRef = React.useRef<DockingLayoutRef>(null);

  const handleAddTab = () => {
    dockingRef.current?.addTab();
  };

  const handleResetLayout = () => {
    dockingRef.current?.resetLayout();
  };

  const handleToggleDisassembly = () => {
    dockingRef.current?.toggleTab("disassembly");
  };

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
      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <Button variant="outline" size="icon" onClick={handleAddTab}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={handleResetLayout}>
          <RefreshCcw className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={handleToggleDisassembly}>
          <TerminalSquare className="h-4 w-4" />
        </Button>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <DockingLayout
          ref={dockingRef}
          {...DefaultDockingConfig}
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