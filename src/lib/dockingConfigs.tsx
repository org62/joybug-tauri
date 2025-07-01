import React from "react";
import { LayoutData, TabData } from "rc-dock";
import StaticAssemblyView from "@/components/StaticAssemblyView";
import { DockingConfig } from "@/hooks/useDocking";

// Tab content registry - add new tab types here
export const TabContentRegistry: Record<string, React.ReactElement> = {
  disassembly: <StaticAssemblyView />,
  tab1: <div>Hello World 1</div>,
  tab2: <div>Hello World 2</div>,
  tab3: <div>Hello World 3</div>,
  tab4: <div>Hello World 4</div>,
  // Add more tab types as needed
  registers: <div>Registers View</div>,
  memory: <div>Memory View</div>,
  console: <div>Console Output</div>,
  stack: <div>Stack View</div>,
};

// Predefined layouts
export const DefaultLayout: LayoutData = {
  dockbox: {
    mode: "horizontal" as const,
    children: [
      {
        mode: "vertical" as const,
        children: [
          {
            tabs: [{ id: "tab1" } as TabData],
          },
          {
            tabs: [{ id: "tab4" } as TabData],
          },
        ],
      },
      {
        tabs: [{ id: "tab2" } as TabData, { id: "tab3" } as TabData],
      },
    ],
  },
};

export const DebuggerLayout: LayoutData = {
  dockbox: {
    mode: "horizontal" as const,
    children: [
      {
        mode: "vertical" as const,
        size: 300,
        children: [
          {
            tabs: [{ id: "registers" } as TabData],
          },
          {
            tabs: [{ id: "stack" } as TabData],
          },
        ],
      },
      {
        mode: "vertical" as const,
        children: [
          {
            tabs: [{ id: "disassembly" } as TabData],
          },
          {
            size: 200,
            tabs: [{ id: "console" } as TabData],
          },
        ],
      },
      {
        size: 300,
        tabs: [{ id: "memory" } as TabData],
      },
    ],
  },
};

// Predefined tab contents
export const DefaultTabContents: { [key: string]: TabData } = {
  tab1: {
    id: "tab1",
    title: "Tab 1",
    content: TabContentRegistry.tab1,
    closable: true,
  },
  tab2: {
    id: "tab2",
    title: "Tab 2",
    content: TabContentRegistry.tab2,
    closable: true,
  },
  tab3: {
    id: "tab3",
    title: "Tab 3",
    content: TabContentRegistry.tab3,
    closable: true,
  },
  tab4: {
    id: "tab4",
    title: "Tab 4",
    content: TabContentRegistry.tab4,
    closable: true,
  },
  disassembly: {
    id: "disassembly",
    title: "Disassembly",
    content: TabContentRegistry.disassembly,
    closable: true,
  },
};

export const DebuggerTabContents: { [key: string]: TabData } = {
  disassembly: {
    id: "disassembly",
    title: "Disassembly",
    content: TabContentRegistry.disassembly,
    closable: true,
  },
  registers: {
    id: "registers",
    title: "Registers",
    content: TabContentRegistry.registers,
    closable: true,
  },
  memory: {
    id: "memory",
    title: "Memory",
    content: TabContentRegistry.memory,
    closable: true,
  },
  console: {
    id: "console",
    title: "Console",
    content: TabContentRegistry.console,
    closable: true,
  },
  stack: {
    id: "stack",
    title: "Stack",
    content: TabContentRegistry.stack,
    closable: true,
  },
};

// Predefined configurations
export const DefaultDockingConfig: DockingConfig = {
  storagePrefix: "default-dock",
  initialLayout: DefaultLayout,
  initialTabContents: DefaultTabContents,
  tabContentMap: TabContentRegistry,
};

export const DebuggerDockingConfig: DockingConfig = {
  storagePrefix: "debugger-dock",
  initialLayout: DebuggerLayout,
  initialTabContents: DebuggerTabContents,
  tabContentMap: TabContentRegistry,
};

// Utility function to create custom configurations
export function createDockingConfig(
  storagePrefix: string,
  layout: LayoutData,
  tabContents: { [key: string]: TabData },
  additionalTabTypes?: Record<string, React.ReactElement>
): DockingConfig {
  const tabContentMap = additionalTabTypes 
    ? { ...TabContentRegistry, ...additionalTabTypes }
    : TabContentRegistry;

  return {
    storagePrefix,
    initialLayout: layout,
    initialTabContents: tabContents,
    tabContentMap,
  };
} 