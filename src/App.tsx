import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Header from "@/components/Header";
import Home from "@/pages/Home";
import Logs from "@/pages/Logs";
import Settings from "@/pages/Settings";
import About from "@/pages/About";
import "./App.css";

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50 dark:bg-neutral-900">
        <Header />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
