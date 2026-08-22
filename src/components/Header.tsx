import { Link, useLocation } from "react-router-dom";
import { useTheme } from "next-themes";
import { Moon, Search, Snail, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WindowControls } from "@/components/WindowControls";
import { ActiveSessionIndicator } from "@/components/ActiveSessionIndicator";
import { useCommandPaletteContext } from "@/contexts/CommandPaletteContext";
import { useKeybindingContext } from "@/contexts/KeybindingContext";

/**
 * The app's title bar. The window is frameless (`decorations: false` in
 * tauri.conf.json), so this bar *is* the caption: it carries the drag region,
 * the window controls, and everything that used to sit below a native caption
 * bar — in 40px instead of the old 64 + ~32.
 *
 * Two contracts to preserve when editing:
 *  - exactly one <header> element in the app (several e2e specs assert
 *    `page.locator("header")` under Playwright strict mode);
 *  - the nav labels stay rendered and visible at every width —
 *    e2e/tests/pe-reader.spec.ts asserts the exact text "PE Viewer" is visible
 *    on "/", and the Home card's "📦 PE Viewer" doesn't satisfy exact matching.
 *
 * Tauri v2 only starts a window drag when the mousedown target *itself* carries
 * `data-tauri-drag-region`, so interactive children need no opt-out attribute.
 */

const navigationItems = [
  { name: "Debugger", path: "/debugger" },
  { name: "PE Viewer", path: "/pe" },
  { name: "Logs", path: "/logs" },
  { name: "Settings", path: "/settings" },
  { name: "About", path: "/about" },
];

export default function Header() {
  const location = useLocation();
  const { resolvedTheme, setTheme } = useTheme();
  const { setOpen: setPaletteOpen } = useCommandPaletteContext();
  const { getKeybinding } = useKeybindingContext();
  const isDark = resolvedTheme === "dark";

  return (
    <header
      data-tauri-drag-region
      className="h-10 shrink-0 flex items-stretch gap-1 pl-2 border-b border-border bg-background select-none"
    >
      <Link
        to="/"
        className="flex items-center gap-1.5 px-1 shrink-0 text-sm font-semibold text-foreground"
        title="Joybug — home"
      >
        <Snail className="size-4 text-syn-accent" />
        <span>Joybug</span>
      </Link>

      <nav className="flex items-stretch">
        {navigationItems.map((item) => {
          const active = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "relative flex items-center px-2.5 text-xs transition-colors",
                active
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.name}
              {/* Follows the user's accent choice (Settings → General). */}
              {active && (
                <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-syn-accent" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Grab area — the widest part of the bar you can drag the window by. */}
      <div data-tauri-drag-region className="flex-1 min-w-4" />

      <div className="flex items-center gap-1 pr-1 shrink-0">
        <ActiveSessionIndicator />

        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setPaletteOpen(true)}
          title={`Command palette — jump to any window, action, or address (${getKeybinding("palette.open")})`}
          aria-label="Open command palette"
        >
          <Search />
          <kbd className="rounded border px-1 text-[10px] font-mono">
            {getKeybinding("palette.open")}
          </kbd>
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          title={`${isDark ? "Light" : "Dark"} mode (${getKeybinding("nav.toggleTheme")})`}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
      </div>

      <WindowControls />
    </header>
  );
}
