import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { useSandbox } from "@/hooks/useSandbox";
import { matchesSettingItem, type SettingItem } from "@/lib/settingsSearch";
import { SettingsSection, SettingsGroup, SettingsRow, SettingsNote, SETTING_CONTROL_WIDTH } from "./SettingsSection";

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

  const visibleItems = SETTING_ITEMS.filter((item) => matchesSettingItem(searchQuery, [], item));
  if (visibleItems.length === 0) return null;

  const available = !!status && status.supported && status.wsb_present;

  return (
    <SettingsSection title="Sandbox">
      <SettingsGroup>
        {visibleItems.map((item) => (
          <SettingsRow key={item.key} label={item.label}>

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
                className={`${SETTING_CONTROL_WIDTH} tabular-nums`}
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
                <SelectTrigger size="xs" className={SETTING_CONTROL_WIDTH}>
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

          </SettingsRow>
        ))}
      </SettingsGroup>
      <SettingsNote>
        Defaults apply to new Windows Sandbox sessions. Networking is always enabled for sandbox
        sessions because the debugger connects to the in-sandbox server over the network.
      </SettingsNote>
    </SettingsSection>
  );
}
