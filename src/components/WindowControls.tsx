import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Minimize / maximize-restore / close for the frameless window
 * (`decorations: false` in tauri.conf.json — the app header IS the caption bar).
 *
 * These commands need explicit ACL grants; `core:default` only covers the
 * read-only window commands. See `core:window:allow-minimize` /
 * `allow-toggle-maximize` / `allow-close` in src-tauri/capabilities/default.json
 * (`allow-start-dragging` there is what makes `data-tauri-drag-region` work).
 *
 * Note the Windows 11 snap-layouts flyout (hovering the maximize button) needs
 * WM_NCHITTEST to report HTMAXBUTTON, which HTML can't do — that affordance is
 * knowingly given up in exchange for the reclaimed caption bar.
 *
 * The labels say "window" because these sit in the DOM *before* <main>: a test
 * or assistive query for a bare "Close" would otherwise land here and quit the
 * app instead of hitting the view's own Close button. Playwright's accessible
 * name matching is substring-based, so specific labels are a readability aid,
 * not a guarantee — content queries must scope to <main>.
 */
export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;

    const sync = async () => {
      try {
        const max = await win.isMaximized();
        if (!disposed) setIsMaximized(max);
      } catch {
        // Not running under Tauri (or the window went away) — leave the icon as-is.
      }
    };

    sync();
    // Maximize/restore always resizes, so this covers the OS-driven paths too
    // (Win+Up, snap, double-clicking the drag region).
    const unlisten = win.onResized(sync);

    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  const run = (fn: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => () => {
    fn(getCurrentWindow()).catch(() => {
      // A rejected window command is not worth a toast — the user just clicked
      // a caption button that the platform declined.
    });
  };

  return (
    <div className="flex items-stretch h-full shrink-0">
      <Button
        variant="ghost"
        size="titlebar"
        onClick={run((w) => w.minimize())}
        aria-label="Minimize window"
        title="Minimize"
      >
        <Minus />
      </Button>
      <Button
        variant="ghost"
        size="titlebar"
        onClick={run((w) => w.toggleMaximize())}
        aria-label={isMaximized ? "Restore window" : "Maximize window"}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? <Copy className="scale-x-[-1]" /> : <Square />}
      </Button>
      <Button
        variant="ghost"
        size="titlebar"
        onClick={run((w) => w.close())}
        aria-label="Close window"
        title="Close"
        className="hover:bg-destructive hover:text-white dark:hover:bg-destructive"
      >
        <X />
      </Button>
    </div>
  );
}
