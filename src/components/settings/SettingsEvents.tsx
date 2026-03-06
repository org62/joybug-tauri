import { useCallback, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { useDebugSettings, EVENT_ITEMS, type EventSettingItem } from "@/hooks/useDebugSettings";

interface SettingsEventsProps {
  searchQuery: string;
}

/** Renders an "Events and Exceptions" category block matching the keybinding section style. */
export function SettingsEvents({ searchQuery }: SettingsEventsProps) {
  const { settings, toggle } = useDebugSettings();

  const matchesSearch = useCallback((item: EventSettingItem): boolean => {
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
              checked={settings[item.key]}
              onCheckedChange={() => toggle(item.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
