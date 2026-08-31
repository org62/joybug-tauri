import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { useSandbox } from "@/hooks/useSandbox";

interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

const SETTING_ITEMS: SettingItem[] = [
  { key: "sandboxStatus", label: "Windows Sandbox", keywords: ["sandbox", "wsb", "available", "24h2", "26100", "isolation", "detonate"] },
  { key: "sandboxMemory", label: "Default sandbox memory (MB)", keywords: ["sandbox", "memory", "ram", "mb"] },
  { key: "sandboxCollectEtw", label: "Collect ETW trace by default", keywords: ["sandbox", "etw", "trace", "events", "telemetry"] },
  { key: "sandboxEtwPreset", label: "Default ETW capture scope", keywords: ["sandbox", "etw", "capture", "preset", "files", "registry", "network", "reads"] },
];

interface SettingsSandboxProps {
  searchQuery: string;
}

/** Renders a "Sandbox" category block. Defaults apply to new sandbox sessions. */
export function SettingsSandbox({ searchQuery }: SettingsSandboxProps) {
  const { settings, toggle, setSandboxMemoryMb, setSandboxEtwPreset } = useDebugSettings();
  const { status } = useSandbox();
  const [memoryDraft, setMemoryDraft] = useState<string | null>(null);

  const matchesSearch = (item: SettingItem): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      item.keywords.some((kw) => kw.includes(q))
    );
  };

  const visibleItems = SETTING_ITEMS.filter(matchesSearch);
  if (visibleItems.length === 0) return null;

  const available = !!status && status.supported && status.wsb_present;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Sandbox</h3>
      <div>
        {visibleItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className="text-sm font-medium shrink-0">{item.label}</div>

            {item.key === "sandboxStatus" && (
              <div className="text-xs text-right">
                {status == null ? (
                  <span className="text-muted-foreground">Checking…</span>
                ) : available ? (
                  <span className="text-syn-state">Available (build {status.build})</span>
                ) : (
                  <span className="text-muted-foreground max-w-[22rem] inline-block">
                    {status.reason ?? "Unavailable"}
                  </span>
                )}
              </div>
            )}

            {item.key === "sandboxMemory" && (
              <Input
                inputSize="xs"
                className="w-24 text-right tabular-nums"
                type="number"
                min={1024}
                step={1024}
                value={memoryDraft ?? String(settings.sandbox_default_memory_mb)}
                onChange={(e) => setMemoryDraft(e.target.value)}
                onBlur={() => {
                  if (memoryDraft !== null) {
                    setSandboxMemoryMb(parseInt(memoryDraft, 10));
                    setMemoryDraft(null);
                  }
                }}
              />
            )}

            {item.key === "sandboxCollectEtw" && (
              <Switch
                size="xs"
                checked={settings.sandbox_collect_etw}
                onCheckedChange={() => toggle("sandbox_collect_etw")}
              />
            )}

            {item.key === "sandboxEtwPreset" && (
              <Select
                value={settings.sandbox_etw_preset}
                onValueChange={(v) => setSandboxEtwPreset(v)}
              >
                <SelectTrigger size="xs" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All activity</SelectItem>
                  <SelectItem value="files">Files only</SelectItem>
                  <SelectItem value="registry">Registry only</SelectItem>
                  <SelectItem value="network">Network only</SelectItem>
                </SelectContent>
              </Select>
            )}

          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2 px-2">
        Defaults apply to new Windows Sandbox sessions. Networking is always enabled for sandbox
        sessions because the debugger connects to the in-sandbox server over the network.
      </p>
    </div>
  );
}
