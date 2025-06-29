import DockLayout, { LayoutData, LayoutBase, TabData } from "rc-dock";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import React from "react";
import { Plus, RefreshCcw, TerminalSquare } from "lucide-react";
import StaticAssemblyView from "@/components/StaticAssemblyView";
import { ScrollArea } from "@/components/ui/scroll-area";

const LAYOUT_STORAGE_KEY = "rc-dock.layout";
const TABS_STORAGE_KEY = "rc-dock.tabs";
const TAB_ID_COUNTER_STORAGE_KEY = "rc-dock.tab_id_counter";

const getSerializableLayout = (l: LayoutBase): LayoutData => {
  function clean(box: any): any {
    const newBox: any = {};
    if (box.mode) newBox.mode = box.mode;
    if (box.size) newBox.size = box.size;

    if (box.tabs) {
      newBox.tabs = box.tabs.map((t: any) => ({ id: t.id }));
      if (box.activeId) newBox.activeId = box.activeId;
    }

    if (box.children) {
      newBox.children = box.children.map(clean);
    }
    return newBox;
  }

  const serializableLayout: LayoutData = {
    dockbox: clean(l.dockbox),
  };

  if ((l as any).floatbox) {
    (serializableLayout as any).floatbox = clean((l as any).floatbox);
  }

  return serializableLayout;
};

const initialTabContents: { [key: string]: TabData } = {
  tab1: {
    id: "tab1",
    title: "Tab 1",
    content: <div>Hello World 1</div>,
    closable: true,
  },
  tab2: {
    id: "tab2",
    title: "Tab 2",
    content: <div>Hello World 2</div>,
    closable: true,
  },
  tab3: {
    id: "tab3",
    title: "Tab 3",
    content: <div>Hello World 3</div>,
    closable: true,
  },
  tab4: {
    id: "tab4",
    title: "Tab 4",
    content: <div>Hello World 4</div>,
    closable: true,
  },
  disassembly: {
    id: "disassembly",
    title: "Disassembly",
    content: <StaticAssemblyView />,
    closable: true,
  },
};

const TabContentMap: Record<string, React.ReactElement> = {
  disassembly: <StaticAssemblyView />,
  tab1: <div>Hello World 1</div>,
  tab2: <div>Hello World 2</div>,
  tab3: <div>Hello World 3</div>,
  tab4: <div>Hello World 4</div>,
};

const initialLayout: LayoutData = {
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

export default function RcDock() {
  const { resolvedTheme } = useTheme();

  const [layout, setLayout] = React.useState<LayoutData>(() => {
    try {
      const savedLayout = localStorage.getItem(LAYOUT_STORAGE_KEY);
      return savedLayout ? JSON.parse(savedLayout) : initialLayout;
    } catch {
      return initialLayout;
    }
  });

  const [tabContents, setTabContents] = React.useState<{
    [key: string]: TabData;
  }>(() => {
    try {
      const savedTabs = localStorage.getItem(TABS_STORAGE_KEY);
      return savedTabs ? JSON.parse(savedTabs) : initialTabContents;
    } catch {
      return initialTabContents;
    }
  });

  const tabIdCounterRef = React.useRef<number>(
    (() => {
      const savedCounter = localStorage.getItem(TAB_ID_COUNTER_STORAGE_KEY);
      return savedCounter ? parseInt(savedCounter, 10) : 4;
    })()
  );

  /* React.useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]); */

  React.useEffect(() => {
    const serializableTabs: { [key:string]: Partial<TabData> } = {};
    for(const id in tabContents) {
      const { id: tabId, title, closable } = tabContents[id];
      serializableTabs[id] = { id: tabId, title, closable };
    }
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(serializableTabs));
  }, [tabContents]);

  const loadTab = React.useCallback(
    (tab: TabData): TabData => {
      let finalTab: TabData;

      if (tab.id && tab.id in tabContents) {
        const loadedTab = { ...tabContents[tab.id] };
        if (!loadedTab.content) {
          if (loadedTab.id && loadedTab.id in TabContentMap) {
            loadedTab.content = TabContentMap[loadedTab.id];
          } else {
            loadedTab.content = <div>{`Content for ${loadedTab.title}`}</div>;
          }
        }
        finalTab = loadedTab;
      } else if (tab.id && tab.id in initialTabContents) {
        finalTab = { ...initialTabContents[tab.id] };
      } else {
        finalTab = tab;
      }

      if (finalTab.content) {
        const originalContent =
          typeof finalTab.content === "function" ? finalTab.content(finalTab) : finalTab.content;
        finalTab.content = (
          <div className="absolute inset-0">
            <ScrollArea className="h-full w-full">{originalContent}</ScrollArea>
          </div>
        );
      }

      return finalTab;
    },
    [tabContents]
  );

  const onAddTab = () => {
    tabIdCounterRef.current++;
    localStorage.setItem(
      TAB_ID_COUNTER_STORAGE_KEY,
      tabIdCounterRef.current.toString()
    );
    const newId = `tab${tabIdCounterRef.current}`;

    setTabContents((currentTabs) => ({
      ...currentTabs,
      [newId]: {
        id: newId,
        title: `Tab ${tabIdCounterRef.current}`,
        content: <div>Hello World {tabIdCounterRef.current}</div>,
        closable: true,
      },
    }));

    setLayout((currentLayout) => {
      const newLayout = JSON.parse(JSON.stringify(currentLayout));

      let panel: any;
      const findPanel = (box: any) => {
        if (panel) return;
        if (box.tabs) {
          panel = box;
        } else if (box.children) {
          for (const child of box.children) {
            findPanel(child);
          }
        }
      };

      findPanel(newLayout.dockbox);

      if (panel && panel.tabs) {
        panel.tabs.push({ id: newId });
      } else {
        if (!newLayout.dockbox.children) {
          newLayout.dockbox.children = [];
        }
        newLayout.dockbox.children.push({ tabs: [{ id: newId }] });
      }

      const serializableLayout = getSerializableLayout(newLayout);
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(serializableLayout));

      return newLayout;
    });
  };

  const onResetLayout = () => {
    setLayout(initialLayout);
    setTabContents(initialTabContents);
    tabIdCounterRef.current = 4;
    localStorage.setItem(TAB_ID_COUNTER_STORAGE_KEY, "4");
  };

  const onToggleDisassembly = () => {
    const tabId = "disassembly";

    setLayout((currentLayout) => {
      let tabExists = false;
      const findTab = (box: any) => {
        if (tabExists || !box) return;
        if (box.tabs?.some((t: TabData) => t.id === tabId)) {
          tabExists = true;
        }
        if (box.children) {
          box.children.forEach(findTab);
        }
      };
      findTab(currentLayout.dockbox);

      const newLayout = JSON.parse(
        JSON.stringify(getSerializableLayout(currentLayout))
      );

      if (tabExists) {
        const findAndActivate = (box: any) => {
          if (!box) return;
          if (box.tabs?.some((t: { id: string }) => t.id === tabId)) {
            box.activeId = tabId;
          }
          if (box.children) {
            box.children.forEach(findAndActivate);
          }
        };
        findAndActivate(newLayout.dockbox);
      } else {
        let panel: any;
        const findPanel = (box: any) => {
          if (panel || !box) return;
          if (box.tabs) {
            panel = box;
          }
          if (box.children) {
            box.children.forEach(findPanel);
          }
        };
        findPanel(newLayout.dockbox);

        if (panel?.tabs) {
          panel.tabs.push({ id: tabId });
          panel.activeId = tabId;
        } else {
          if (!newLayout.dockbox.children) {
            newLayout.dockbox.children = [];
          }
          newLayout.dockbox.children.push({
            tabs: [{ id: tabId }],
            activeId: tabId,
          });
        }
      }

      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(newLayout));
      return newLayout;
    });
  };

  const onLayoutChange = (
    newLayout: LayoutBase,
    currentTabId?: string,
    direction?: "left" | "right" | "top" | "bottom" | "middle"
  ) => {
    const serializableLayout = getSerializableLayout(newLayout);
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(serializableLayout));

    const newLayoutData = newLayout as LayoutData;

    const activeTabIds = new Set<string>();
    const findTabIds = (box: any) => {
      if (box.tabs) {
        box.tabs.forEach((tab: TabData) => {
          if (tab.id) {
            activeTabIds.add(tab.id);
          }
        });
      }
      if (box.children) {
        box.children.forEach(findTabIds);
      }
    };
    findTabIds(newLayoutData.dockbox);

    setLayout(newLayoutData);

    setTabContents((currentTabs) => {
      const newTabs: { [key: string]: TabData } = {};
      for (const tabId of activeTabIds) {
        if (currentTabs[tabId]) {
          newTabs[tabId] = currentTabs[tabId];
        }
      }
      return newTabs;
    });
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 10,
        top: 80,
        right: 10,
        bottom: 10,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <Button variant="outline" size="icon" onClick={onAddTab}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={onResetLayout}>
          <RefreshCcw className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={onToggleDisassembly}>
          <TerminalSquare className="h-4 w-4" />
        </Button>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <DockLayout
          key={resolvedTheme}
          layout={layout}
          loadTab={loadTab}
          onLayoutChange={onLayoutChange}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
          }}
        />
      </div>
    </div>
  );
} 