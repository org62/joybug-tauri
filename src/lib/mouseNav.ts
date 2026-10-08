// Mouse back/forward button navigation registry.
//
// The mouse side buttons (XButton1/XButton2) reach the page as mousedown with
// button 3/4; main.tsx intercepts them before React and hands the press to the
// registered handler (App, which drives the app-wide navigation history). The
// browser's own history never moves — main.tsx keeps it at a single entry.

type Dir = 'back' | 'forward';
type Handler = (dir: Dir) => void;

let handler: Handler | null = null;

export function setMouseNavHandler(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function runMouseNav(dir: Dir): void {
  handler?.(dir);
}
