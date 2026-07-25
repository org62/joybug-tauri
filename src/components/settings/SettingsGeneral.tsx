import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { applyZoom, getStoredZoom, ZOOM_CHANGED_EVENT, ZOOM_STEPS } from "@/lib/uiZoom";

interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

const SETTING_ITEMS: SettingItem[] = [
  { key: "theme", label: "Theme", keywords: ["dark", "light", "system", "appearance", "color"] },
  { key: "uiScale", label: "UI scale", keywords: ["zoom", "scale", "ui", "enlarge", "bigger", "size", "font", "magnify", "text", "large", "small"] },
  { key: "scanThreads", label: "Memory scan threads (0 = all cores)", keywords: ["scan", "thread", "threads", "memory", "performance", "cores", "parallel", "cpu"] },
  { key: "autoUpdateCheck", label: "Automatically check for updates", keywords: ["update", "updates", "upgrade", "version", "release", "releases", "check", "github", "new"] },
];

interface SettingsGeneralProps {
  searchQuery: string;
}

/** Renders a "General" category block matching the keybinding section style. */
export function SettingsGeneral({ searchQuery }: SettingsGeneralProps) {
  const { theme, setTheme } = useTheme();
  const { settings, setScanThreadCount, toggle } = useDebugSettings();
  const [scanThreadsDraft, setScanThreadsDraft] = useState<string | null>(null);
  const [uiScale, setUiScale] = useState(() => getStoredZoom());

  // Track zoom changes made elsewhere (Ctrl/Cmd +/-/0 hotkeys) while this
  // panel is open, so the dropdown never shows a stale factor.
  useEffect(() => {
    const onZoomChanged = (e: Event) => setUiScale((e as CustomEvent<number>).detail);
    window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
    return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
  }, []);

  const matchesSearch = (item: SettingItem): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      "general".includes(q) ||
      "appearance".includes(q) ||
      item.keywords.some(kw => kw.includes(q))
    );
  };

  const visibleItems = SETTING_ITEMS.filter(matchesSearch);
  if (visibleItems.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">General</h3>
      <div>
        {visibleItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className="text-sm font-medium">{item.label}</div>
            {item.key === "theme" && (
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger size="xs" className="w-[130px]">
                  <SelectValue placeholder="Select theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            )}
            {item.key === "uiScale" && (
              <Select
                value={String(uiScale)}
                // applyZoom fires ZOOM_CHANGED_EVENT, which updates uiScale.
                onValueChange={(v) => applyZoom(parseFloat(v))}
              >
                <SelectTrigger size="xs" className="w-[130px]">
                  <SelectValue placeholder="Scale" />
                </SelectTrigger>
                <SelectContent>
                  {ZOOM_STEPS.map((z) => (
                    <SelectItem key={z} value={String(z)}>
                      {Math.round(z * 100)}%{z === 1 ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {item.key === "scanThreads" && (
              <Input
                type="number"
                min={0}
                step={1}
                inputSize="xs"
                className="w-[130px]"
                value={scanThreadsDraft ?? String(settings.scan_thread_count)}
                onChange={(e) => setScanThreadsDraft(e.target.value)}
                onBlur={() => {
                  if (scanThreadsDraft !== null) {
                    const parsed = parseInt(scanThreadsDraft, 10);
                    setScanThreadCount(Number.isNaN(parsed) ? 0 : parsed);
                    setScanThreadsDraft(null);
                  }
                }}
              />
            )}
            {item.key === "autoUpdateCheck" && (
              <Switch
                size="xs"
                checked={settings.auto_update_check}
                onCheckedChange={() => toggle("auto_update_check")}
                aria-label={item.label}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
