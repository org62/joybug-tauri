import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "next-themes";
import { runMouseNav } from "./lib/mouseNav";

// Block browser back/forward navigation triggered by mouse buttons (XButton1/XButton2),
// but only when the cursor is inside a component that handles its own navigation history
// (marked with data-capture-mouse-nav). WebView2 handles these at the native level, so
// DOM preventDefault() alone doesn't work. We register the popstate listener BEFORE React
// mounts so it fires before React Router's, allowing stopImmediatePropagation().
{
  let blockPopState = false;
  let savedPath = '';

  const armBlock = (e: MouseEvent) => {
    e.preventDefault();
    blockPopState = true;
    savedPath = window.location.pathname + window.location.search + window.location.hash;
    setTimeout(() => { blockPopState = false; }, 1000);
  };

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) {
      const dir = e.button === 3 ? 'back' : 'forward';
      const target = e.target as HTMLElement;
      // Block the native (router) nav when a nested handler owns the gesture: AssemblyView's
      // address history (marked with data-capture-mouse-nav, handled by its own listener) or a
      // registered view's tab history (runMouseNav). Otherwise let WebView2 navigate the page.
      const shouldBlock = !!target.closest('[data-capture-mouse-nav]') || runMouseNav(dir);
      if (shouldBlock) armBlock(e);
    }
  }, { capture: true });

  window.addEventListener('popstate', (e: PopStateEvent) => {
    if (blockPopState) {
      e.stopImmediatePropagation();
      blockPopState = false;
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
