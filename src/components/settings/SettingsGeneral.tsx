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
import { useJitDebugger } from "@/hooks/useJitDebugger";
import { usePlatform } from "@/hooks/usePlatform";
import { matchesSettingItem, type SettingItem } from "@/lib/settingsSearch";
import { applyZoom, getStoredZoom, ZOOM_CHANGED_EVENT, ZOOM_STEPS } from "@/lib/uiZoom";
import { ACCENT_OPTIONS, applyAccent, getStoredAccent, type AccentId } from "@/lib/accent";
import { SettingsSection, SettingsGroup, SettingsRow, SETTING_CONTROL_WIDTH } from "./SettingsSection";

const SETTING_ITEMS: SettingItem[] = [
  { key: "theme", label: "Theme", keywords: ["dark", "light", "system", "appearance", "color"] },
  { key: "accentColor", label: "Accent color", keywords: ["accent", "color", "appearance", "link", "blue", "teal", "purple", "rose", "highlight"] },
  { key: "uiScale", label: "UI scale", keywords: ["zoom", "scale", "ui", "enlarge", "bigger", "size", "font", "magnify", "text", "large", "small"] },
  { key: "scanThreads", label: "Memory scan threads (0 = all cores)", keywords: ["scan", "thread", "threads", "memory", "performance", "cores", "parallel", "cpu"] },
  { key: "lightningInstructions", label: "Lightning emulation: instructions emulated at every pause", keywords: ["lightning", "emulation", "emulate", "trace", "instructions", "disassembly", "preview", "quick"] },
  { key: "autoUpdateCheck", label: "Automatically check for updates", keywords: ["update", "updates", "upgrade", "version", "release", "releases", "check", "github", "new"] },
  { key: "jitDebugger", label: "Windows JIT / postmortem debugger", keywords: ["jit", "postmortem", "crash", "aedebug", "werfault", "wer", "attach", "debugger", "just-in-time", "exception"] },
];

/**
 * Numeric settings row: edits freely as text and commits on blur. The shared
 * setter in `useDebugSettings` owns the valid range, so an unparseable draft
 * is simply handed over and normalized there.
 */
function NumberSetting({
  value,
  min,
  onCommit,
  ...props
}: {
  value: number;
  min: number;
  onCommit: (value: number) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "min" | "onChange" | "onBlur" | "type">) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="number"
      min={min}
      step={1}
      inputSize="xs"
      className={SETTING_CONTROL_WIDTH}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) {
          onCommit(parseInt(draft, 10));
          setDraft(null);
        }
      }}
      {...props}
    />
  );
}

interface SettingsGeneralProps {
  searchQuery: string;
}

/** Renders a "General" category block matching the keybinding section style. */
export function SettingsGeneral({ searchQuery }: SettingsGeneralProps) {
  const { theme, setTheme } = useTheme();
  const { settings, setScanThreadCount, setLightningInstructions, toggle } = useDebugSettings();
  const jit = useJitDebugger();
  const { features } = usePlatform();
  const [uiScale, setUiScale] = useState(() => getStoredZoom());
  const [accent, setAccent] = useState<AccentId>(() => getStoredAccent());

  // Track zoom changes made elsewhere (Ctrl/Cmd +/-/0 hotkeys) while this
  // panel is open, so the dropdown never shows a stale factor.
  useEffect(() => {
    const onZoomChanged = (e: Event) => setUiScale((e as CustomEvent<number>).detail);
    window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
    return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
  }, []);

  const visibleItems = SETTING_ITEMS
    .filter((item) => item.key !== "jitDebugger" || features.jit)
    .filter((item) => matchesSettingItem(searchQuery, ["general", "appearance"], item));
  if (visibleItems.length === 0) return null;

  return (
    <SettingsSection title="General">
      <SettingsGroup>
        {visibleItems.map((item) => (
          <SettingsRow
            key={item.key}
            label={item.label}
            hint={item.key === "jitDebugger" && jit.status && (
              jit.status.registered ? (
                "Crashed processes open in Joybug. Turning off restores the previous debugger."
              ) : jit.status.current ? (
                <span className="block truncate" title={jit.status.current}>
                  Current: {jit.status.current}
                </span>
              ) : (
                "No postmortem debugger is registered."
              )
            )}
          >
            {item.key === "theme" && (
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger size="xs" className={SETTING_CONTROL_WIDTH}>
                  <SelectValue placeholder="Select theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            )}
            {item.key === "accentColor" && (
              <Select
                value={accent}
                onValueChange={(v) => {
                  const id = v as AccentId;
                  applyAccent(id);
                  setAccent(id);
                }}
              >
                <SelectTrigger size="xs" className={SETTING_CONTROL_WIDTH}>
                  <SelectValue placeholder="Accent" />
                </SelectTrigger>
                <SelectContent>
                  {ACCENT_OPTIONS.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: o.swatch }}
                        />
                        {o.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {item.key === "uiScale" && (
              <Select
                value={String(uiScale)}
                // applyZoom fires ZOOM_CHANGED_EVENT, which updates uiScale.
                onValueChange={(v) => applyZoom(parseFloat(v))}
              >
                <SelectTrigger size="xs" className={SETTING_CONTROL_WIDTH}>
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
              <NumberSetting min={0} value={settings.scan_thread_count} onCommit={setScanThreadCount} />
            )}
            {item.key === "lightningInstructions" && (
              <NumberSetting
                min={1}
                value={settings.lightning_instructions}
                onCommit={setLightningInstructions}
                data-testid="setting-lightning-instructions"
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
            {item.key === "jitDebugger" && (
              <Switch
                size="xs"
                checked={jit.status?.registered ?? false}
                disabled={jit.status === null || jit.busy}
                onCheckedChange={jit.setEnabled}
                aria-label={item.label}
                data-testid="setting-jit-debugger"
              />
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
