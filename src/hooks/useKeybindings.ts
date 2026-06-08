import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type ActionId,
  type KeybindingSettings,
  type PresetName,
  DEFAULT_KEYBINDING_SETTINGS,
  resolveBindings,
  buildReverseLookup,
  formatKeybinding,
} from "@/lib/keybindings";

interface DebugSettingsFromBackend {
  stop_on_thread_create: boolean;
  stop_on_thread_exit: boolean;
  stop_on_dll_load: boolean;
  stop_on_dll_unload: boolean;
  stop_on_initial_breakpoint: boolean;
  stop_on_process_create: boolean;
  keybindings?: KeybindingSettings;
}

export function useKeybindings() {
  const [settings, setSettings] = useState<KeybindingSettings>(DEFAULT_KEYBINDING_SETTINGS);
  const [fullSettings, setFullSettings] = useState<DebugSettingsFromBackend | null>(null);

  // Load settings from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await invoke<DebugSettingsFromBackend>("get_debug_settings");
        setFullSettings(s);
        if (s.keybindings) {
          setSettings(s.keybindings);
        }
      } catch (e) {
        console.error("Failed to load keybinding settings:", e);
      }
    })();
  }, []);

  const bindings = useMemo(() => resolveBindings(settings), [settings]);
  const reverseLookup = useMemo(() => buildReverseLookup(bindings), [bindings]);

  const getKeybinding = useCallback(
    (actionId: ActionId): string => {
      const chord = bindings[actionId];
      return chord ? formatKeybinding(chord) : "";
    },
    [bindings]
  );

  const updateSettings = useCallback(
    async (newKeybindingSettings: KeybindingSettings) => {
      setSettings(newKeybindingSettings);
      try {
        // Read current full settings from backend, merge keybindings, write back
        const current = fullSettings ?? await invoke<DebugSettingsFromBackend>("get_debug_settings");
        const updated = { ...current, keybindings: newKeybindingSettings };
        await invoke("update_debug_settings", { newSettings: updated });
        setFullSettings(updated);
      } catch (e) {
        console.error("Failed to save keybinding settings:", e);
      }
    },
    [fullSettings]
  );

  const preset: PresetName = (settings.preset === "x64dbg" ? "x64dbg" : "windbg");

  return {
    settings,
    bindings,
    reverseLookup,
    getKeybinding,
    updateSettings,
    preset,
  };
}
