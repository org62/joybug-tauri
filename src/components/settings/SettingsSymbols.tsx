import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings } from "@/hooks/useDebugSettings";

interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

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

  const matchesSearch = (item: SettingItem): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      "symbols".includes(q) ||
      item.keywords.some(kw => kw.includes(q))
    );
  };

  const visibleItems = SETTING_ITEMS.filter(matchesSearch);
  if (visibleItems.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">Symbols</h3>
      <div>
        {visibleItems.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 last:border-b-0"
          >
            <div className="text-sm font-medium shrink-0">{item.label}</div>
            {item.key === "symbolPath" && (
              <Input
                inputSize="xs"
                className="max-w-[22rem] font-mono"
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
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2 px-2">
        Empty path uses _NT_SYMBOL_PATH or the Microsoft symbol server. Applies to locally
        launched sessions, starting with the next session.
      </p>
    </div>
  );
}
