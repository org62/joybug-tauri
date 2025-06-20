import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Header from "@/components/Header";
import Home from "@/pages/Home";
import Debugger from "@/pages/Debugger";
import Session from "@/pages/Session";
import Logs from "@/pages/Logs";
import Settings from "@/pages/Settings";
import About from "@/pages/About";
import { Toaster } from "@/components/ui/sonner";
import "./App.css";

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50 dark:bg-neutral-900">
        <Header />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/debugger" element={<Debugger />} />
            <Route path="/session/:sessionId" element={<Session />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
        <Toaster />
      </div>
    </Router>
  );
}

export default App;
