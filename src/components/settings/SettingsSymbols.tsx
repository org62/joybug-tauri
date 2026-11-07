import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import { matchesSettingItem, type SettingItem } from "@/lib/settingsSearch";
import { SettingsSection, SettingsGroup, SettingsRow, SettingsNote } from "./SettingsSection";

const SETTING_ITEMS: SettingItem[] = [
  { key: "symbolPath", label: "Symbol path", keywords: ["symbol", "pdb", "path", "server", "srv", "nt_symbol_path", "download", "cache"] },
  { key: "symbolOffline", label: "Offline mode — never download symbols", keywords: ["symbol", "pdb", "offline", "download", "network", "airgap"] },
];

interface SettingsSymbolsProps {
  searchQuery: string;
}

/** Renders a "Symbols" category block matching the other settings sections. */
export function SettingsSymbols({ searchQuery }: SettingsSymbolsProps) {
  const { settings, toggle, setSymbolPath } = useDebugSettings();
  const [symbolPathDraft, setSymbolPathDraft] = useState<string | null>(null);

  const visibleItems = SETTING_ITEMS.filter((item) => matchesSettingItem(searchQuery, ["symbols"], item));
  if (visibleItems.length === 0) return null;

  return (
    <SettingsSection title="Symbols">
      <SettingsGroup>
        {visibleItems.map((item) => (
          <SettingsRow key={item.key} label={item.label}>
            {item.key === "symbolPath" && (
              <Input
                inputSize="xs"
                className="w-[26rem] max-w-[50vw] font-mono"
                placeholder="srv*C:\Symbols*https://msdl.microsoft.com/download/symbols"
                value={symbolPathDraft ?? settings.symbol_path}
                onChange={(e) => setSymbolPathDraft(e.target.value)}
                onBlur={() => {
                  if (symbolPathDraft !== null) {
                    setSymbolPath(symbolPathDraft.trim());
                    setSymbolPathDraft(null);
                  }
                }}
              />
            )}
            {item.key === "symbolOffline" && (
              <Switch
                size="xs"
                checked={settings.symbol_offline}
                onCheckedChange={() => toggle("symbol_offline")}
              />
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
      <SettingsNote>
        Empty path uses _NT_SYMBOL_PATH or the Microsoft symbol server. Applies to locally
        launched sessions, starting with the next session.
      </SettingsNote>
    </SettingsSection>
  );
}
