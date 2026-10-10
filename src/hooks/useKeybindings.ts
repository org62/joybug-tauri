import { useCallback, useMemo } from "react";
import { useDebugSettings } from "@/hooks/useDebugSettings";
import {
  type ActionId,
  type KeybindingSettings,
  type PresetName,
  DEFAULT_KEYBINDING_SETTINGS,
  resolveBindings,
  buildReverseLookup,
  formatKeybinding,
} from "@/lib/keybindings";

export function useKeybindings() {
  // The keybindings live in the debug settings; reading and writing them
  // through the shared hook keeps every other mounted settings view current.
  const { settings: debugSettings, update } = useDebugSettings();
  const settings = debugSettings.keybindings ?? DEFAULT_KEYBINDING_SETTINGS;

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
    (keybindings: KeybindingSettings) => update((prev) => ({ ...prev, keybindings })),
    [update],
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
