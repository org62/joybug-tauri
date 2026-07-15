import React from "react";
import { LayoutData, TabData } from "rc-dock";
import { DockingConfig } from "@/hooks/useDocking";
import {
  RegisterView as StaticRegisterView,
  SerializableThreadContext,
  X64_REGISTERS,
  X64_XMM_REGISTERS,
  X64_DEBUG_REGISTERS,
} from "@/components/RegisterView";

// Zero-valued x64 context for the static tab preview, derived from the
// register defs so it never drifts when registers are added.
const mockContext = {
  arch: "X64",
  ...Object.fromEntries(
    [...X64_REGISTERS, ...X64_XMM_REGISTERS, ...X64_DEBUG_REGISTERS].map((d) => [d.field, "0x0"]),
  ),
} as SerializableThreadContext;

export const DebuggerDockingConfig: DockingConfig = {
  storagePrefix: "debugger-dock",
  initialLayout: {
    dockbox: {
      mode: "horizontal" as const,
      children: [
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            {
              tabs: [{ id: "modules" }],
              activeId: "modules",
            },
            {
              tabs: [{ id: "threads" }],
              activeId: "threads",
            },
            {
              tabs: [{ id: "symbols" }, { id: "types" }],
              activeId: "symbols",
            },
          ],
        },
        {
          tabs: [{ id: "disassembly" }, { id: "source" }, { id: "memory" }, { id: "memory_regions" }, { id: "breakpoints" }, { id: "patches" }, { id: "bookmarks" }, { id: "memory_search" }, { id: "memory_scanner" }, { id: "pointer_scan" }, { id: "strings" }, { id: "peviewer" }],
          activeId: "disassembly",
        },
        {
          mode: "vertical" as const,
          size: 80,
          children: [
            {
              tabs: [{ id: "registers" }],
              activeId: "registers",
            },
            {
              tabs: [{ id: "callstack" }],
              activeId: "callstack",
            },
          ],
        },
      ],
    },
  } as LayoutData,
  initialTabContents: {
    disassembly: { id: "disassembly", title: "Disassembly", content: <div>Disassembly placeholder</div> },
    source: { id: "source", title: "Source", content: <div>Source placeholder</div> },
    registers: { id: "registers", title: "Registers", content: <StaticRegisterView context={mockContext} /> },
    modules: { id: "modules", title: "Modules", content: <div>Modules placeholder</div> },
    threads: { id: "threads", title: "Threads", content: <div>Threads placeholder</div> },
    callstack: { id: "callstack", title: "Call Stack", content: <div>Call Stack placeholder</div> },
    symbols: { id: "symbols", title: "Symbols", content: <div>Symbols placeholder</div> },
    types: { id: "types", title: "Types", content: <div>Types placeholder</div> },
    memory: { id: "memory", title: "Memory", content: <div>Memory placeholder</div> },
    memory_regions: { id: "memory_regions", title: "Memory Regions", content: <div>Memory Regions placeholder</div> },
    breakpoints: { id: "breakpoints", title: "Breakpoints", content: <div>Breakpoints placeholder</div> },
    patches: { id: "patches", title: "Patches", content: <div>Patches placeholder</div> },
    bookmarks: { id: "bookmarks", title: "Bookmarks", content: <div>Bookmarks placeholder</div> },
    memory_search: { id: "memory_search", title: "Memory Search", content: <div>Memory Search placeholder</div> },
    memory_scanner: { id: "memory_scanner", title: "Memory Scanner", content: <div>Memory Scanner placeholder</div> },
    pointer_scan: { id: "pointer_scan", title: "Pointer Scan", content: <div>Pointer Scan placeholder</div> },
    strings: { id: "strings", title: "Strings", content: <div>Strings placeholder</div> },
    peviewer: { id: "peviewer", title: "PE Viewer", content: <div>PE Viewer placeholder</div> },
  } as { [key: string]: TabData },
  tabContentMap: {
    registers: <StaticRegisterView context={mockContext} />,
  } as { [key: string]: React.ReactElement },
}; 