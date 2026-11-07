import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { useTelemetryStatus, type TelemetryStatus } from "@/lib/perf";
import { matchesSettingItem, type SettingItem } from "@/lib/settingsSearch";
import { SettingsSection, SettingsGroup, SettingsRow, SettingsNote } from "./SettingsSection";

const SETTING_ITEMS: SettingItem[] = [
  { key: "telemetryEnabled", label: "Send anonymous performance data", keywords: ["telemetry", "performance", "anonymous", "usage", "data", "privacy", "slow", "collector", "send", "opt-in"] },
  { key: "telemetryEndpoint", label: "Collector address", keywords: ["telemetry", "collector", "address", "endpoint", "server", "port", "url", "host"] },
  { key: "telemetryFile", label: "Record performance data to a local file", keywords: ["telemetry", "performance", "record", "file", "offline", "local", "ndjson", "privacy"] },
  { key: "skipSymbolization", label: "Disassemble without symbols", keywords: ["diagnostic", "disassembly", "symbol", "symbolize", "symbolization", "slow", "performance", "names"] },
  { key: "naiveDisassembly", label: "Naive disassembly (linear decode only)", keywords: ["diagnostic", "disassembly", "naive", "simple", "linear", "slow", "performance", "function", "bounds"] },
];

interface SettingsDiagnosticsProps {
  searchQuery: string;
}

function statusText(status: TelemetryStatus | null, enabled: boolean): string {
  if (!status) return "";
  if (!status.active) {
    return enabled ? "Nothing is sent: set a collector address." : "Off. Nothing is recorded or sent.";
  }
  const parts: string[] = [];
  if (status.url) parts.push(`Sending to ${status.url}`);
  if (status.recording_to_file) parts.push(status.file ? `Recording to ${status.file}` : "Recording to a local file");
  parts.push(`${status.sent_records} records delivered`);
  if (status.failed_batches > 0) parts.push(`${status.failed_batches} batches failed`);
  if (status.dropped > 0) parts.push(`${status.dropped} dropped`);
  return parts.join(" · ");
}

/** Renders the "Diagnostics" category block: opt-in telemetry and the disassembly diagnostic switches. */
export function SettingsDiagnostics({ searchQuery }: SettingsDiagnosticsProps) {
  const { settings, toggle, setTelemetryEndpoint } = useDebugSettings();
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null);
  // The counters move without an event; re-read while the section is open.
  const status = useTelemetryStatus(2000);

  const visibleItems = SETTING_ITEMS.filter((item) => matchesSettingItem(searchQuery, ["diagnostics"], item));
  if (visibleItems.length === 0) return null;

  return (
    <SettingsSection title="Diagnostics" data-testid="settings-diagnostics">
      <SettingsGroup>
        {visibleItems.map((item) => (
          <SettingsRow key={item.key} label={item.label}>
            {item.key === "telemetryEnabled" && (
              <Switch
                size="xs"
                checked={settings.telemetry_enabled}
                onCheckedChange={() => toggle("telemetry_enabled")}
                aria-label={item.label}
                data-testid="setting-telemetry-enabled"
              />
            )}
            {item.key === "telemetryEndpoint" && (
              <Input
                inputSize="xs"
                className="w-[16rem] font-mono"
                placeholder="host:port or https://…"
                aria-label={item.label}
                data-testid="setting-telemetry-endpoint"
                value={endpointDraft ?? settings.telemetry_endpoint}
                onChange={(e) => setEndpointDraft(e.target.value)}
                onBlur={() => {
                  if (endpointDraft !== null) {
                    setTelemetryEndpoint(endpointDraft.trim());
                    setEndpointDraft(null);
                  }
                }}
              />
            )}
            {item.key === "telemetryFile" && (
              <Switch
                size="xs"
                checked={settings.telemetry_record_to_file}
                onCheckedChange={() => toggle("telemetry_record_to_file")}
                aria-label={item.label}
                data-testid="setting-telemetry-file"
              />
            )}
            {item.key === "skipSymbolization" && (
              <Switch
                size="xs"
                checked={settings.diag_skip_symbolization}
                onCheckedChange={() => toggle("diag_skip_symbolization")}
                aria-label={item.label}
                data-testid="setting-diag-skip-symbolization"
              />
            )}
            {item.key === "naiveDisassembly" && (
              <Switch
                size="xs"
                checked={settings.diag_naive_disassembly}
                onCheckedChange={() => toggle("diag_naive_disassembly")}
                aria-label={item.label}
                data-testid="setting-diag-naive-disassembly"
              />
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
      <div className="flex items-start justify-between gap-3">
        <SettingsNote className="min-w-0 break-words" data-testid="telemetry-status">
          {statusText(status, settings.telemetry_enabled)}
          {status?.last_error ? ` · Last error: ${status.last_error}` : ""}
        </SettingsNote>
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          title="Open the folder local recordings are written to"
          onClick={() => { invoke("telemetry_open_folder").catch(() => {}); }}
        >
          <FolderOpen />
          Open folder
        </Button>
      </div>
      <SettingsNote>
        Performance data is how long the debugger's own operations take: timings, counts and
        sizes, plus this app's version, OS and CPU count. System modules are named (ntdll.dll);
        every other module is a one-time code. Never included: paths, addresses, symbol names,
        command lines, register or memory contents. The local file holds exactly what would be
        sent.
      </SettingsNote>
      <SettingsNote>
        The two disassembly switches trade detail for speed, to show whether symbols or function
        analysis are what makes a listing slow. They apply to every session at once.
      </SettingsNote>
    </SettingsSection>
  );
}
