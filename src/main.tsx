import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted so a desktop build never depends on a font CDN at runtime. Latin
// subset only, regular + medium — the two weights the data panels actually use.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import App from "./App";
import { ThemeProvider } from "next-themes";
import { runMouseNav } from "./lib/mouseNav";
import { applyAccent, getStoredAccent } from "./lib/accent";

// Apply the persisted accent before React mounts so the first paint already
// has the right --syn-accent (no accent flash on startup).
applyAccent(getStoredAccent());

// The app owns back/forward (lib/navHistory.ts); the browser's own history
// must never move the page. WebView2 and WebKitGTK navigate it natively on the
// mouse X-buttons (and Alt+Left/Right) *in addition to* delivering the DOM
// event, and DOM preventDefault() does not stop that. Swallowing the popstate
// afterwards races the app's own restore (which has usually already pushed the
// target page by the time the native traversal lands, so the "repair" undid it
// and left the user on the page they pressed back from). Instead keep the
// browser history at exactly one entry, so there is nothing to traverse: every
// router push becomes a replace. React Router still reports its own PUSH /
// REPLACE action, so `useNavigationType` and the departure recording in App are
// unaffected; only `window.history.length` stops growing.
window.history.pushState = window.history.replaceState.bind(window.history);

// The X-buttons still arrive as mousedown (button 3/4): drive the app history.
window.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    runMouseNav(e.button === 3 ? 'back' : 'forward');
  }
}, { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
