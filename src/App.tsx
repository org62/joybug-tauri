import { BrowserRouter as Router, Routes, Route, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import Header from "@/components/Header";
import Home from "@/pages/Home";
import Debugger from "@/pages/Debugger";
import Session from "@/pages/Session";
import SessionDocked from "@/pages/SessionDocked";
import Logs from "@/pages/Logs";
import Settings from "@/pages/Settings";
import About from "@/pages/About";

import DebuggerExample from "@/pages/DebuggerExample";
import { Toaster } from "@/components/ui/sonner";
import "./App.css";
import RcDockThemeLoader from "./components/RcDockThemeLoader";

function AppContent() {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
        switch (event.key) {
          case 'D':
            event.preventDefault();
            navigate('/debugger');
            break;
          case 'L':
            event.preventDefault();
            navigate('/logs');
            break;
          case 'T':
            event.preventDefault();
            setTheme(resolvedTheme === 'light' ? 'dark' : 'light');
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Global toast listener
    const unlisten = listen<string>("show-toast", (event) => {
      toast.info(event.payload);
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unlisten.then(f => f());
    };
  }, [navigate, resolvedTheme, setTheme]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-neutral-900">
      <RcDockThemeLoader />
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/debugger" element={<Debugger />} />
          <Route path="/session/:sessionId" element={<Session />} />
          <Route path="/session-docked/:sessionId" element={<SessionDocked />} />

          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about" element={<About />} />
          <Route path="/debugger-example" element={<DebuggerExample />} />
        </Routes>
      </main>
      <Toaster />
    </div>
  );
}

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

export default App;
