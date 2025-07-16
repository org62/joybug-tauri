import { useRef, useMemo, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, AlertCircle } from "lucide-react";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DebuggerDockingConfig } from "@/lib/dockingConfigs";
import { TabData } from "rc-dock";
import { SessionContext, SessionStatus } from "@/contexts/SessionContext";
import { ContextAssemblyView } from "@/components/session/ContextAssemblyView";
import { ContextRegisterView } from "@/components/session/ContextRegisterView";
import { ContextModulesView } from "@/components/session/ContextModulesView";
import { ContextThreadsView } from "@/components/session/ContextThreadsView";
import { ContextCallStackView } from "@/components/session/ContextCallStackView";
import { ContextSymbolsView } from "@/components/session/ContextSymbolsView";
import { useDebugSession } from "@/hooks/useDebugSession";
import { SessionHeader } from "@/components/session/SessionHeader";

export default function SessionDocked() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const dockingRef = useRef<DockingLayoutRef>(null);

  const {
    session,
    isLoading,
    isStepping,
    isStopping,
    modules,
    threads,
    loadModules,
    loadThreads,
    searchSymbols,
    handleStep,
    handleStop,
    handleStart,
    canStep,
    canStop,
    canStart,
  } = useDebugSession(sessionId);

  // Hotkey handlers
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F8') {
        event.preventDefault();
        event.stopPropagation();
        handleStep();
        return;
      }
      
      if (!event.ctrlKey) return;

      // Only handle single Ctrl+key combinations (not Ctrl+Shift+key)
      if (event.shiftKey) return;

      switch (event.key.toLowerCase()) {
        case 'd':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("disassembly");
          break;
        case 'r':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("registers");
          break;
        case 'm':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("modules");
          break;
        case 't':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("threads");
          break;
        case 'c':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("callstack");
          break;
        case 's':
          event.preventDefault();
          event.stopPropagation();
          dockingRef.current?.toggleTab("symbols");
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStep]);

  const contextValue = useMemo(() => ({
    session,
    modules,
    threads,
    loadModules: async () => { await loadModules(); },
    loadThreads: async () => { await loadThreads(); },
    searchSymbols: async (pattern: string, limit?: number) => { return await searchSymbols(pattern, limit); }
  }), [session, modules, threads, loadModules, loadThreads, searchSymbols]);
  
  // Static tab content - components will update via context
  const dynamicTabContent = useMemo(() => ({
    disassembly: <ContextAssemblyView />,
    registers: <ContextRegisterView />,
    modules: <ContextModulesView />,
    threads: <ContextThreadsView />,
    callstack: <ContextCallStackView />,
    symbols: <ContextSymbolsView />,
  }), []);

  // Create docking configuration with dynamic content  
  const dockingConfig = useMemo(() => {
    const sessionTabContents: { [key: string]: TabData } = {
      disassembly: {
        id: "disassembly",
        title: "Disassembly",
        content: dynamicTabContent.disassembly,
        closable: true,
      },
      registers: {
        id: "registers",
        title: "Registers",
        content: dynamicTabContent.registers,
        closable: true,
      },
      modules: {
        id: "modules",
        title: "Modules",
        content: dynamicTabContent.modules,
        closable: true,
      },
      threads: {
        id: "threads",
        title: "Threads",
        content: dynamicTabContent.threads,
        closable: true,
      },
      callstack: {
        id: "callstack",
        title: "Call Stack",
        content: dynamicTabContent.callstack,
        closable: true,
      },
      symbols: {
        id: "symbols",
        title: "Symbols",
        content: dynamicTabContent.symbols,
        closable: true,
      },
    };

    return {
      storagePrefix: "session-debugger-dock", // Shared prefix for all sessions to preserve layout
      initialLayout: DebuggerDockingConfig.initialLayout,
      initialTabContents: sessionTabContents,
      tabContentMap: { ...DebuggerDockingConfig.tabContentMap, ...dynamicTabContent },
    };
  }, [sessionId, dynamicTabContent]);

  const getStatusBadge = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Created":
          return <Badge variant="secondary">Created</Badge>;
        case "Connecting":
          return <Badge variant="outline" className="animate-pulse">Connecting...</Badge>;
        case "Connected":
          return <Badge variant="default" className="bg-blue-600">Connected</Badge>;
        case "Running":
          return <Badge variant="default" className="bg-green-600 animate-pulse">Running</Badge>;
        case "Paused":
          return <Badge variant="default" className="bg-yellow-600">Paused</Badge>;
        case "Finished":
          return <Badge variant="outline">Finished</Badge>;
        default:
          return <Badge variant="secondary">{status}</Badge>;
      }
    } else {
      return <Badge variant="destructive">Error</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="flex items-center gap-2">
          <div className="animate-spin h-6 w-6 border-2 border-current border-t-transparent rounded-full" />
          <span>Loading session...</span>
        </div>
      </div>
    );
  }

  if (!sessionId || !session) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-500" />
          <h1 className="text-2xl font-bold text-red-600 mb-2">Session Not Found</h1>
          <p className="text-muted-foreground mb-4">
            The requested debug session could not be found or has been removed.
          </p>
          <Button onClick={() => navigate("/debugger")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Debugger
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={contextValue}>
      <div
        className="absolute flex flex-col"
        style={{
          left: 10,
          top: 80,
          right: 10,
          bottom: 10,
        }}
      >
        <SessionHeader
          session={session}
          isStepping={isStepping}
          isStopping={isStopping}
          handleStep={handleStep}
          handleStop={handleStop}
          handleStart={handleStart}
          canStep={canStep}
          canStop={canStop}
          canStart={canStart}
          dockingRef={dockingRef}
          getStatusBadge={getStatusBadge}
        />

        {/* Docking Layout */}
        <div className="relative flex-1">
          <DockingLayout
            ref={dockingRef}
            {...dockingConfig}
            className="absolute inset-0"
          />
        </div>
      </div>
    </SessionContext.Provider>
  );
} 