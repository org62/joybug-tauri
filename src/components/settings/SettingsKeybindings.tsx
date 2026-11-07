import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { SettingsSection, SettingsSubheading, SettingsGroup, SettingsRow, SETTING_CONTROL_WIDTH } from "./SettingsSection";
import { useKeybindingContext } from "@/contexts/KeybindingContext";

interface SettingsKeybindingsProps {
  searchQuery: string;
}

export function SettingsKeybindings({ searchQuery }: SettingsKeybindingsProps) {
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

  const visibleCategories = ACTION_CATEGORIES
    .map((cat) => ({ category: cat, actions: getActionsForCategory(cat).filter(matchesSearch) }))
    .filter(({ actions }) => actions.length > 0);

  if (visibleCategories.length === 0) return null;

  return (
    <SettingsSection
      title="Keyboard Shortcuts"
      action={
        <Button variant="ghost" size="xs" onClick={handleResetAll} disabled={!hasCustomBindings}>
          Reset All to Defaults
        </Button>
      }
    >
      {visibleCategories.map(({ category, actions }) => (
        <div key={category}>
          <SettingsSubheading>{category}</SettingsSubheading>
          <SettingsGroup>
            {/* The preset decides the debug keys, so it leads their list. */}
            {category === "Debug" && (
              <SettingsRow label="Preset">
                <Select value={localSettings.preset} onValueChange={handlePresetChange}>
                  <SelectTrigger size="xs" className={SETTING_CONTROL_WIDTH}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="windbg">WinDbg</SelectItem>
                    <SelectItem value="x64dbg">x64dbg</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>
            )}
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
          </SettingsGroup>
        </div>
      ))}
    </SettingsSection>
  );
}
