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

// Block browser back/forward navigation triggered by mouse buttons (XButton1/XButton2)
// when a registered view's navigation history consumes the press (runMouseNav). WebView2
// handles these at the native level, so DOM preventDefault() alone doesn't work. We
// register the popstate listener BEFORE React mounts so it fires before React Router's,
// allowing stopImmediatePropagation().
{
  // One native back/forward navigation (and thus one popstate) follows EACH
  // trusted X-button press, asynchronously. A one-shot flag leaks when presses
  // come faster than their popstates (press, press, pop, pop — the second pop
  // sails through to the router and yanks the user off the page). Count the
  // pending blocks instead, one per armed press.
  let pendingBlocks = 0;
  let savedPath = '';
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const armBlock = (e: MouseEvent) => {
    e.preventDefault();
    pendingBlocks++;
    savedPath = window.location.pathname + window.location.search + window.location.hash;
    // Safety valve: if a press produced no native popstate (nothing to go back
    // to), the stale count would swallow a future legit popstate. Native
    // popstates arrive within milliseconds — after a quiet second, forget.
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { pendingBlocks = 0; }, 1000);
  };

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) {
      const dir = e.button === 3 ? 'back' : 'forward';
      // Block the native (router) nav when the registered view's unified history consumed
      // the press. An empty history falls through to WebView2 page navigation. Synthetic
      // (untrusted) events never trigger native navigation, so they need no blocking —
      // arming it anyway would swallow the next real popstate.
      if (runMouseNav(dir) && e.isTrusted) armBlock(e);
    }
  }, { capture: true });

  window.addEventListener('popstate', (e: PopStateEvent) => {
    if (pendingBlocks > 0) {
      pendingBlocks--;
      e.stopImmediatePropagation();
      window.history.pushState(null, '', savedPath);
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
