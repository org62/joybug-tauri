import { createContext, useContext } from "react";
import type { ActionId } from "@/lib/keybindings";

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: React.ReactNode;
  /** If set, the shortcut label is looked up from keybindings for this action */
  keybindingAction?: ActionId;
  /** Manual shortcut label (used if keybindingAction is not set) */
  shortcutLabel?: string;
  onSelect: () => void;
  /** When true, the palette stays open after selecting the command (useful for toggles). */
  keepOpen?: boolean;
  /** When false, the command is hidden from the palette. Defaults to true. */
  enabled?: boolean;
  /** Extra keywords for fuzzy search matching */
  keywords?: string[];
}

export type SubInputHandler = (value: string) => void;

export interface SubInputState {
  placeholder: string;
  onSubmit: SubInputHandler;
}

export interface CommandPaletteContextData {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  registerCommands: (commands: PaletteCommand[]) => () => void;
  commands: PaletteCommand[];
  /** Enter sub-input mode (e.g., "Go to Address") */
  enterSubInput: (state: SubInputState) => void;
  subInput: SubInputState | null;
  clearSubInput: () => void;
}

export const CommandPaletteContext = createContext<CommandPaletteContextData | null>(null);

export function useCommandPaletteContext(): CommandPaletteContextData {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPaletteContext must be used within a CommandPaletteProvider");
  }
  return ctx;
}
