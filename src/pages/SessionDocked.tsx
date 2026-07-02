import React, { useRef, useMemo, useEffect, useState, useLayoutEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { disassemblyNavigation, memoryNavigation } from "@/lib/navigationStore";
import { setMouseNavHandler } from "@/lib/mouseNav";
import { parseAddress, type ViewMode } from "@/lib/hexUtils";
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
import { ContextHexView } from "@/components/session/ContextHexView";
import { ContextMemoryRegionsView } from "@/components/session/ContextMemoryRegionsView";
import { ContextBreakpointsView } from "@/components/session/ContextBreakpointsView";
import { ContextPatchesView } from "@/components/session/ContextPatchesView";
import { ContextBookmarksView } from "@/components/session/ContextBookmarksView";
import { ContextMemorySearchView } from "@/components/session/ContextMemorySearchView";
import { ContextMemoryScannerView } from "@/components/session/ContextMemoryScannerView";
import { ContextPointerScanView } from "@/components/session/ContextPointerScanView";
import { ContextModuleInfoView } from "@/components/session/ContextModuleInfoView";
import { useDebugSession } from "@/hooks/useDebugSession";
import { useBreakpoints } from "@/hooks/useBreakpoints";
import { usePatches } from "@/hooks/usePatches";
import { useBookmarks } from "@/hooks/useBookmarks";
import { SessionHeader } from "@/components/session/SessionHeader";
import { useKeybindingContext } from "@/contexts/KeybindingContext";
import { keyboardEventToChord } from "@/lib/keybindings";
import { useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import type { PaletteCommand } from "@/contexts/CommandPaletteContext";
import {
  Play, Square, Pause, ArrowDownToLine, CornerDownRight, ArrowUpFromLine, SkipForward,
  Code, Cpu, Box, Layers, ListTree, Search, HardDrive, MapPin, FileCode,
  Plus, RotateCcw, Navigation, ScanSearch, Puzzle, Crosshair, Bookmark as BookmarkIcon,
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
    loadModules,
    loadThreads,
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

  // Simple toggle function - onTabsChanged will handle backend sync
  const toggleTabWithBackendUpdate = React.useCallback((tabId: string) => {
    dockingRef.current?.toggleTab(tabId);
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
    dockingRef.current?.showTab('disassembly');
    disassemblyNavigation.request(address);
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

  // Open PE Viewer tab (singleton) — if already open, focus it and dispatch module selection
  const handleOpenModuleInfo = React.useCallback((moduleBase: string) => {
    const activeTabs = dockingRef.current?.getActiveTabs() ?? [];
    if (activeTabs.includes('peviewer')) {
      dockingRef.current?.showTab('peviewer');
      window.dispatchEvent(new CustomEvent('select-peviewer-module', { detail: moduleBase }));
    } else {
      dockingRef.current?.toggleTab('peviewer');
      // Dispatch after a tick so the component mounts first
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('select-peviewer-module', { detail: moduleBase }));
      }, 0);
    }
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

  // Mouse back/forward buttons navigate dock tab history. Returns true when a tab switch
  // happened so main.tsx blocks the native page navigation; false (empty history) lets the
  // press fall through to router navigation. Unregisters on unmount, so leaving the session
  // for a real page (e.g. /logs) restores normal back/forward page navigation.
  useEffect(() => {
    return setMouseNavHandler((dir) =>
      dir === 'back'
        ? !!dockingRef.current?.goBackTab()
        : !!dockingRef.current?.goForwardTab()
    );
  }, []);

  // Hotkey handlers — chord-based lookup via keybinding context
  const { reverseLookup } = useKeybindingContext();
  const { registerCommands, setOpen, enterSubInput } = useCommandPaletteContext();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const chord = keyboardEventToChord(event);
      if (!chord) return;

      const action = reverseLookup.get(chord);
      if (!action) return;

      switch (action) {
        // Debug stepping
        case "debug.go":
          event.preventDefault();
          event.stopPropagation();
          handleGo();
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
        // Panel toggles
        case "panel.disassembly":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("disassembly");
          break;
        case "panel.registers":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("registers");
          break;
        case "panel.modules":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("modules");
          break;
        case "panel.threads":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("threads");
          break;
        case "panel.callstack":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("callstack");
          break;
        case "panel.symbols":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("symbols");
          break;
        case "panel.addMemory":
          event.preventDefault();
          event.stopPropagation();
          handleAddNewMemoryTab();
          break;
        case "panel.memoryRegions":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("memory_regions");
          break;
        case "panel.breakpoints":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("breakpoints");
          break;
        case "panel.patches":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("patches");
          break;
        case "panel.bookmarks":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("bookmarks");
          break;
        case "panel.memorySearch":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("memory_search");
          break;
        case "panel.memoryScanner":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("memory_scanner");
          break;
        case "panel.pointerScan":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("pointer_scan");
          break;
        case "panel.peViewer":
          event.preventDefault();
          event.stopPropagation();
          toggleTabWithBackendUpdate("peviewer");
          break;
        case "panel.closeTab":
          event.preventDefault();
          event.stopPropagation();
          handleCloseActiveTab();
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
  }, [handleGo, handleStepIn, handleStepOver, handleStepOut, toggleTabWithBackendUpdate, handleCloseActiveTab, reverseLookup, setOpen, enterSubInput, handleNavigateToDisassembly, handleNavigateToMemory]);

  const isPaused = displayStatus === 'Paused';

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
        onSelect: handleGoPassException,
        enabled: canStep && session?.current_event?.event_type === "Exception",
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
      // Panel toggles
      {
        id: "panel.disassembly",
        label: "Toggle Disassembly",
        group: "Windows",
        icon: <Code className="size-4" />,
        keybindingAction: "panel.disassembly",
        onSelect: () => toggleTabWithBackendUpdate("disassembly"),
        keepOpen: true,
        keywords: ["disassembly", "asm", "code"],
      },
      {
        id: "panel.registers",
        label: "Toggle Registers",
        group: "Windows",
        icon: <Cpu className="size-4" />,
        keybindingAction: "panel.registers",
        onSelect: () => toggleTabWithBackendUpdate("registers"),
        keepOpen: true,
        keywords: ["registers", "regs"],
      },
      {
        id: "panel.modules",
        label: "Toggle Modules",
        group: "Windows",
        icon: <Box className="size-4" />,
        keybindingAction: "panel.modules",
        onSelect: () => toggleTabWithBackendUpdate("modules"),
        keepOpen: true,
        keywords: ["modules", "dll"],
      },
      {
        id: "panel.threads",
        label: "Toggle Threads",
        group: "Windows",
        icon: <Layers className="size-4" />,
        keybindingAction: "panel.threads",
        onSelect: () => toggleTabWithBackendUpdate("threads"),
        keepOpen: true,
        keywords: ["threads"],
      },
      {
        id: "panel.callstack",
        label: "Toggle Call Stack",
        group: "Windows",
        icon: <ListTree className="size-4" />,
        keybindingAction: "panel.callstack",
        onSelect: () => toggleTabWithBackendUpdate("callstack"),
        keepOpen: true,
        keywords: ["callstack", "stack", "frames"],
      },
      {
        id: "panel.symbols",
        label: "Toggle Symbols",
        group: "Windows",
        icon: <Search className="size-4" />,
        keybindingAction: "panel.symbols",
        onSelect: () => toggleTabWithBackendUpdate("symbols"),
        keepOpen: true,
        keywords: ["symbols", "functions"],
      },
      {
        id: "panel.memoryRegions",
        label: "Toggle Memory Regions",
        group: "Windows",
        icon: <HardDrive className="size-4" />,
        keybindingAction: "panel.memoryRegions",
        onSelect: () => toggleTabWithBackendUpdate("memory_regions"),
        keepOpen: true,
        keywords: ["memory", "regions", "map"],
      },
      {
        id: "panel.breakpoints",
        label: "Toggle Breakpoints",
        group: "Windows",
        icon: <MapPin className="size-4" />,
        keybindingAction: "panel.breakpoints",
        onSelect: () => toggleTabWithBackendUpdate("breakpoints"),
        keepOpen: true,
        keywords: ["breakpoints", "bp"],
      },
      {
        id: "panel.patches",
        label: "Toggle Patches",
        group: "Windows",
        icon: <Puzzle className="size-4" />,
        keybindingAction: "panel.patches",
        onSelect: () => toggleTabWithBackendUpdate("patches"),
        keepOpen: true,
        keywords: ["patches", "assemble", "patch"],
      },
      {
        id: "panel.bookmarks",
        label: "Toggle Bookmarks",
        group: "Windows",
        icon: <BookmarkIcon className="size-4" />,
        keybindingAction: "panel.bookmarks",
        onSelect: () => toggleTabWithBackendUpdate("bookmarks"),
        keepOpen: true,
        keywords: ["bookmarks", "bookmark", "freeze", "lock", "cheat", "address"],
      },
      {
        id: "panel.memorySearch",
        label: "Toggle Memory Search",
        group: "Windows",
        icon: <Search className="size-4" />,
        keybindingAction: "panel.memorySearch",
        onSelect: () => toggleTabWithBackendUpdate("memory_search"),
        keepOpen: true,
        keywords: ["memory", "search", "find", "pattern"],
      },
      {
        id: "panel.memoryScanner",
        label: "Toggle Memory Scanner",
        group: "Windows",
        icon: <ScanSearch className="size-4" />,
        keybindingAction: "panel.memoryScanner",
        onSelect: () => toggleTabWithBackendUpdate("memory_scanner"),
        keepOpen: true,
        keywords: ["memory", "scanner", "scan", "cheat"],
      },
      {
        id: "panel.pointerScan",
        label: "Toggle Pointer Scan",
        group: "Windows",
        icon: <Crosshair className="size-4" />,
        keybindingAction: "panel.pointerScan",
        onSelect: () => toggleTabWithBackendUpdate("pointer_scan"),
        keepOpen: true,
        keywords: ["pointer", "scan", "path", "cheat", "static"],
      },
      {
        id: "panel.peViewer",
        label: "Toggle PE Viewer",
        group: "Windows",
        icon: <FileCode className="size-4" />,
        keybindingAction: "panel.peViewer",
        onSelect: () => toggleTabWithBackendUpdate("peviewer"),
        keepOpen: true,
        keywords: ["pe", "portable", "executable", "viewer"],
      },
      {
        id: "panel.addMemory",
        label: "Add Memory Window",
        group: "Windows",
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
        enabled: isPaused,
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
        enabled: isPaused,
        keywords: ["goto", "address", "memory", "navigate", "hex"],
      },
    ];

    return registerCommands(commands);
  }, [
    canStart, canStop, canPause, canStep, isPaused, session?.current_event?.event_type,
    handleStart, handleStop, handlePause,
    handleGo, handleGoPassException, handleStepIn, handleStepOver, handleStepOut,
    handleNavigateToDisassembly, handleNavigateToMemory,
    toggleTabWithBackendUpdate, handleAddNewMemoryTab, handleResetLayout,
    registerCommands,
  ]);

  const breakpointState = useBreakpoints(session?.id, isPaused, session?.breakpoints);
  const patchState = usePatches(session?.id, isPaused, session?.patches);
  const bookmarkState = useBookmarks(session?.id, isPaused, session?.bookmarks, displayStatus === 'Running');

  const contextValue = useMemo(() => ({
    session,
    displayStatus,
    modules,
    threads,
    loadModules: async () => { await loadModules(); },
    loadThreads: async () => { await loadThreads(); },
    searchSymbols: async (pattern: string, limit?: number) => { return await searchSymbols(pattern, limit); },
    breakpointState,
    patchState,
    bookmarkState,
    onNavigateToDisassembly: handleNavigateToDisassembly,
    onNavigateToMemory: handleNavigateToMemory,
  }), [session, displayStatus, modules, threads, loadModules, loadThreads, searchSymbols, breakpointState, patchState, bookmarkState, handleNavigateToDisassembly, handleNavigateToMemory]);
  
  // Static tab content - components will update via context
  const dynamicTabContent = useMemo(() => ({
    disassembly: <ContextAssemblyView />,
    registers: <ContextRegisterView />,
    modules: <ContextModulesView onOpenModuleInfo={handleOpenModuleInfo} />,
    threads: <ContextThreadsView onNavigateToDisassembly={handleNavigateToDisassembly} onNavigateToMemoryPointer={handleNavigateToMemoryPointer} />,
    callstack: <ContextCallStackView onNavigateToDisassembly={handleNavigateToDisassembly} onNavigateToMemoryPointer={handleNavigateToMemoryPointer} />,
    symbols: <ContextSymbolsView />,
    memory_regions: <ContextMemoryRegionsView onNavigateToAddress={handleNavigateToMemory} />,
    breakpoints: <ContextBreakpointsView />,
    patches: <ContextPatchesView />,
    bookmarks: <ContextBookmarksView />,
    memory_search: <ContextMemorySearchView />,
    memory_scanner: <ContextMemoryScannerView />,
    pointer_scan: <ContextPointerScanView />,
    peviewer: <ContextModuleInfoView />,
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
      memory: {
        id: "memory",
        title: "Memory",
        content: <ContextHexView memoryViewId="memory" />,
        closable: true,
      },
      memory_regions: {
        id: "memory_regions",
        title: "Memory Regions",
        content: dynamicTabContent.memory_regions,
        closable: true,
      },
      breakpoints: {
        id: "breakpoints",
        title: "Breakpoints",
        content: dynamicTabContent.breakpoints,
        closable: true,
      },
      patches: {
        id: "patches",
        title: "Patches",
        content: dynamicTabContent.patches,
        closable: true,
      },
      bookmarks: {
        id: "bookmarks",
        title: "Bookmarks",
        content: dynamicTabContent.bookmarks,
        closable: true,
      },
      memory_search: {
        id: "memory_search",
        title: "Memory Search",
        content: dynamicTabContent.memory_search,
        closable: true,
      },
      memory_scanner: {
        id: "memory_scanner",
        title: "Memory Scanner",
        content: dynamicTabContent.memory_scanner,
        closable: true,
      },
      pointer_scan: {
        id: "pointer_scan",
        title: "Pointer Scan",
        content: dynamicTabContent.pointer_scan,
        closable: true,
      },
      peviewer: {
        id: "peviewer",
        title: "PE Viewer",
        content: dynamicTabContent.peviewer,
        closable: true,
      },
    };

    return {
      storagePrefix: "session-debugger-dock", // Shared prefix for all sessions to preserve layout
      initialLayout: DebuggerDockingConfig.initialLayout,
      initialTabContents: sessionTabContents,
      tabContentMap: { ...DebuggerDockingConfig.tabContentMap, ...dynamicTabContent },
      tabContentFactory,
    };
  }, [sessionId, dynamicTabContent, tabContentFactory]);

  const getStatusBadge = (status: SessionStatus) => {
    if (typeof status === "string") {
      switch (status) {
        case "Stopped":
          return <Badge variant="secondary">Stopped</Badge>;
        case "Running":
          return <Badge variant="default" className="bg-green-600 animate-pulse">Running</Badge>;
        case "Paused":
          return <Badge variant="default" className="bg-yellow-600">Paused</Badge>;
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
          handleStart={handleStart}
          handlePause={handlePause}
          handleDetach={handleDetach}
          canStep={canStep}
          canStop={canStop}
          canStart={canStart}
          canPause={canPause}
          canDetach={canDetach}
          dockingRef={dockingRef}
          getStatusBadge={getStatusBadge}
          toggleTab={toggleTabWithBackendUpdate}
          resetLayout={handleResetLayout}
          addNewMemoryTab={handleAddNewMemoryTab}
        />

        {/* Docking Layout */}
        <div className="relative flex-1">
          <DockingLayout
            ref={dockingRef}
            {...dockingConfig}
            className="absolute inset-0"
            onTabsChanged={handleTabsChanged}
          />
        </div>
      </div>
    </SessionContext.Provider>
  );
} 