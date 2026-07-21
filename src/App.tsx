import { BrowserRouter as Router, Routes, Route, useNavigate } from "react-router-dom";
import React, { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "next-themes";
import { dispatchToast } from "@/lib/toastDispatcher";
import { isProcessAvailable } from "@/lib/sessionHelpers";
import Header from "@/components/Header";
import { KeybindingContext, useKeybindingContext } from "@/contexts/KeybindingContext";
import { useKeybindings } from "@/hooks/useKeybindings";
import { keyboardEventToChord } from "@/lib/keybindings";
import { CommandPaletteContext, useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { CommandPalette } from "@/components/CommandPalette";
import { applyZoom, getStoredZoom, nudgeZoom } from "@/lib/uiZoom";
import { useDebugSettings, EVENT_ITEMS } from "@/hooks/useDebugSettings";
import { Home as HomeIcon, Bug, ScrollText, Settings as SettingsIcon, Info, Sun, Moon, Keyboard, Bell, Zap, Plus, Eye, FileSearch } from "lucide-react";

// Lazy load pages for code splitting
const Home = React.lazy(() => import("@/pages/Home"));
const Debugger = React.lazy(() => import("@/pages/Debugger"));
const SessionDocked = React.lazy(() => import("@/pages/SessionDocked"));
const Logs = React.lazy(() => import("@/pages/Logs"));
const Settings = React.lazy(() => import("@/pages/Settings"));
const About = React.lazy(() => import("@/pages/About"));
const PeReader = React.lazy(() => import("@/pages/PeReader"));

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./App.css";
import RcDockThemeLoader from "./components/RcDockThemeLoader";

function AppContent() {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const { reverseLookup } = useKeybindingContext();
  const { toggle, registerCommands } = useCommandPaletteContext();

  // Apply the saved UI scale on startup, and handle zoom hotkeys
  // (Ctrl/Cmd +/-/0) — persisted via uiZoom so the choice survives restarts.
  useEffect(() => {
    applyZoom(getStoredZoom());
    const onZoomKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); nudgeZoom(1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); nudgeZoom(-1); }
      else if (e.key === "0") { e.preventDefault(); nudgeZoom(0); }
    };
    window.addEventListener("keydown", onZoomKey);
    return () => window.removeEventListener("keydown", onZoomKey);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const chord = keyboardEventToChord(event);
      if (!chord) return;

      const action = reverseLookup.get(chord);
      if (!action) return;

      switch (action) {
        case "palette.open":
          event.preventDefault();
          event.stopPropagation();
          toggle();
          break;
        case "nav.debugger":
          event.preventDefault();
          event.stopPropagation();
          navigate('/debugger');
          break;
        case "nav.logs":
          event.preventDefault();
          event.stopPropagation();
          navigate('/logs');
          break;
        case "nav.toggleTheme":
          event.preventDefault();
          event.stopPropagation();
          setTheme(resolvedTheme === 'light' ? 'dark' : 'light');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Global toast listeners. Routed through the burst-aware dispatcher so rare
    // events show their full message while bursts collapse into a single
    // "N× category" summary (prevents sonner's per-toast reflow from freezing the UI).
    const unlistenInfo = listen<string>("show-toast", (event) => {
      dispatchToast("info", event.payload);
    });
    const unlistenError = listen<string>("show-toast-error", (event) => {
      dispatchToast("error", event.payload);
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unlistenInfo.then(f => f());
      unlistenError.then(f => f());
    };
  }, [navigate, resolvedTheme, setTheme, reverseLookup, toggle]);

  // Register global commands (navigation + theme + settings)
  const { settings: debugSettings, toggle: toggleDebugSetting } = useDebugSettings();

  // Track session list for "Open Session" commands
  const [sessionList, setSessionList] = useState<{ id: string; name: string; status: string }[]>([]);

  const loadSessionList = useCallback(async () => {
    try {
      const sessions = await invoke<{ id: string; name: string; status: string }[]>("get_debug_sessions");
      setSessionList(sessions.map(s => ({
        id: s.id,
        name: s.name,
        status: typeof s.status === "string" ? s.status : "Error",
      })));
    } catch {
      // ignore — sessions not available yet
    }
  }, []);

  // Debounced version to avoid IPC storm during rapid stepping
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const debouncedLoadSessionList = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadSessionList, 500);
  }, [loadSessionList]);

  useEffect(() => {
    loadSessionList();
    // Also refresh when sessions change (debounced — session-updated fires on every step)
    const unUpdated = listen("session-updated", debouncedLoadSessionList);
    const unRemoved = listen("session-removed", () => loadSessionList());
    return () => {
      clearTimeout(debounceRef.current);
      unUpdated.then(f => f());
      unRemoved.then(f => f());
    };
  }, [loadSessionList, debouncedLoadSessionList]);

  useEffect(() => {
    const isDark = resolvedTheme === 'dark';

    return registerCommands([
      // Navigation
      {
        id: "nav.home",
        label: "Home",
        group: "Navigation",
        icon: <HomeIcon className="size-4" />,
        onSelect: () => navigate("/"),
        keywords: ["home", "start"],
      },
      {
        id: "nav.debugger",
        label: "Debugger",
        group: "Navigation",
        icon: <Bug className="size-4" />,
        keybindingAction: "nav.debugger",
        onSelect: () => navigate("/debugger"),
        keywords: ["debug", "session"],
      },
      {
        id: "nav.pe",
        label: "PE Viewer",
        group: "Navigation",
        icon: <FileSearch className="size-4" />,
        onSelect: () => navigate("/pe"),
        keywords: ["pe", "portable executable", "exe", "dll", "headers"],
      },
      {
        id: "nav.logs",
        label: "Logs",
        group: "Navigation",
        icon: <ScrollText className="size-4" />,
        keybindingAction: "nav.logs",
        onSelect: () => navigate("/logs"),
        keywords: ["log", "output"],
      },
      {
        id: "nav.settings",
        label: "Settings",
        group: "Navigation",
        icon: <SettingsIcon className="size-4" />,
        onSelect: () => navigate("/settings"),
        keywords: ["settings", "preferences", "config"],
      },
      {
        id: "nav.settings.keybindings",
        label: "Keyboard Shortcuts",
        group: "Settings",
        icon: <Keyboard className="size-4" />,
        onSelect: () => navigate("/settings?tab=keybindings"),
        keywords: ["keybindings", "shortcuts", "keys", "hotkeys", "bindings"],
      },
      {
        id: "nav.settings.events",
        label: "Events and Exceptions",
        group: "Settings",
        icon: <Bell className="size-4" />,
        onSelect: () => navigate("/settings?tab=events"),
        keywords: ["events", "exceptions", "debug", "settings"],
      },
      {
        id: "nav.about",
        label: "About",
        group: "Navigation",
        icon: <Info className="size-4" />,
        onSelect: () => navigate("/about"),
        keywords: ["about", "version", "info"],
      },
      // Theme
      {
        id: "theme.toggle",
        label: isDark ? "Switch to Light Mode" : "Switch to Dark Mode",
        group: "Theme",
        icon: isDark ? <Sun className="size-4" /> : <Moon className="size-4" />,
        keybindingAction: "nav.toggleTheme",
        onSelect: () => setTheme(isDark ? "light" : "dark"),
        keepOpen: true,
        keywords: ["theme", "dark", "light", "mode"],
      },
      // Events & Exceptions toggles
      ...EVENT_ITEMS.map((item) => ({
        id: item.id,
        label: `Stop on ${item.label}: ${debugSettings[item.key] ? "ON" : "OFF"}`,
        group: "Events & Exceptions",
        icon: <Zap className="size-4" />,
        onSelect: () => toggleDebugSetting(item.key),
        keepOpen: true,
        keywords: item.keywords,
      })),
      // Session management
      {
        id: "session.new",
        label: "New Debug Session",
        group: "Sessions",
        icon: <Plus className="size-4" />,
        onSelect: () => navigate("/debugger"),
        keywords: ["new", "create", "session", "debug", "launch"],
      },
      // Dynamic session entries
      ...sessionList.map((s) => ({
        id: `session.open.${s.id}`,
        label: s.name,
        group: "Sessions",
        icon: <Eye className="size-4" />,
        onSelect: () => {
          if (isProcessAvailable(s.status)) {
            navigate(`/session/${s.id}`);
          } else {
            navigate("/debugger");
          }
        },
        shortcutLabel: s.status,
        keywords: ["session", "open", "switch", s.name.toLowerCase()],
      })),
    ]);
  }, [navigate, resolvedTheme, setTheme, registerCommands, debugSettings, toggleDebugSetting, sessionList]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
      <RcDockThemeLoader />
      <Header />
      <CommandPalette />
      <main className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 dark:border-gray-100"></div>
          </div>
        }>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/debugger" element={<Debugger />} />
            <Route path="/pe" element={<PeReader />} />
            <Route path="/session/:sessionId" element={<SessionDocked />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </Suspense>
      </main>
      <Toaster visibleToasts={8} />
    </div>
  );
}

function KeybindingProvider({ children }: { children: React.ReactNode }) {
  const keybindingData = useKeybindings();
  return (
    <KeybindingContext.Provider value={keybindingData}>
      {children}
    </KeybindingContext.Provider>
  );
}

function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const commandPaletteData = useCommandPalette();
  return (
    <CommandPaletteContext.Provider value={commandPaletteData}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

function App() {
  return (
    <Router>
      <KeybindingProvider>
        <CommandPaletteProvider>
          {/* Single tooltip provider so per-symbol tooltips (TruncatedSymbol
              in virtualized rows) don't each mount their own. */}
          <TooltipProvider delayDuration={300}>
            <AppContent />
          </TooltipProvider>
        </CommandPaletteProvider>
      </KeybindingProvider>
    </Router>
  );
}

export default App;
