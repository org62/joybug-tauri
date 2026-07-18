// ── Action IDs ──────────────────────────────────────────────────────────────
export type ActionId =
  // Debug stepping
  | "debug.go"
  | "debug.goPassException"
  | "debug.stepIn"
  | "debug.stepOver"
  | "debug.stepOut"
  // Panels — these navigate to a panel; only panel.closeTab closes one
  | "panel.disassembly"
  | "panel.source"
  | "panel.registers"
  | "panel.modules"
  | "panel.threads"
  | "panel.callstack"
  | "panel.symbols"
  | "panel.types"
  | "panel.addMemory"
  | "panel.memoryRegions"
  | "panel.breakpoints"
  | "panel.patches"
  | "panel.bookmarks"
  | "panel.memorySearch"
  | "panel.memoryScanner"
  | "panel.pointerScan"
  | "panel.strings"
  | "panel.codeExplorer"
  | "panel.peViewer"
  | "panel.closeTab"
  // Navigation (global)
  | "nav.debugger"
  | "nav.logs"
  | "nav.toggleTheme"
  // Command palette
  | "palette.open"
  // Navigate
  | "navigate.goToDisassembly"
  | "navigate.goToMemory"
  // Assembly view
  | "assembly.goBack"
  | "assembly.goForward"
  | "assembly.toggleBreakpoint";

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
  "debug.go":        { label: "Go / Break",       category: "Debug",    description: "Continue when paused, break in while running, start when stopped", scope: "session" },
  "debug.goPassException": { label: "Go (Pass Exception)", category: "Debug", description: "Continue and pass the current exception to the debuggee's handler", scope: "session" },
  "debug.stepIn":    { label: "Step Into",         category: "Debug",    description: "Step into the next instruction or function",  scope: "session" },
  "debug.stepOver":  { label: "Step Over",         category: "Debug",    description: "Step over the next instruction",              scope: "session" },
  "debug.stepOut":   { label: "Step Out",          category: "Debug",    description: "Step out of the current function",            scope: "session" },

  "panel.disassembly":   { label: "Go to Disassembly",    category: "Panels", description: "Open and focus the Disassembly panel",    scope: "session" },
  "panel.source":        { label: "Go to Source",         category: "Panels", description: "Open and focus the Source panel",         scope: "session" },
  "panel.registers":     { label: "Go to Registers",      category: "Panels", description: "Open and focus the Registers panel",      scope: "session" },
  "panel.modules":       { label: "Go to Modules",        category: "Panels", description: "Open and focus the Modules panel",        scope: "session" },
  "panel.threads":       { label: "Go to Threads",        category: "Panels", description: "Open and focus the Threads panel",        scope: "session" },
  "panel.callstack":     { label: "Go to Call Stack",     category: "Panels", description: "Open and focus the Call Stack panel",     scope: "session" },
  "panel.symbols":       { label: "Go to Symbols",        category: "Panels", description: "Open and focus the Symbols panel",        scope: "session" },
  "panel.types":         { label: "Go to Types",          category: "Panels", description: "Open and focus the Types panel",          scope: "session" },
  "panel.addMemory":     { label: "Add Memory Window",     category: "Panels", description: "Open a new Memory hex editor tab",      scope: "session" },
  "panel.memoryRegions": { label: "Go to Memory Regions", category: "Panels", description: "Open and focus the Memory Regions panel", scope: "session" },
  "panel.breakpoints":   { label: "Go to Breakpoints",    category: "Panels", description: "Open and focus the Breakpoints panel",    scope: "session" },
  "panel.patches":       { label: "Go to Patches",        category: "Panels", description: "Open and focus the Patches panel",        scope: "session" },
  "panel.bookmarks":     { label: "Go to Bookmarks",      category: "Panels", description: "Open and focus the Bookmarks panel",      scope: "session" },
  "panel.memorySearch":  { label: "Go to Memory Search",  category: "Panels", description: "Open and focus the Memory Search panel",  scope: "session" },
  "panel.memoryScanner": { label: "Go to Memory Scanner", category: "Panels", description: "Open and focus the Memory Scanner panel", scope: "session" },
  "panel.pointerScan":   { label: "Go to Pointer Scan",   category: "Panels", description: "Open and focus the Pointer Scan panel",   scope: "session" },
  "panel.strings":       { label: "Go to Strings",        category: "Panels", description: "Open and focus the Strings panel",        scope: "session" },
  "panel.codeExplorer":  { label: "Go to Code Explorer",  category: "Panels", description: "Open and focus the Code Explorer panel",  scope: "session" },
  "panel.peViewer":      { label: "Go to PE Viewer",      category: "Panels", description: "Open and focus the PE Viewer panel",      scope: "session" },
  "panel.closeTab":      { label: "Close Active Tab",      category: "Panels", description: "Close the currently focused dock tab",     scope: "session" },

  "palette.open":    { label: "Command Palette",  category: "Navigation", description: "Open the command palette",                 scope: "global" },

  "navigate.goToDisassembly": { label: "Go to Address (Disassembly)", category: "Navigation", description: "Open address input to navigate disassembly view", scope: "session" },
  "navigate.goToMemory":      { label: "Go to Address (Memory)",      category: "Navigation", description: "Open address input to navigate memory view",      scope: "session" },

  "nav.debugger":    { label: "Go to Debugger",  category: "Navigation", description: "Navigate to the Debugger page",           scope: "global" },
  "nav.logs":        { label: "Go to Logs",      category: "Navigation", description: "Navigate to the Logs page",               scope: "global" },
  "nav.toggleTheme": { label: "Toggle Theme",    category: "Navigation", description: "Switch between light and dark theme",      scope: "global" },

  "assembly.goBack":            { label: "Go Back",            category: "Assembly", description: "Navigate back in history (addresses and windows)",    scope: "assembly" },
  "assembly.goForward":         { label: "Go Forward",         category: "Assembly", description: "Navigate forward in history (addresses and windows)", scope: "assembly" },
  "assembly.toggleBreakpoint":  { label: "Toggle Breakpoint",  category: "Debug", description: "Toggle breakpoint on selected line",      scope: "assembly" },
};

// ── Preset definitions ──────────────────────────────────────────────────────
export type PresetName = "windbg" | "x64dbg";

/** Chord string format: modifiers in alphabetical order + key, all lowercase, joined by "+".
 *  Examples: "f5", "shift+f11", "ctrl+d", "ctrl+shift+d", "alt+arrowleft"
 */
export type ChordString = string;

const SHARED_BINDINGS: Record<string, ChordString> = {
  "panel.disassembly":   "ctrl+d",
  "panel.source":        "ctrl+shift+s",
  "panel.registers":     "ctrl+r",
  "panel.modules":       "ctrl+m",
  "panel.threads":       "ctrl+t",
  "panel.callstack":     "ctrl+l",
  "panel.symbols":       "ctrl+s",
  "panel.types":         "ctrl+shift+y",
  "panel.addMemory":     "ctrl+h",
  "panel.memoryRegions": "ctrl+g",
  "panel.breakpoints":   "ctrl+b",
  "panel.memorySearch":  "ctrl+shift+f",
  "panel.codeExplorer":  "ctrl+shift+e",
  "panel.peViewer":      "ctrl+p",
  "panel.closeTab":      "ctrl+w",

  "navigate.goToDisassembly": "ctrl+shift+1",
  "navigate.goToMemory":      "ctrl+shift+2",

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
    "debug.goPassException": "shift+f5",
    "debug.stepIn":   "f11",
    "debug.stepOver": "f10",
    "debug.stepOut":  "shift+f11",
    "assembly.toggleBreakpoint": "f9",
    ...SHARED_BINDINGS,
  } as Record<ActionId, ChordString>,
  x64dbg: {
    "debug.go":       "f9",
    "debug.goPassException": "shift+f9",
    "debug.stepIn":   "f7",
    "debug.stepOver": "f8",
    "debug.stepOut":  "ctrl+f9",
    "assembly.toggleBreakpoint": "f2",
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
  let key = e.key;
  if (["Alt", "Control", "Meta", "Shift"].includes(key)) return "";

  // Normalise shifted digit characters back to base digits (e.g. "!" → "1")
  const SHIFTED_DIGITS: Record<string, string> = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
    "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  };
  if (e.shiftKey && SHIFTED_DIGITS[key]) {
    key = SHIFTED_DIGITS[key];
  }

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
