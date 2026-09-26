import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings, type PebNormalizeSettings } from "@/hooks/useDebugSettings";

interface SettingsPebNormalizeProps {
  searchQuery: string;
}

interface ChildItem {
  key: keyof Omit<PebNormalizeSettings, "enabled">;
  label: string;
  keywords: string[];
}

const CHILDREN: ChildItem[] = [
  { key: "being_debugged", label: "BeingDebugged", keywords: ["peb", "isdebuggerpresent", "crash reporter", "exception"] },
  { key: "heap_flags",     label: "HeapFlags",     keywords: ["peb", "heap", "debug heap", "slowdown", "performance"] },
];

const PARENT_KEYWORDS = ["peb", "normalize", "normalization", "debugger", "heap", "beingdebugged"];

/** Renders the "PEB Normalization" settings section: parent toggle + indented PEB sub-options. */
export function SettingsPebNormalize({ searchQuery }: SettingsPebNormalizeProps) {
  const { settings, togglePebNormalize } = useDebugSettings();
  const pebNormalize = settings.peb_normalize;

  const matchesSearch = useCallback((label: string, keywords: string[]): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return label.toLowerCase().includes(q) || keywords.some(kw => kw.includes(q));
  }, [searchQuery]);

  const parentVisible = matchesSearch("Normalize PEB", PARENT_KEYWORDS);
  const visibleChildren = useMemo(
    () => CHILDREN.filter(c => matchesSearch(c.label, c.keywords)),
    [matchesSearch],
  );

  // Hide the entire section if neither the parent nor any child matches the search.
  if (!parentVisible && visibleChildren.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">PEB Normalization</h3>
      <p className="text-xs text-muted-foreground px-2 mb-2">
        On process start, restores the PEB fields Windows leaves in their "debugger attached"
        state so the target runs like a normally launched process. Not evasion: clearing the
        debug-heap flags avoids the exhaustive per-allocation verification that can massively
        slow the target, and clearing BeingDebugged stops code that reads IsDebuggerPresent
        (crash reporters, exception handlers that fire a breakpoint on detection) from taking
        its debugger-only path — so a bug reproduces as it would with no debugger attached.
        Applies to x64, ARM64 and 32-bit (WOW64) targets; a WOW64 process has both its PEBs patched.
      </p>
      <div>
        {parentVisible && (
          <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50">
            <div className="text-sm font-medium">Normalize PEB</div>
            <Switch
              checked={pebNormalize.enabled}
              onCheckedChange={() => togglePebNormalize("enabled")}
            />
          </div>
        )}
        {visibleChildren.map((child) => (
          <div
            key={child.key}
            className="flex items-center justify-between py-1.5 pr-2 pl-8 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className={`text-sm ${pebNormalize.enabled ? "" : "text-muted-foreground"}`}>
              {child.label}
            </div>
            <Switch
              checked={pebNormalize[child.key]}
              disabled={!pebNormalize.enabled}
              onCheckedChange={() => togglePebNormalize(child.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
