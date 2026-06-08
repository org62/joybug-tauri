import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

const SETTING_ITEMS: SettingItem[] = [
  { key: "theme", label: "Theme", keywords: ["dark", "light", "system", "appearance", "color"] },
];

interface SettingsGeneralProps {
  searchQuery: string;
}

/** Renders a "General" category block matching the keybinding section style. */
export function SettingsGeneral({ searchQuery }: SettingsGeneralProps) {
  const { theme, setTheme } = useTheme();

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
                <SelectTrigger className="w-[130px] h-7 text-sm">
                  <SelectValue placeholder="Select theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
