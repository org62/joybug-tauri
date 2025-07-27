import React from "react";
import { LayoutData, LayoutBase, TabData } from "rc-dock";

export interface DockingConfig {
  storagePrefix?: string;
  initialLayout: LayoutData;
  initialTabContents: { [key: string]: TabData };
  tabContentMap: Record<string, React.ReactElement>;
  onTabsChanged?: (activeTabIds: string[]) => void;
}

export interface DockingOperations {
  addTab: () => void;
  resetLayout: () => void;
  toggleTab: (tabId: string) => void;
  onLayoutChange: (
    newLayout: LayoutBase
  ) => void;
}

export interface DockingState {
  layout: LayoutData;
  tabContents: { [key: string]: TabData };
  loadTab: (tab: TabData) => TabData;
}

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

export function useDocking(config: DockingConfig): DockingState & DockingOperations {
  const {
    storagePrefix = "rc-dock",
    initialLayout,
    initialTabContents,
    tabContentMap,
    onTabsChanged,
  } = config;

  const LAYOUT_STORAGE_KEY = `${storagePrefix}.layout`;
  const TABS_STORAGE_KEY = `${storagePrefix}.tabs`;
  const TAB_ID_COUNTER_STORAGE_KEY = `${storagePrefix}.tab_id_counter`;

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
      return savedCounter ? parseInt(savedCounter, 10) : Object.keys(initialTabContents).length;
    })()
  );

  React.useEffect(() => {
    const serializableTabs: { [key: string]: Partial<TabData> } = {};
    for (const id in tabContents) {
      const { id: tabId, title, closable } = tabContents[id];
      serializableTabs[id] = { id: tabId, title, closable };
    }
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(serializableTabs));
  }, [tabContents, TABS_STORAGE_KEY]);

  const loadTab = React.useCallback(
    (tab: TabData): TabData => {
      let finalTab: TabData;

      if (tab.id && tab.id in tabContents) {
        const loadedTab = { ...tabContents[tab.id] };
        if (!loadedTab.content) {
          if (loadedTab.id && loadedTab.id in tabContentMap) {
            loadedTab.content = tabContentMap[loadedTab.id];
          } else {
            loadedTab.content = React.createElement("div", null, `Content for ${loadedTab.title}`);
          }
        }
        finalTab = loadedTab;
      } else if (tab.id && tab.id in initialTabContents) {
        finalTab = { ...initialTabContents[tab.id] };
      } else {
        finalTab = tab;
      }

      // Always respect the closable property from initial configuration
      if (tab.id && tab.id in initialTabContents) {
        finalTab.closable = initialTabContents[tab.id].closable;
      }

      return finalTab;
    },
    [tabContents, tabContentMap, initialTabContents]
  );

  const addTab = React.useCallback(() => {
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
        content: React.createElement("div", null, `Hello World ${tabIdCounterRef.current}`),
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
  }, [LAYOUT_STORAGE_KEY, TAB_ID_COUNTER_STORAGE_KEY]);

  const resetLayout = React.useCallback(() => {
    setLayout(initialLayout);
    setTabContents(initialTabContents);
    const initialCounter = Object.keys(initialTabContents).length;
    tabIdCounterRef.current = initialCounter;
    localStorage.setItem(TAB_ID_COUNTER_STORAGE_KEY, initialCounter.toString());
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(initialLayout));
    
    // Trigger onTabsChanged callback immediately after reset
    if (onTabsChanged) {
      const activeTabIds = new Set<string>();
      const findTabIds = (box: any) => {
        if (box.tabs) {
          box.tabs.forEach((tab: any) => {
            if (tab.id) {
              activeTabIds.add(tab.id);
            }
          });
        }
        if (box.children) {
          box.children.forEach(findTabIds);
        }
      };
      findTabIds(initialLayout.dockbox);
      
      // Call immediately - no timeout needed
      onTabsChanged(Array.from(activeTabIds));
    }
  }, [initialLayout, initialTabContents, LAYOUT_STORAGE_KEY, TAB_ID_COUNTER_STORAGE_KEY, onTabsChanged]);

  const toggleTab = React.useCallback((tabId: string) => {
    setLayout((currentLayout) => {
      let tabExists = false;
      let isActiveTab = false;

      const findTab = (box: any) => {
        if (tabExists || !box) return;
        if (box.tabs?.some((t: TabData) => t.id === tabId)) {
          tabExists = true;
          isActiveTab = box.activeId === tabId;
        }
        if (box.children) {
          box.children.forEach(findTab);
        }
      };
      findTab(currentLayout.dockbox);

      const newLayout = JSON.parse(
        JSON.stringify(getSerializableLayout(currentLayout))
      );

      if (tabExists && isActiveTab) {
        // Tab exists and is active - close it
        const removeTab = (box: any) => {
          if (!box) return;
          if (box.tabs) {
            const tabIndex = box.tabs.findIndex((t: { id: string }) => t.id === tabId);
            if (tabIndex !== -1) {
              box.tabs.splice(tabIndex, 1);
              
              // If this was the active tab, set a new active tab or clear activeId
              if (box.activeId === tabId) {
                if (box.tabs.length > 0) {
                  // Set the first remaining tab as active
                  box.activeId = box.tabs[0].id;
                } else {
                  // No tabs left, clear activeId
                  delete box.activeId;
                }
              }
              
              // If panel has no tabs left, we might want to remove the panel
              // But for now, we'll keep empty panels to maintain layout structure
            }
          }
          if (box.children) {
            box.children.forEach(removeTab);
          }
        };
        removeTab(newLayout.dockbox);
      } else if (tabExists) {
        // Tab exists but is not active - activate it
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
        // Tab doesn't exist - add it
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
      
      // Trigger onTabsChanged callback immediately after layout update
      if (onTabsChanged) {
        const activeTabIds = new Set<string>();
        const findTabIds = (box: any) => {
          if (box.tabs) {
            box.tabs.forEach((tab: any) => {
              if (tab.id) {
                activeTabIds.add(tab.id);
              }
            });
          }
          if (box.children) {
            box.children.forEach(findTabIds);
          }
        };
        findTabIds(newLayout.dockbox);
        
        // Call immediately - no timeout needed
        onTabsChanged(Array.from(activeTabIds));
      }
      
      return newLayout;
    });
  }, [LAYOUT_STORAGE_KEY, onTabsChanged]);

  const onLayoutChange = React.useCallback(
    (
      newLayout: LayoutBase
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

      if (onTabsChanged) {
        onTabsChanged(Array.from(activeTabIds));
      }
    },
    [LAYOUT_STORAGE_KEY, onTabsChanged]
  );

  return {
    layout,
    tabContents,
    loadTab,
    addTab,
    resetLayout,
    toggleTab,
    onLayoutChange,
  };
} 