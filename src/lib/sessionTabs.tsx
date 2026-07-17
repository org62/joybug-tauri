import React from "react";
import {
  Code, Cpu, Box, Layers, ListTree, Search, HardDrive, MapPin, FileCode,
  ScanSearch, Puzzle, Crosshair, Bookmark as BookmarkIcon, Boxes, Type, Radar, Fingerprint,
} from "lucide-react";
import type { ActionId } from "@/lib/keybindings";

// Single source of truth for the session's dock tabs. The Windows menu, the
// command palette, the keyboard chords, the initial layout and the tab contents
// all derive from this table — before it existed the same list was hand-written
// in four places and drifted (access_trace had no chord, memory was missing from
// the Windows menu). Mirrors the PE_TAB_DEFS pattern in pages/PeReader.tsx.

/** Menu submenu + palette section. Presentation only — see `home` for placement. */
export type TabCategory = "Code" | "Process" | "Memory" | "Search" | "Symbols" | "Debug";

/** Panel ids seeded in DebuggerDockingConfig.initialLayout. rc-dock preserves
 *  explicit box ids, which is what makes a tab's home resolvable at open time. */
export type HomePanelId =
  | "panel-left-top"
  | "panel-left-bottom"
  | "panel-center"
  | "panel-right-top"
  | "panel-right-bottom";

export interface SessionTabDef {
  /** Dock tab id — also the layout key and the palette command suffix. */
  id: string;
  /** Dock tab title, Windows menu label, and "Go to {title}" in the palette. */
  title: string;
  category: TabCategory;
  home: HomePanelId;
  /** Keybinding action; omitted for tabs with no chord (memory, access_trace). */
  action?: ActionId;
  /** Palette only — the Windows menu stays text-only. */
  icon: React.ReactNode;
  /** Extra cmdk fuzzy-match terms. */
  keywords?: string[];
}

export const SESSION_TAB_CATEGORIES: TabCategory[] = [
  "Code", "Process", "Memory", "Search", "Symbols", "Debug",
];

// Category is not derivable from home, nor the reverse: the Process tabs live in
// both side columns, while most categories share the center panel.
// `as const` is what yields the SessionTabId union below; consumers read the
// widened SESSION_TAB_DEFS so optional fields stay accessible.
const TAB_DEFS = [
  // ── Code ──
  { id: "disassembly", title: "Disassembly", category: "Code", home: "panel-center",
    action: "panel.disassembly", icon: <Code className="size-4" />,
    keywords: ["disassembly", "asm", "code"] },
  { id: "source", title: "Source", category: "Code", home: "panel-center",
    action: "panel.source", icon: <FileCode className="size-4" />,
    keywords: ["source", "code", "c", "cpp", "line"] },
  { id: "code_explorer", title: "Code Explorer", category: "Code", home: "panel-center",
    action: "panel.codeExplorer", icon: <Radar className="size-4" />,
    keywords: ["code", "explorer", "coverage", "heatmap", "functions", "breakpoint"] },

  // ── Process ──
  { id: "registers", title: "Registers", category: "Process", home: "panel-right-top",
    action: "panel.registers", icon: <Cpu className="size-4" />,
    keywords: ["registers", "regs"] },
  { id: "callstack", title: "Call Stack", category: "Process", home: "panel-right-bottom",
    action: "panel.callstack", icon: <ListTree className="size-4" />,
    keywords: ["callstack", "stack", "frames"] },
  { id: "threads", title: "Threads", category: "Process", home: "panel-left-bottom",
    action: "panel.threads", icon: <Layers className="size-4" />,
    keywords: ["threads"] },
  { id: "modules", title: "Modules", category: "Process", home: "panel-left-top",
    action: "panel.modules", icon: <Box className="size-4" />,
    keywords: ["modules", "dll"] },

  // ── Memory ──
  { id: "memory", title: "Memory", category: "Memory", home: "panel-center",
    icon: <HardDrive className="size-4" />,
    keywords: ["memory", "hex", "dump"] },
  { id: "memory_regions", title: "Memory Regions", category: "Memory", home: "panel-center",
    action: "panel.memoryRegions", icon: <HardDrive className="size-4" />,
    keywords: ["memory", "regions", "map"] },
  { id: "strings", title: "Strings", category: "Memory", home: "panel-center",
    action: "panel.strings", icon: <Type className="size-4" />,
    keywords: ["strings", "ascii", "unicode", "utf16", "text"] },

  // ── Search ──
  { id: "memory_search", title: "Memory Search", category: "Search", home: "panel-center",
    action: "panel.memorySearch", icon: <Search className="size-4" />,
    keywords: ["memory", "search", "find", "pattern"] },
  { id: "memory_scanner", title: "Memory Scanner", category: "Search", home: "panel-center",
    action: "panel.memoryScanner", icon: <ScanSearch className="size-4" />,
    keywords: ["memory", "scanner", "scan", "cheat"] },
  { id: "pointer_scan", title: "Pointer Scan", category: "Search", home: "panel-center",
    action: "panel.pointerScan", icon: <Crosshair className="size-4" />,
    keywords: ["pointer", "scan", "path", "cheat", "static"] },
  { id: "access_trace", title: "Access Trace", category: "Search", home: "panel-center",
    icon: <Fingerprint className="size-4" />,
    keywords: ["access", "trace", "watchpoint", "reads", "writes", "hardware", "what accesses"] },

  // ── Symbols ──
  { id: "symbols", title: "Symbols", category: "Symbols", home: "panel-left-top",
    action: "panel.symbols", icon: <Search className="size-4" />,
    keywords: ["symbols", "functions"] },
  { id: "types", title: "Types", category: "Symbols", home: "panel-left-top",
    action: "panel.types", icon: <Boxes className="size-4" />,
    keywords: ["types", "struct", "teb", "peb", "kuser"] },
  { id: "peviewer", title: "PE Viewer", category: "Symbols", home: "panel-left-top",
    action: "panel.peViewer", icon: <FileCode className="size-4" />,
    keywords: ["pe", "portable", "executable", "viewer"] },

  // ── Debug ──
  { id: "breakpoints", title: "Breakpoints", category: "Debug", home: "panel-center",
    action: "panel.breakpoints", icon: <MapPin className="size-4" />,
    keywords: ["breakpoints", "bp"] },
  { id: "patches", title: "Patches", category: "Debug", home: "panel-center",
    action: "panel.patches", icon: <Puzzle className="size-4" />,
    keywords: ["patches", "assemble", "patch"] },
  { id: "bookmarks", title: "Bookmarks", category: "Debug", home: "panel-center",
    action: "panel.bookmarks", icon: <BookmarkIcon className="size-4" />,
    keywords: ["bookmarks", "bookmark", "freeze", "lock", "cheat", "address"] },
] as const satisfies readonly SessionTabDef[];

/** Every tab id the session knows about — the key type for tab-content records. */
export type SessionTabId = (typeof TAB_DEFS)[number]["id"];

export const SESSION_TAB_DEFS: readonly SessionTabDef[] = TAB_DEFS;

const SESSION_TAB_BY_ID = new Map<string, SessionTabDef>(SESSION_TAB_DEFS.map((d) => [d.id, d]));

export const SESSION_TAB_BY_ACTION = new Map<ActionId, SessionTabDef>(
  SESSION_TAB_DEFS.filter((d) => d.action).map((d) => [d.action as ActionId, d]),
);

/** Dynamic memory tabs are "memory-1", "memory-2", … — all share the `memory` def. */
export function sessionTabDefFor(tabId: string): SessionTabDef | undefined {
  const baseId = tabId.startsWith("memory-") ? "memory" : tabId;
  return SESSION_TAB_BY_ID.get(baseId);
}
