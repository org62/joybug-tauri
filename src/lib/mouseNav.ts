// Mouse back/forward button navigation registry.
//
// The mouse side buttons (XButton1/XButton2) trigger WebView2's native browser
// back/forward, which react-router turns into a page navigation. main.tsx intercepts
// these at the pre-React level (DOM preventDefault alone doesn't stop WebView2). This
// registry lets a mounted view (e.g. the docked session) claim a back/forward press to
// navigate its own tab history instead. If the handler returns true, main.tsx blocks the
// native navigation; if false (or no handler registered), the native page nav proceeds.

type Dir = 'back' | 'forward';
type Handler = (dir: Dir) => boolean; // returns true if it consumed the press

let handler: Handler | null = null;

export function setMouseNavHandler(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function runMouseNav(dir: Dir): boolean {
  return handler ? handler(dir) : false;
}
