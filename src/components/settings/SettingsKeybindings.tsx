import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type ActionId,
  type ChordString,
  type PresetName,
  type KeybindingSettings,
  ACTION_REGISTRY,
  ACTION_CATEGORIES,
  KEYBINDING_PRESETS,
  getActionsForCategory,
  formatKeybinding,
  resolveBindings,
} from "@/lib/keybindings";
import { KeybindingRow } from "./KeybindingRow";
import { useKeybindingContext } from "@/contexts/KeybindingContext";

interface SettingsKeybindingsProps {
  searchQuery: string;
  /** When true, skip own ScrollArea wrapper (parent provides scrolling) */
  embedded?: boolean;
}

export function SettingsKeybindings({ searchQuery, embedded }: SettingsKeybindingsProps) {
  const { settings, updateSettings } = useKeybindingContext();
  const [localSettings, setLocalSettings] = useState<KeybindingSettings>(settings);

  // Keep local state in sync when external settings change
  const settingsKey = JSON.stringify(settings);
  const [lastSettingsKey, setLastSettingsKey] = useState(settingsKey);
  if (settingsKey !== lastSettingsKey) {
    setLocalSettings(settings);
    setLastSettingsKey(settingsKey);
  }

  const localBindings = useMemo(() => resolveBindings(localSettings), [localSettings]);

  const save = useCallback(async (next: KeybindingSettings) => {
    setLocalSettings(next);
    await updateSettings(next);
  }, [updateSettings]);

  const handlePresetChange = useCallback((newPreset: string) => {
    const next: KeybindingSettings = {
      preset: newPreset as PresetName,
      custom_bindings: {},
    };
    save(next);
  }, [save]);

  const handleBindingChange = useCallback((actionId: ActionId, chord: ChordString) => {
    const presetDefault = KEYBINDING_PRESETS[localSettings.preset as PresetName]?.[actionId] ?? "";
    const newCustom = { ...localSettings.custom_bindings };

    if (chord === presetDefault) {
      delete newCustom[actionId];
    } else {
      newCustom[actionId] = chord;
    }

    const next: KeybindingSettings = { ...localSettings, custom_bindings: newCustom };
    save(next);
  }, [localSettings, save]);

  const handleBindingReset = useCallback((actionId: ActionId) => {
    const newCustom = { ...localSettings.custom_bindings };
    delete newCustom[actionId];
    const next: KeybindingSettings = { ...localSettings, custom_bindings: newCustom };
    save(next);
  }, [localSettings, save]);

  const handleResetAll = useCallback(() => {
    const next: KeybindingSettings = {
      preset: localSettings.preset,
      custom_bindings: {},
    };
    save(next);
  }, [localSettings.preset, save]);

  const checkConflict = useCallback((chord: ChordString, excludeAction: ActionId): string | null => {
    for (const [id, c] of Object.entries(localBindings)) {
      if (id !== excludeAction && c === chord) {
        return ACTION_REGISTRY[id as ActionId]?.label ?? id;
      }
    }
    return null;
  }, [localBindings]);

  // Filter actions by search query
  const matchesSearch = useCallback((actionId: ActionId): boolean => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const meta = ACTION_REGISTRY[actionId];
    const chord = localBindings[actionId] ?? "";
    return (
      meta.label.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q) ||
      meta.category.toLowerCase().includes(q) ||
      actionId.toLowerCase().includes(q) ||
      formatKeybinding(chord).toLowerCase().includes(q)
    );
  }, [searchQuery, localBindings]);

  const hasCustomBindings = Object.keys(localSettings.custom_bindings).length > 0;

  const renderCategoryBlock = (category: string, actions: ActionId[], prefixLabel: boolean) => {
    const isDebugCategory = category === "Debug";
    return (
      <div key={`kb-${category}`}>
        {prefixLabel && (
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">Keyboard Shortcuts</div>
        )}
        <h3 className="text-sm font-semibold text-muted-foreground mb-2">{category}</h3>
        {isDebugCategory && (
          <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 border-b border-border/50 mb-0">
            <div className="text-sm font-medium">Preset</div>
            <Select value={localSettings.preset} onValueChange={handlePresetChange}>
              <SelectTrigger className="h-7 w-[130px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="windbg">WinDbg</SelectItem>
                <SelectItem value="x64dbg">x64dbg</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          {actions.map((actionId) => (
            <KeybindingRow
              key={actionId}
              actionId={actionId}
              currentChord={localBindings[actionId] ?? ""}
              preset={localSettings.preset as PresetName}
              checkConflict={checkConflict}
              onChange={handleBindingChange}
              onReset={handleBindingReset}
            />
          ))}
        </div>
      </div>
    );
  };

  const visibleCategories = ACTION_CATEGORIES
    .map((cat) => ({ category: cat, actions: getActionsForCategory(cat).filter(matchesSearch) }))
    .filter(({ actions }) => actions.length > 0);

  if (visibleCategories.length === 0) return null;

  const resetAllButton = (
    <div className="flex justify-end">
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleResetAll} disabled={!hasCustomBindings}>
        Reset All to Defaults
      </Button>
    </div>
  );

  // Embedded: return bare category blocks as fragments (caller provides the grid)
  if (embedded) {
    return (
      <>
        {resetAllButton}
        {visibleCategories.map(({ category, actions }) => renderCategoryBlock(category, actions, true))}
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-0 h-full">
      <ScrollArea className="flex-1 min-h-0">
        {resetAllButton}
        <div
          className="grid gap-x-6 gap-y-5 items-start"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))" }}
        >
          {visibleCategories.map(({ category, actions }) => renderCategoryBlock(category, actions, false))}
        </div>
      </ScrollArea>
    </div>
  );
}
