import { useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "@/components/ui/switch";

interface DebugSettings {
  stop_on_thread_create: boolean;
  stop_on_thread_exit: boolean;
  stop_on_dll_load: boolean;
  stop_on_dll_unload: boolean;
  stop_on_initial_breakpoint: boolean;
  stop_on_process_create: boolean;
}

interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

const EVENT_ITEMS: SettingItem[] = [
  { key: "stop_on_process_create", label: "Process Create", keywords: ["process", "create", "pause", "event"] },
  { key: "stop_on_thread_create", label: "Create Thread", keywords: ["thread", "create", "pause", "event"] },
  { key: "stop_on_thread_exit", label: "Exit Thread", keywords: ["thread", "exit", "pause", "event"] },
  { key: "stop_on_dll_load", label: "Load Module", keywords: ["dll", "module", "load", "pause", "event"] },
  { key: "stop_on_dll_unload", label: "Unload Module", keywords: ["dll", "module", "unload", "pause", "event"] },
  { key: "stop_on_initial_breakpoint", label: "Initial Breakpoint", keywords: ["breakpoint", "initial", "launch", "attach", "pause", "event"] },
];

interface SettingsEventsProps {
  searchQuery: string;
}

/** Renders an "Events and Exceptions" category block matching the keybinding section style. */
export function SettingsEvents({ searchQuery }: SettingsEventsProps) {
  const [settings, setSettings] = useState<DebugSettings>({
    stop_on_thread_create: true,
    stop_on_thread_exit: false,
    stop_on_dll_load: true,
    stop_on_dll_unload: true,
    stop_on_initial_breakpoint: true,
    stop_on_process_create: true,
  });

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<DebugSettings>("get_debug_settings");
      setSettings(s);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }, []);

  const saveSettings = useCallback(async (next: DebugSettings) => {
    setSettings(next);
    try {
      await invoke("update_debug_settings", { newSettings: next });
    } catch (e) {
      console.error("Failed to update settings:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const matchesSearch = useCallback((item: SettingItem): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      "events".includes(q) ||
      "exceptions".includes(q) ||
      item.keywords.some(kw => kw.includes(q))
    );
  }, [searchQuery]);

  const visibleItems = useMemo(() => EVENT_ITEMS.filter(matchesSearch), [matchesSearch]);
  if (visibleItems.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Events and Exceptions</h3>
      <div>
        {visibleItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className="text-sm font-medium">{item.label}</div>
            <Switch
              checked={(settings as unknown as Record<string, boolean>)[item.key] ?? false}
              onCheckedChange={(v) => saveSettings({ ...settings, [item.key]: v })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
