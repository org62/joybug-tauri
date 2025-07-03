import { BrowserRouter as Router, Routes, Route, useNavigate } from "react-router-dom";
import React, { Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import Header from "@/components/Header";

// Lazy load pages for code splitting
const Home = React.lazy(() => import("@/pages/Home"));
const Debugger = React.lazy(() => import("@/pages/Debugger"));
const SessionDocked = React.lazy(() => import("@/pages/SessionDocked"));
const Logs = React.lazy(() => import("@/pages/Logs"));
const Settings = React.lazy(() => import("@/pages/Settings"));
const About = React.lazy(() => import("@/pages/About"));

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
        <Suspense fallback={
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 dark:border-gray-100"></div>
          </div>
        }>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/debugger" element={<Debugger />} />
            <Route path="/session/:sessionId" element={<SessionDocked />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </Suspense>
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
