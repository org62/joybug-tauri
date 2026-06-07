import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings, type DebuggerHidingSettings } from "@/hooks/useDebugSettings";

interface SettingsDebuggerHidingProps {
  searchQuery: string;
}

interface ChildItem {
  key: keyof Omit<DebuggerHidingSettings, "hide_from_peb">;
  label: string;
  keywords: string[];
}

const CHILDREN: ChildItem[] = [
  { key: "being_debugged",  label: "BeingDebugged",  keywords: ["peb", "isdebuggerpresent", "anti-debug"] },
  { key: "heap_flags",      label: "HeapFlags",      keywords: ["peb", "heap", "anti-debug"] },
  { key: "nt_global_flag",  label: "NtGlobalFlag",   keywords: ["peb", "ntglobalflag", "anti-debug"] },
  { key: "startup_info",    label: "StartupInfo",    keywords: ["peb", "rtl_user_process_parameters", "anti-debug"] },
  { key: "os_build_number", label: "OsBuildNumber",  keywords: ["peb", "osbuildnumber", "spoof"] },
];

const PARENT_KEYWORDS = ["debugger", "hiding", "hide", "peb", "anti", "anti-debug"];

/** Renders the "Debugger Hiding" settings section: parent toggle + indented PEB sub-options. */
export function SettingsDebuggerHiding({ searchQuery }: SettingsDebuggerHidingProps) {
  const { settings, toggleHiding } = useDebugSettings();
  const hiding = settings.debugger_hiding;

  const matchesSearch = useCallback((label: string, keywords: string[]): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return label.toLowerCase().includes(q) || keywords.some(kw => kw.includes(q));
  }, [searchQuery]);

  const parentVisible = matchesSearch("Hide from PEB", PARENT_KEYWORDS);
  const visibleChildren = useMemo(
    () => CHILDREN.filter(c => matchesSearch(c.label, c.keywords)),
    [matchesSearch],
  );

  // Hide the entire section if neither the parent nor any child matches the search.
  if (!parentVisible && visibleChildren.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Debugger Hiding</h3>
      <p className="text-xs text-muted-foreground px-2 mb-2">
        Patches the target's PEB on process start so anti-debug checks (IsDebuggerPresent,
        NtGlobalFlag, heap flags, startup info, OS build number) see a clean value.
        64-bit native targets only; WOW64 is skipped automatically.
      </p>
      <div>
        {parentVisible && (
          <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50">
            <div className="text-sm font-medium">Hide from PEB</div>
            <Switch
              checked={hiding.hide_from_peb}
              onCheckedChange={() => toggleHiding("hide_from_peb")}
            />
          </div>
        )}
        {visibleChildren.map((child) => (
          <div
            key={child.key}
            className="flex items-center justify-between py-1.5 pr-2 pl-8 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className={`text-sm ${hiding.hide_from_peb ? "" : "text-muted-foreground"}`}>
              {child.label}
            </div>
            <Switch
              checked={hiding[child.key]}
              disabled={!hiding.hide_from_peb}
              onCheckedChange={() => toggleHiding(child.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
