// ── Action IDs ──────────────────────────────────────────────────────────────
export type ActionId =
  // Debug stepping
  | "debug.go"
  | "debug.stepIn"
  | "debug.stepOver"
  | "debug.stepOut"
  // Panel toggles
  | "panel.disassembly"
  | "panel.registers"
  | "panel.modules"
  | "panel.threads"
  | "panel.callstack"
  | "panel.symbols"
  | "panel.addMemory"
  | "panel.memoryRegions"
  | "panel.breakpoints"
  | "panel.memorySearch"
  | "panel.peViewer"
  // Navigation (global)
  | "nav.debugger"
  | "nav.logs"
  | "nav.toggleTheme"
  // Command palette
  | "palette.open"
  // Assembly view
  | "assembly.goBack"
  | "assembly.goForward";

// ── Action metadata ─────────────────────────────────────────────────────────
export type ActionCategory = "Debug" | "Panels" | "Navigation" | "Assembly";

export interface ActionMeta {
  label: string;
  category: ActionCategory;
  description: string;
  /** Scope where the shortcut is active */
  scope: "global" | "session" | "assembly";
}

export const ACTION_REGISTRY: Record<ActionId, ActionMeta> = {
  "debug.go":        { label: "Go / Continue",    category: "Debug",    description: "Resume execution",                           scope: "session" },
  "debug.stepIn":    { label: "Step Into",         category: "Debug",    description: "Step into the next instruction or function",  scope: "session" },
  "debug.stepOver":  { label: "Step Over",         category: "Debug",    description: "Step over the next instruction",              scope: "session" },
  "debug.stepOut":   { label: "Step Out",          category: "Debug",    description: "Step out of the current function",            scope: "session" },

  "panel.disassembly":   { label: "Toggle Disassembly",    category: "Panels", description: "Show or hide the Disassembly panel",    scope: "session" },
  "panel.registers":     { label: "Toggle Registers",      category: "Panels", description: "Show or hide the Registers panel",      scope: "session" },
  "panel.modules":       { label: "Toggle Modules",        category: "Panels", description: "Show or hide the Modules panel",        scope: "session" },
  "panel.threads":       { label: "Toggle Threads",        category: "Panels", description: "Show or hide the Threads panel",        scope: "session" },
  "panel.callstack":     { label: "Toggle Call Stack",     category: "Panels", description: "Show or hide the Call Stack panel",     scope: "session" },
  "panel.symbols":       { label: "Toggle Symbols",        category: "Panels", description: "Show or hide the Symbols panel",        scope: "session" },
  "panel.addMemory":     { label: "Add Memory Window",     category: "Panels", description: "Open a new Memory hex editor tab",      scope: "session" },
  "panel.memoryRegions": { label: "Toggle Memory Regions", category: "Panels", description: "Show or hide the Memory Regions panel", scope: "session" },
  "panel.breakpoints":   { label: "Toggle Breakpoints",    category: "Panels", description: "Show or hide the Breakpoints panel",    scope: "session" },
  "panel.memorySearch":  { label: "Toggle Memory Search",  category: "Panels", description: "Show or hide the Memory Search panel",  scope: "session" },
  "panel.peViewer":      { label: "Toggle PE Viewer",      category: "Panels", description: "Show or hide the PE Viewer panel",      scope: "session" },

  "palette.open":    { label: "Command Palette",  category: "Navigation", description: "Open the command palette",                 scope: "global" },

  "nav.debugger":    { label: "Go to Debugger",  category: "Navigation", description: "Navigate to the Debugger page",           scope: "global" },
  "nav.logs":        { label: "Go to Logs",      category: "Navigation", description: "Navigate to the Logs page",               scope: "global" },
  "nav.toggleTheme": { label: "Toggle Theme",    category: "Navigation", description: "Switch between light and dark theme",      scope: "global" },

  "assembly.goBack":    { label: "Go Back",    category: "Assembly", description: "Navigate back in disassembly history",    scope: "assembly" },
  "assembly.goForward": { label: "Go Forward", category: "Assembly", description: "Navigate forward in disassembly history", scope: "assembly" },
};

// ── Preset definitions ──────────────────────────────────────────────────────
export type PresetName = "windbg" | "x64dbg";

/** Chord string format: modifiers in alphabetical order + key, all lowercase, joined by "+".
 *  Examples: "f5", "shift+f11", "ctrl+d", "ctrl+shift+d", "alt+arrowleft"
 */
export type ChordString = string;

const SHARED_BINDINGS: Record<string, ChordString> = {
  "panel.disassembly":   "ctrl+d",
  "panel.registers":     "ctrl+r",
  "panel.modules":       "ctrl+m",
  "panel.threads":       "ctrl+t",
  "panel.callstack":     "ctrl+l",
  "panel.symbols":       "ctrl+s",
  "panel.addMemory":     "ctrl+h",
  "panel.memoryRegions": "ctrl+g",
  "panel.breakpoints":   "ctrl+b",
  "panel.memorySearch":  "ctrl+shift+f",
  "panel.peViewer":      "ctrl+p",

  "palette.open":    "ctrl+k",

  "nav.debugger":    "ctrl+shift+d",
  "nav.logs":        "ctrl+shift+l",
  "nav.toggleTheme": "ctrl+shift+t",

  "assembly.goBack":    "alt+arrowleft",
  "assembly.goForward": "alt+arrowright",
};

export const KEYBINDING_PRESETS: Record<PresetName, Record<ActionId, ChordString>> = {
  windbg: {
    "debug.go":       "f5",
    "debug.stepIn":   "f11",
    "debug.stepOver": "f10",
    "debug.stepOut":  "shift+f11",
    ...SHARED_BINDINGS,
  } as Record<ActionId, ChordString>,
  x64dbg: {
    "debug.go":       "f9",
    "debug.stepIn":   "f7",
    "debug.stepOver": "f8",
    "debug.stepOut":  "ctrl+f9",
    ...SHARED_BINDINGS,
  } as Record<ActionId, ChordString>,
};

export const DEFAULT_PRESET: PresetName = "windbg";

// ── Chord normalisation ─────────────────────────────────────────────────────
/** Convert a KeyboardEvent into a normalised chord string for lookup. */
export function keyboardEventToChord(e: KeyboardEvent): ChordString {
  const parts: string[] = [];
  if (e.altKey)   parts.push("alt");
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");

  // Ignore bare modifier presses
  const key = e.key;
  if (["Alt", "Control", "Meta", "Shift"].includes(key)) return "";

  parts.push(key.toLowerCase());
  return parts.join("+");
}

/** Human-readable display string: "ctrl+shift+d" → "Ctrl+Shift+D" */
export function formatKeybinding(chord: ChordString): string {
  if (!chord) return "";
  return chord
    .split("+")
    .map((part) => {
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      // Function keys
      if (/^f\d+$/.test(part)) return part.toUpperCase();
      // Arrow keys
      if (part === "arrowleft") return "Left";
      if (part === "arrowright") return "Right";
      if (part === "arrowup") return "Up";
      if (part === "arrowdown") return "Down";
      // Single char
      if (part.length === 1) return part.toUpperCase();
      // Anything else, capitalize first letter
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}

// ── Reverse lookup (chord → action) ────────────────────────────────────────
export function buildReverseLookup(bindings: Record<ActionId, ChordString>): Map<ChordString, ActionId> {
  const map = new Map<ChordString, ActionId>();
  for (const [actionId, chord] of Object.entries(bindings)) {
    if (chord) {
      map.set(chord, actionId as ActionId);
    }
  }
  return map;
}

// ── Resolve effective bindings ──────────────────────────────────────────────
export interface KeybindingSettings {
  preset: PresetName;
  custom_bindings: Record<string, string>;
}

export const DEFAULT_KEYBINDING_SETTINGS: KeybindingSettings = {
  preset: "windbg",
  custom_bindings: {},
};

/** Merge preset defaults with user overrides. */
export function resolveBindings(settings: KeybindingSettings): Record<ActionId, ChordString> {
  const base = { ...KEYBINDING_PRESETS[settings.preset] };
  for (const [actionId, chord] of Object.entries(settings.custom_bindings)) {
    if (actionId in base) {
      (base as Record<string, string>)[actionId] = chord;
    }
  }
  return base;
}

// ── Ordered categories for UI display ───────────────────────────────────────
export const ACTION_CATEGORIES: ActionCategory[] = ["Debug", "Panels", "Navigation", "Assembly"];

export function getActionsForCategory(category: ActionCategory): ActionId[] {
  return (Object.entries(ACTION_REGISTRY) as [ActionId, ActionMeta][])
    .filter(([, meta]) => meta.category === category)
    .map(([id]) => id);
}
