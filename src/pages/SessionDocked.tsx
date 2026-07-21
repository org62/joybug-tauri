import React, { useRef, useMemo, useEffect, useState, useLayoutEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { disassemblyNavigation, memoryNavigation, memoryRegionsNavigation, sourceNavigation, panelFocus, peviewerModuleNavigation, typesNavigation } from "@/lib/navigationStore";
import {
  SESSION_TAB_DEFS, SESSION_TAB_CATEGORIES, SESSION_TAB_BY_ACTION, sessionTabDefFor,
  type SessionTabId,
} from "@/lib/sessionTabs";
import { sessionNavHistory } from "@/lib/navHistory";
import { useNavHistoryDock } from "@/hooks/useNavHistoryDock";
import { parseAddress, type ViewMode } from "@/lib/hexUtils";
import { ArrowLeft, AlertCircle } from "lucide-react";
import DockingLayout, { DockingLayoutRef } from "@/components/DockingLayout";
import { DebuggerDockingConfig } from "@/lib/dockingConfigs";
import { TabData } from "rc-dock";
import { SessionContext, SessionStatus } from "@/contexts/SessionContext";
import { isProcessAvailable, isTargetLive } from "@/lib/sessionHelpers";
import { ContextAssemblyView } from "@/components/session/ContextAssemblyView";
import { ContextSourceView } from "@/components/session/ContextSourceView";
import { ContextRegisterView } from "@/components/session/ContextRegisterView";
import { ContextModulesView } from "@/components/session/ContextModulesView";
import { ContextThreadsView } from "@/components/session/ContextThreadsView";
import { ContextCallStackView } from "@/components/session/ContextCallStackView";
import { ContextSymbolsView } from "@/components/session/ContextSymbolsView";
import { ContextTypesView } from "@/components/session/ContextTypesView";
import { ContextHexView } from "@/components/session/ContextHexView";
import { ContextMemoryRegionsView } from "@/components/session/ContextMemoryRegionsView";
import { ContextBreakpointsView } from "@/components/session/ContextBreakpointsView";
import { ContextPatchesView } from "@/components/session/ContextPatchesView";
import { ContextImagePatchesView } from "@/components/session/ContextImagePatchesView";
import { ContextBookmarksView } from "@/components/session/ContextBookmarksView";
import { ContextMemorySearchView } from "@/components/session/ContextMemorySearchView";
import { ContextMemoryScannerView } from "@/components/session/ContextMemoryScannerView";
import { ContextPointerScanView } from "@/components/session/ContextPointerScanView";
import { ContextStringsView } from "@/components/session/ContextStringsView";
import { ContextCodeExplorerView } from "@/components/session/ContextCodeExplorerView";
import { ContextModuleInfoView } from "@/components/session/ContextModuleInfoView";
import { ContextWatchpointAccessView } from "@/components/session/ContextWatchpointAccessView";
import { useDebugSession } from "@/hooks/useDebugSession";
import { useBreakpoints } from "@/hooks/useBreakpoints";
import { useWatchpointTrace } from "@/hooks/useWatchpointTrace";
import { usePatches } from "@/hooks/usePatches";
import { useBookmarks } from "@/hooks/useBookmarks";
import { SessionHeader } from "@/components/session/SessionHeader";
import { useKeybindingContext } from "@/contexts/KeybindingContext";
import { keyboardEventToChord } from "@/lib/keybindings";
import { useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import type { PaletteCommand } from "@/contexts/CommandPaletteContext";
import {
  Play, Square, Pause, ArrowDownToLine, CornerDownRight, ArrowUpFromLine, SkipForward,
  Plus, RotateCcw, Navigation,
} from "lucide-react";

export default function SessionDocked() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const dockingRef = useRef<DockingLayoutRef>(null);
  const [isDockingReady, setIsDockingReady] = useState(false);

  const {
    session,
    displayStatus,
    isLoading,
    busyAction,
    modules,
    threads,
    symbolStatuses,
    symbolsRefreshKey,
    loadModules,
    loadThreads,
    loadModulePdb,
    retryModuleSymbols,
    searchSymbols,
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
  } = useDebugSession(sessionId);

  // Function to sync window states with backend
  const syncWindowStates = async (activeTabIds: string[]) => {
    if (!sessionId) return;
    
    const isDisassemblyOpen = activeTabIds.includes("disassembly");
    const isRegistersOpen = activeTabIds.includes("registers");
    const isCallstackOpen = activeTabIds.includes("callstack");

    console.log("Syncing window states:", {
      sessionId,
      activeTabIds,
      disassembly: isDisassemblyOpen,
      registers: isRegistersOpen,
      callstack: isCallstackOpen
    });

    try {
      await Promise.all([
        invoke("update_window_state", {
          sessionId,
          windowType: "disassembly",
          isOpen: isDisassemblyOpen,
        }),
        invoke("update_window_state", {
          sessionId,
          windowType: "registers", 
          isOpen: isRegistersOpen,
        }),
        invoke("update_window_state", {
          sessionId,
          windowType: "callstack",
          isOpen: isCallstackOpen,
        }),
      ]);
    } catch (error) {
      console.error("Failed to sync window states:", error);
    }
  };

  // Handle tab changes (opens/closes)
  const handleTabsChanged = async (activeTabIds: string[]) => {
    // Mark docking as ready on first callback
    if (!isDockingReady) {
      setIsDockingReady(true);
    }
    await syncWindowStates(activeTabIds);
  };

  // Toggle (open ⇄ close) — only the Windows menu checkboxes still mean this.
  // onTabsChanged handles backend sync.
  const toggleTabWithBackendUpdate = React.useCallback((tabId: string) => {
    dockingRef.current?.toggleTab(tabId);
  }, []);

  // Quick navigation: activate the tab, opening it at its home if closed, and
  // never closing it. Used by the palette and every panel keyboard chord.
  // The focus request is only claimed by a view that registered its primary
  // input via usePanelFocus(tabId); for other tabs it's inert.
  const goToTab = React.useCallback((tabId: string) => {
    dockingRef.current?.showTab(tabId);
    panelFocus.request(tabId);
  }, []);

  // Where a tab lands when opened into a layout that lacks it: next to a tab
  // sharing its home (so it rejoins the group wherever the user dragged it),
  // else the home panel itself.
  const placement = React.useCallback((tabId: string) => {
    const def = sessionTabDefFor(tabId);
    if (!def) return undefined;
    return {
      homePanelId: def.home,
      siblingTabIds: SESSION_TAB_DEFS
        .filter((d) => d.home === def.home && d.id !== def.id)
        .map((d) => d.id),
    };
  }, []);

  // Simple reset function - onTabsChanged will handle backend sync
  const handleResetLayout = React.useCallback(() => {
    dockingRef.current?.resetLayout();
  }, []);

  // Close the currently focused dock tab
  const handleCloseActiveTab = React.useCallback(() => {
    dockingRef.current?.closeActiveTab();
  }, []);

  // Add a new memory tab
  const handleAddNewMemoryTab = React.useCallback(() => {
    dockingRef.current?.addTypedTab('memory', (tabId) => (
      <ContextHexView memoryViewId={tabId} />
    ));
  }, []);

  // Navigate to disassembly at a specific address (from symbol click)
  const handleNavigateToDisassembly = React.useCallback((address: string) => {
    sessionNavHistory.recordJumpToDisasm();
    dockingRef.current?.showTab('disassembly');
    disassemblyNavigation.request(address);
  }, []);

  // Activate the Source tab and reveal an address's source line.
  const handleNavigateToSource = React.useCallback((address: string) => {
    dockingRef.current?.showTab('source');
    sourceNavigation.request(address);
  }, []);

  // Navigate to memory view at a specific address, reusing an existing tab if open.
  // initialViewMode is used only when creating a new tab (no existing memory tab).
  const navigateToMemoryTab = React.useCallback((address: string, initialViewMode?: ViewMode) => {
    const activeTabs = dockingRef.current?.getActiveTabs() ?? [];
    const existingMemoryTab = activeTabs.find(id => id === 'memory' || id.startsWith('memory-'));
    if (existingMemoryTab) {
      dockingRef.current?.showTab(existingMemoryTab);
      memoryNavigation.request(address);
    } else {
      dockingRef.current?.addTypedTab('memory', (tabId) => (
        <ContextHexView memoryViewId={tabId} initialAddress={parseAddress(address) ?? undefined} initialViewMode={initialViewMode} />
      ));
    }
  }, []);

  const handleNavigateToMemory = React.useCallback((address: string) => {
    navigateToMemoryTab(address);
  }, [navigateToMemoryTab]);

  const handleNavigateToMemoryPointer = React.useCallback((address: string) => {
    navigateToMemoryTab(address, "pointer");
  }, [navigateToMemoryTab]);

  // Activate the Memory Regions tab and highlight the region containing the address.
  const handleNavigateToMemoryRegion = React.useCallback((address: string) => {
    dockingRef.current?.showTab('memory_regions');
    memoryRegionsNavigation.request(address);
  }, []);

  // Open the PE Viewer tab (singleton) and select a module in it.
  const handleOpenModuleInfo = React.useCallback((moduleBase: string) => {
    dockingRef.current?.showTab('peviewer');
    peviewerModuleNavigation.request(moduleBase);
  }, []);

  // Open the Access Trace panel (singleton) — focus it if already open.
  const handleOpenAccessTrace = React.useCallback(() => {
    dockingRef.current?.showTab('access_trace');
  }, []);

  // Open the Types tab with a named type overlaid on an address (e.g. a thread's TEB).
  const handleNavigateToType = React.useCallback((typeName: string, address: string) => {
    dockingRef.current?.showTab('types');
    typesNavigation.request({ typeName, address });
  }, []);

  // Initial state detection - sync when docking becomes ready
  useEffect(() => {
    if (!sessionId || !isDockingReady || !dockingRef.current) return;
    
    // Sync initial state immediately when docking is ready
    const activeTabIds = dockingRef.current.getActiveTabs();
    syncWindowStates(activeTabIds);
  }, [sessionId, isDockingReady]); // Trigger when docking becomes ready

  // Fallback: Check if docking is ready after layout updates
  useLayoutEffect(() => {
    if (!sessionId || isDockingReady || !dockingRef.current) return;
    
    // If docking ref is available but not marked as ready, sync now
    const activeTabIds = dockingRef.current.getActiveTabs();
    if (activeTabIds.length > 0 || dockingRef.current) {
      setIsDockingReady(true);
      syncWindowStates(activeTabIds);
    }
  }, [sessionId, isDockingReady]); // Check after each layout update

  // Unified navigation history: controller, tab-switch recording, mouse buttons.
  const { onTabSwitch } = useNavHistoryDock(sessionNavHistory, dockingRef);

  // History belongs to one debug session — a different session's addresses and
  // tab trail would be stale.
  useEffect(() => {
    sessionNavHistory.clear();
    return () => sessionNavHistory.clear();
  }, [sessionId]);

  // Hotkey handlers — chord-based lookup via keybinding context
  const { reverseLookup } = useKeybindingContext();
  const { registerCommands, setOpen, enterSubInput } = useCommandPaletteContext();

  // Pass-exception only makes sense while paused on an exception event.
  const canPassException = canStep && session?.current_event?.event_type === "Exception";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const chord = keyboardEventToChord(event);
      if (!chord) return;

      const action = reverseLookup.get(chord);
      if (!action) return;

      // Panel chords mean "go there", never "close" — same as the palette. Ctrl+W
      // (panel.closeTab) is the affordance for dismissing the tab you're on.
      const tabDef = SESSION_TAB_BY_ACTION.get(action);
      if (tabDef) {
        event.preventDefault();
        event.stopPropagation();
        goToTab(tabDef.id);
        return;
      }

      switch (action) {
        // Debug stepping. The go key toggles execution: continue when paused,
        // break in while running, start when the session is stopped.
        case "debug.go":
          event.preventDefault();
          event.stopPropagation();
          if (canStep) handleGo();
          else if (canPause) handlePause();
          else if (canStart) handleStart();
          break;
        case "debug.goPassException":
          event.preventDefault();
          event.stopPropagation();
          if (canPassException) handleGoPassException();
          break;
        case "debug.stepIn":
          event.preventDefault();
          event.stopPropagation();
          handleStepIn();
          break;
        case "debug.stepOver":
          event.preventDefault();
          event.stopPropagation();
          handleStepOver();
          break;
        case "debug.stepOut":
          event.preventDefault();
          event.stopPropagation();
          handleStepOut();
          break;
        case "panel.addMemory":
          event.preventDefault();
          event.stopPropagation();
          handleAddNewMemoryTab();
          break;
        case "panel.closeTab":
          event.preventDefault();
          event.stopPropagation();
          handleCloseActiveTab();
          break;
        // Unified back/forward — one chronological history of user navigation
        // actions (disassembly follows and tab switches alike).
        case "assembly.goBack":
          event.preventDefault();
          event.stopPropagation();
          sessionNavHistory.goBack();
          break;
        case "assembly.goForward":
          event.preventDefault();
          event.stopPropagation();
          sessionNavHistory.goForward();
          break;
        // Navigate actions
        case "navigate.goToDisassembly":
          event.preventDefault();
          event.stopPropagation();
          enterSubInput({
            label: "Go to Address (Disassembly)",
            placeholder: "Enter address or symbol (e.g. 0x00007FF...)",
            onSubmit: handleNavigateToDisassembly,
          });
          setOpen(true);
          break;
        case "navigate.goToMemory":
          event.preventDefault();
          event.stopPropagation();
          enterSubInput({
            label: "Go to Address (Memory)",
            placeholder: "Enter address or symbol (e.g. 0x00007FF...)",
            onSubmit: handleNavigateToMemory,
          });
          setOpen(true);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleGo, handleGoPassException, handlePause, handleStart, canStep, canPassException, canPause, canStart, handleStepIn, handleStepOver, handleStepOut, goToTab, handleAddNewMemoryTab, handleCloseActiveTab, reverseLookup, setOpen, enterSubInput, handleNavigateToDisassembly, handleNavigateToMemory]);

  const isPaused = displayStatus === 'Paused';
  // Memory/enumeration ops work over OOB whenever a process is available: paused,
  // running (invasive), or a non-invasive Open session. They never need a pause.
  const canUseMemoryOps = isProcessAvailable(displayStatus);

  // ── Command palette registration ──────────────────────────────────────────
  useEffect(() => {
    const commands: PaletteCommand[] = [
      // Session lifecycle
      {
        id: "session.start",
        label: "Start Session",
        group: "Session",
        icon: <Play className="size-4" />,
        onSelect: handleStart,
        enabled: canStart,
        keywords: ["run", "launch", "start"],
      },
      {
        id: "session.stop",
        label: "Stop Session",
        group: "Session",
        icon: <Square className="size-4" />,
        onSelect: handleStop,
        enabled: canStop,
        keywords: ["stop", "terminate", "kill"],
      },
      {
        id: "session.pause",
        label: "Pause Session",
        group: "Session",
        icon: <Pause className="size-4" />,
        onSelect: handlePause,
        enabled: canPause,
        keywords: ["pause", "break", "interrupt"],
      },
      // Debug stepping
      {
        id: "debug.go",
        label: "Go / Continue",
        group: "Debug",
        icon: <SkipForward className="size-4" />,
        keybindingAction: "debug.go",
        onSelect: handleGo,
        enabled: canStep,
        keywords: ["continue", "resume", "run"],
      },
      {
        id: "debug.goPassException",
        label: "Go (Pass Exception)",
        group: "Debug",
        icon: <SkipForward className="size-4" />,
        keybindingAction: "debug.goPassException",
        onSelect: handleGoPassException,
        enabled: canPassException,
        keywords: ["continue", "pass", "exception", "forward"],
      },
      {
        id: "debug.stepIn",
        label: "Step Into",
        group: "Debug",
        icon: <ArrowDownToLine className="size-4" />,
        keybindingAction: "debug.stepIn",
        onSelect: handleStepIn,
        enabled: canStep,
        keywords: ["step", "into", "trace"],
      },
      {
        id: "debug.stepOver",
        label: "Step Over",
        group: "Debug",
        icon: <CornerDownRight className="size-4" />,
        keybindingAction: "debug.stepOver",
        onSelect: handleStepOver,
        enabled: canStep,
        keywords: ["step", "over", "next"],
      },
      {
        id: "debug.stepOut",
        label: "Step Out",
        group: "Debug",
        icon: <ArrowUpFromLine className="size-4" />,
        keybindingAction: "debug.stepOut",
        onSelect: handleStepOut,
        enabled: canStep,
        keywords: ["step", "out", "return"],
      },
      // Window navigation — one "Go to X" per registered tab, emitted in
      // category order so the palette's first-seen-order grouping yields the
      // right section order. Never closes a tab; the Windows menu does that.
      ...SESSION_TAB_CATEGORIES.flatMap((category) =>
        SESSION_TAB_DEFS.filter((d) => d.category === category).map((d): PaletteCommand => ({
          id: `panel.${d.id}`,
          label: `Go to ${d.title}`,
          group: `Windows · ${d.category}`,
          icon: d.icon,
          keybindingAction: d.action,
          onSelect: () => goToTab(d.id),
          keywords: d.keywords ? [...d.keywords] : undefined,
        })),
      ),
      {
        id: "panel.addMemory",
        label: "Add Memory Window",
        group: "Windows · Memory",
        icon: <Plus className="size-4" />,
        keybindingAction: "panel.addMemory",
        onSelect: handleAddNewMemoryTab,
        keywords: ["memory", "hex", "add", "new"],
      },
      {
        id: "panel.resetLayout",
        label: "Reset Layout",
        group: "Windows",
        icon: <RotateCcw className="size-4" />,
        onSelect: handleResetLayout,
        keywords: ["reset", "layout", "default"],
      },
      // Navigate commands (sub-input mode)
      {
        id: "navigate.disassembly",
        label: "Go to Address (Disassembly)",
        group: "Navigate",
        icon: <Navigation className="size-4" />,
        keybindingAction: "navigate.goToDisassembly",
        onSelect: () => {},
        subInput: {
          placeholder: "Enter address or symbol (e.g. 0x00007FF...)",
          onSubmit: handleNavigateToDisassembly,
        },
        enabled: canUseMemoryOps,
        keywords: ["goto", "address", "disassembly", "navigate"],
      },
      {
        id: "navigate.memory",
        label: "Go to Address (Memory)",
        group: "Navigate",
        icon: <Navigation className="size-4" />,
        keybindingAction: "navigate.goToMemory",
        onSelect: () => {},
        subInput: {
          placeholder: "Enter address or symbol (e.g. 0x00007FF...)",
          onSubmit: handleNavigateToMemory,
        },
        enabled: canUseMemoryOps,
        keywords: ["goto", "address", "memory", "navigate", "hex"],
      },
    ];

    return registerCommands(commands);
  }, [
    canStart, canStop, canPause, canStep, isPaused, canUseMemoryOps, session?.current_event?.event_type,
    handleStart, handleStop, handlePause,
    handleGo, handleGoPassException, handleStepIn, handleStepOver, handleStepOut,
    handleNavigateToDisassembly, handleNavigateToMemory,
    goToTab, handleAddNewMemoryTab, handleResetLayout,
    registerCommands,
  ]);

  const breakpointState = useBreakpoints(session?.id, isPaused, session?.breakpoints);
  const patchState = usePatches(session?.id, isPaused, session?.patches);
  const bookmarkState = useBookmarks(session?.id, isPaused, session?.bookmarks, isTargetLive(displayStatus));
  const watchpointState = useWatchpointTrace(session?.id, breakpointState.breakpoints, isTargetLive(displayStatus));

  // "Find what reads/writes this address": arm a watchpoint access trace and open
  // the Access Trace panel to watch accessors accumulate.
  const handleFindAccesses = React.useCallback((address: string, mode: "Write" | "ReadWrite", size: number) => {
    watchpointState.startTrace(address, mode, size);
    handleOpenAccessTrace();
  }, [watchpointState.startTrace, handleOpenAccessTrace]);

  const contextValue = useMemo(() => ({
    session,
    displayStatus,
    canUseMemoryOps,
    modules,
    threads,
    symbolStatuses,
    symbolsRefreshKey,
    // Passed through unwrapped: views depend on these in effects, and the
    // useDebugSession callbacks are stable per session (an inline wrapper here
    // would change identity on every session-updated event and re-fire them).
    loadModules,
    loadThreads,
    loadModulePdb,
    retryModuleSymbols,
    searchSymbols: async (pattern: string, limit?: number) => { return await searchSymbols(pattern, limit); },
    breakpointState,
    patchState,
    bookmarkState,
    watchpointState,
    onNavigateToDisassembly: handleNavigateToDisassembly,
    onNavigateToMemory: handleNavigateToMemory,
    onNavigateToMemoryRegion: handleNavigateToMemoryRegion,
    onNavigateToSource: handleNavigateToSource,
    onNavigateToType: handleNavigateToType,
    onFindAccesses: handleFindAccesses,
  }), [session, displayStatus, canUseMemoryOps, modules, threads, symbolStatuses, symbolsRefreshKey, loadModules, loadThreads, loadModulePdb, retryModuleSymbols, searchSymbols, breakpointState, patchState, bookmarkState, watchpointState, handleNavigateToDisassembly, handleNavigateToMemory, handleNavigateToMemoryRegion, handleNavigateToSource, handleNavigateToType, handleFindAccesses]);
  
  // Static tab content - components will update via context.
  // Typed against the registry, so adding a tab to SESSION_TAB_DEFS without
  // wiring its content here is a compile error rather than a blank panel.
  const dynamicTabContent: Record<SessionTabId, React.ReactElement> = useMemo(() => ({
    disassembly: <ContextAssemblyView />,
    source: <ContextSourceView />,
    registers: <ContextRegisterView />,
    modules: <ContextModulesView onOpenModuleInfo={handleOpenModuleInfo} />,
    threads: <ContextThreadsView onNavigateToDisassembly={handleNavigateToDisassembly} onNavigateToMemoryPointer={handleNavigateToMemoryPointer} />,
    callstack: <ContextCallStackView onNavigateToDisassembly={handleNavigateToDisassembly} onNavigateToMemoryPointer={handleNavigateToMemoryPointer} />,
    symbols: <ContextSymbolsView />,
    types: <ContextTypesView />,
    memory: <ContextHexView memoryViewId="memory" />,
    memory_regions: <ContextMemoryRegionsView onNavigateToAddress={handleNavigateToMemory} />,
    breakpoints: <ContextBreakpointsView />,
    patches: <ContextPatchesView />,
    image_patches: <ContextImagePatchesView />,
    bookmarks: <ContextBookmarksView />,
    memory_search: <ContextMemorySearchView />,
    memory_scanner: <ContextMemoryScannerView />,
    pointer_scan: <ContextPointerScanView />,
    strings: <ContextStringsView />,
    code_explorer: <ContextCodeExplorerView />,
    peviewer: <ContextModuleInfoView />,
    access_trace: <ContextWatchpointAccessView />,
  }), [handleNavigateToMemory, handleNavigateToDisassembly, handleNavigateToMemoryPointer, handleOpenModuleInfo]);

  // Factory for creating dynamic tab content (e.g., memory tabs restored from storage)
  const tabContentFactory = React.useCallback((tabId: string): React.ReactElement | null => {
    // Handle memory tabs: "memory", "memory-1", "memory-2", etc.
    if (tabId === 'memory' || tabId.startsWith('memory-')) {
      return <ContextHexView memoryViewId={tabId} />;
    }
    return null;
  }, []);

  // Create docking configuration with dynamic content  
  const dockingConfig = useMemo(() => {
    const sessionTabContents: { [key: string]: TabData } = Object.fromEntries(
      SESSION_TAB_DEFS.map((d) => [
        d.id,
        { id: d.id, title: d.title, content: dynamicTabContent[d.id as SessionTabId], closable: true },
      ]),
    );

    return {
      storagePrefix: "session-debugger-dock", // Shared prefix for all sessions to preserve layout
      initialLayout: DebuggerDockingConfig.initialLayout,
      initialTabContents: sessionTabContents,
      tabContentMap: { ...DebuggerDockingConfig.tabContentMap, ...dynamicTabContent },
      tabContentFactory,
      placement,
    };
  }, [sessionId, dynamicTabContent, tabContentFactory, placement]);

  const getStatusBadge = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Stopped":
          return <Badge variant="secondary">Stopped</Badge>;
        case "Running":
          return <Badge variant="default" className="bg-green-600 animate-pulse">Running</Badge>;
        case "Paused":
          return <Badge variant="default" className="bg-yellow-600">Paused</Badge>;
        case "Open":
          return <Badge variant="default" className="bg-blue-600">Open (non-invasive)</Badge>;
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
          busyAction={busyAction}
          handleGo={handleGo}
          handleGoPassException={handleGoPassException}
          handleStepIn={handleStepIn}
          handleStepOver={handleStepOver}
          handleStepOut={handleStepOut}
          handleStop={handleStop}
          handleAttach={handleAttach}
          handleStart={handleStart}
          handlePause={handlePause}
          handleDetach={handleDetach}
          canStep={canStep}
          canPassException={canPassException}
          canStop={canStop}
          canStart={canStart}
          canPause={canPause}
          canDetach={canDetach}
          dockingRef={dockingRef}
          getStatusBadge={getStatusBadge}
          toggleTab={toggleTabWithBackendUpdate}
          resetLayout={handleResetLayout}
          addNewMemoryTab={handleAddNewMemoryTab}
          symbolLoadingCount={symbolStatuses.filter((s) => s.status === 'loading').length}
        />

        {/* Docking Layout */}
        <div className="relative flex-1">
          <DockingLayout
            ref={dockingRef}
            {...dockingConfig}
            className="absolute inset-0"
            onTabsChanged={handleTabsChanged}
            onTabSwitch={onTabSwitch}
          />
        </div>
      </div>
    </SessionContext.Provider>
  );
} 
