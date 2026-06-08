import { createContext, useContext } from "react";
import type { ActionId, ChordString, KeybindingSettings, PresetName } from "@/lib/keybindings";

export interface KeybindingContextData {
  /** Effective bindings: action → chord (preset + custom overrides merged) */
  bindings: Record<ActionId, ChordString>;
  /** Reverse lookup: chord → action for fast keydown matching */
  reverseLookup: Map<ChordString, ActionId>;
  /** Get the display string for an action's keybinding (e.g. "Ctrl+D") */
  getKeybinding: (actionId: ActionId) => string;
  /** Current raw settings (preset name + custom overrides) */
  settings: KeybindingSettings;
  /** Update keybinding settings and persist to backend */
  updateSettings: (settings: KeybindingSettings) => Promise<void>;
  /** Current preset name */
  preset: PresetName;
}

export const KeybindingContext = createContext<KeybindingContextData | null>(null);

export function useKeybindingContext(): KeybindingContextData {
  const ctx = useContext(KeybindingContext);
  if (!ctx) {
    throw new Error("useKeybindingContext must be used within a KeybindingProvider");
  }
  return ctx;
}
