import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "next-themes";

// Block browser back/forward navigation triggered by mouse buttons (XButton1/XButton2),
// but only when the cursor is inside a component that handles its own navigation history
// (marked with data-capture-mouse-nav). WebView2 handles these at the native level, so
// DOM preventDefault() alone doesn't work. We register the popstate listener BEFORE React
// mounts so it fires before React Router's, allowing stopImmediatePropagation().
{
  let blockPopState = false;
  let savedPath = '';

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) {
      const target = e.target as HTMLElement;
      if (target.closest('[data-capture-mouse-nav]')) {
        e.preventDefault();
        blockPopState = true;
        savedPath = window.location.pathname + window.location.search + window.location.hash;
        setTimeout(() => { blockPopState = false; }, 1000);
      }
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
