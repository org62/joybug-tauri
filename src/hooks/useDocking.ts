import React from "react";
import { LayoutData, LayoutBase, TabData } from "rc-dock";

export interface DockingConfig {
  storagePrefix?: string;
  initialLayout: LayoutData;
  initialTabContents: { [key: string]: TabData };
  tabContentMap: Record<string, React.ReactElement>;
  tabContentFactory?: (tabId: string) => React.ReactElement | null;
  onTabsChanged?: (activeTabIds: string[]) => void;
}

export interface DockingOperations {
  addTab: () => void;
  addTypedTab: (type: string, contentFactory: (tabId: string) => React.ReactElement) => string;
  resetLayout: () => void;
  toggleTab: (tabId: string) => void;
  showTab: (tabId: string) => void;
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

// --- Layout tree helpers ---

/** Find whether a tab exists in the layout and whether it's the active tab in its panel */
function findTabState(dockbox: any, tabId: string): { exists: boolean; isActive: boolean } {
  let exists = false, isActive = false;
  const walk = (box: any) => {
    if (exists || !box) return;
    if (box.tabs?.some((t: any) => t.id === tabId)) {
      exists = true;
      isActive = box.activeId === tabId;
    }
    if (box.children) box.children.forEach(walk);
  };
  walk(dockbox);
  return { exists, isActive };
}

/** Set a tab as the active tab in its panel */
function activateTab(dockbox: any, tabId: string) {
  const walk = (box: any) => {
    if (!box) return;
    if (box.tabs?.some((t: { id: string }) => t.id === tabId)) {
      box.activeId = tabId;
    }
    if (box.children) box.children.forEach(walk);
  };
  walk(dockbox);
}

/** Add a tab to the first panel found in the layout and activate it */
function addTabToFirstPanel(dockbox: any, tabId: string) {
  let panel: any;
  const findPanel = (box: any) => {
    if (panel || !box) return;
    if (box.tabs) { panel = box; return; }
    if (box.children) box.children.forEach(findPanel);
  };
  findPanel(dockbox);

  if (panel?.tabs) {
    panel.tabs.push({ id: tabId });
    panel.activeId = tabId;
  } else {
    if (!dockbox.children) dockbox.children = [];
    dockbox.children.push({ tabs: [{ id: tabId }], activeId: tabId });
  }
}

/** Collect all tab IDs present in a layout box tree */
function collectTabIds(box: any): string[] {
  const ids = new Set<string>();
  const walk = (b: any) => {
    if (b?.tabs) b.tabs.forEach((t: any) => { if (t.id) ids.add(t.id); });
    if (b?.children) b.children.forEach(walk);
  };
  walk(box);
  return Array.from(ids);
}

export function useDocking(config: DockingConfig): DockingState & DockingOperations {
  const {
    storagePrefix = "rc-dock",
    initialLayout,
    initialTabContents,
    tabContentMap,
    tabContentFactory,
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
          } else if (tabContentFactory && loadedTab.id) {
            // Try factory for dynamic tabs (e.g., memory-1, memory-2)
            const factoryContent = tabContentFactory(loadedTab.id);
            if (factoryContent) {
              loadedTab.content = factoryContent;
            } else {
              loadedTab.content = React.createElement("div", null, `Content for ${loadedTab.title}`);
            }
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

      finalTab.cached = true;
      return finalTab;
    },
    [tabContents, tabContentMap, tabContentFactory, initialTabContents]
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
      // Use getSerializableLayout to avoid circular references from React elements
      const newLayout = JSON.parse(JSON.stringify(getSerializableLayout(currentLayout)));

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

      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(newLayout));

      return newLayout;
    });
  }, [LAYOUT_STORAGE_KEY, TAB_ID_COUNTER_STORAGE_KEY]);

  const addTypedTab = React.useCallback((type: string, contentFactory: (tabId: string) => React.ReactElement): string => {
    // Find existing tab IDs of this type to determine the lowest available number
    const existingIds = new Set<number>();
    const findExistingTypeIds = (box: any) => {
      if (box.tabs) {
        box.tabs.forEach((tab: any) => {
          if (tab.id === type) {
            existingIds.add(0); // The base ID "memory" corresponds to number 0 (display as 1)
          } else if (tab.id?.startsWith(`${type}-`)) {
            const num = parseInt(tab.id.slice(type.length + 1), 10);
            if (!isNaN(num)) {
              existingIds.add(num);
            }
          }
        });
      }
      if (box.children) {
        box.children.forEach(findExistingTypeIds);
      }
    };
    findExistingTypeIds(layout.dockbox);

    // Find the lowest available number (0-based internally, 1-based for display)
    let nextNumber = 0;
    while (existingIds.has(nextNumber)) {
      nextNumber++;
    }

    // Generate ID: first one is just the type, subsequent ones get numbers
    const newId = nextNumber === 0 ? type : `${type}-${nextNumber}`;
    const displayNumber = nextNumber + 1;

    // Capitalize first letter for title
    const typeTitle = type.charAt(0).toUpperCase() + type.slice(1);
    const title = displayNumber === 1 ? typeTitle : `${typeTitle} ${displayNumber}`;

    setTabContents((currentTabs) => ({
      ...currentTabs,
      [newId]: {
        id: newId,
        title,
        content: contentFactory(newId),
        closable: true,
      },
    }));

    setLayout((currentLayout) => {
      // Use getSerializableLayout to avoid circular references from React elements
      const newLayout = JSON.parse(JSON.stringify(getSerializableLayout(currentLayout)));

      // Try to find existing panel with same type tabs, or any panel
      let targetPanel: any = null;
      const findPanel = (box: any) => {
        if (targetPanel) return;
        if (box.tabs) {
          // Prefer panel that already has tabs of this type
          const hasTypeTab = box.tabs.some((t: any) => t.id === type || t.id?.startsWith(`${type}-`));
          if (hasTypeTab || !targetPanel) {
            targetPanel = box;
          }
        }
        if (box.children) {
          box.children.forEach(findPanel);
        }
      };
      findPanel(newLayout.dockbox);

      if (targetPanel?.tabs) {
        targetPanel.tabs.push({ id: newId });
        targetPanel.activeId = newId;
      } else {
        if (!newLayout.dockbox.children) {
          newLayout.dockbox.children = [];
        }
        newLayout.dockbox.children.push({ tabs: [{ id: newId }], activeId: newId });
      }

      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(newLayout));

      return newLayout;
    });

    return newId;
  }, [layout, LAYOUT_STORAGE_KEY]);

  const resetLayout = React.useCallback(() => {
    setLayout(initialLayout);
    setTabContents(initialTabContents);
    const initialCounter = Object.keys(initialTabContents).length;
    tabIdCounterRef.current = initialCounter;
    localStorage.setItem(TAB_ID_COUNTER_STORAGE_KEY, initialCounter.toString());
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(initialLayout));

    if (onTabsChanged) {
      onTabsChanged(collectTabIds(initialLayout.dockbox));
    }
  }, [initialLayout, initialTabContents, LAYOUT_STORAGE_KEY, TAB_ID_COUNTER_STORAGE_KEY, onTabsChanged]);

  const toggleTab = React.useCallback((tabId: string) => {
    setLayout((currentLayout) => {
      const { exists, isActive } = findTabState(currentLayout.dockbox, tabId);

      const newLayout = JSON.parse(
        JSON.stringify(getSerializableLayout(currentLayout))
      );

      if (exists && isActive) {
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
            }
          }
          if (box.children) {
            box.children.forEach(removeTab);
          }
        };
        removeTab(newLayout.dockbox);
      } else if (exists) {
        activateTab(newLayout.dockbox, tabId);
      } else {
        addTabToFirstPanel(newLayout.dockbox, tabId);
      }

      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(newLayout));

      if (onTabsChanged) {
        onTabsChanged(collectTabIds(newLayout.dockbox));
      }

      return newLayout;
    });
  }, [LAYOUT_STORAGE_KEY, onTabsChanged]);

  const showTab = React.useCallback((tabId: string) => {
    setLayout((currentLayout) => {
      const { exists, isActive } = findTabState(currentLayout.dockbox, tabId);

      // If tab already exists and is active, no layout change needed
      if (exists && isActive) {
        return currentLayout;
      }

      const newLayout = JSON.parse(
        JSON.stringify(getSerializableLayout(currentLayout))
      );

      if (exists) {
        activateTab(newLayout.dockbox, tabId);
      } else {
        addTabToFirstPanel(newLayout.dockbox, tabId);
      }

      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(newLayout));

      if (onTabsChanged) {
        onTabsChanged(collectTabIds(newLayout.dockbox));
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

      const dockTabIds = newLayoutData.dockbox ? collectTabIds(newLayoutData.dockbox) : [];
      // Also search floatbox for undocked/floating tabs
      const floatbox = (newLayoutData as any).floatbox;
      const floatTabIds = floatbox ? collectTabIds(floatbox) : [];
      const allTabIds = [...new Set([...dockTabIds, ...floatTabIds])];

      setLayout(newLayoutData);

      const activeTabIdSet = new Set(allTabIds);
      setTabContents((currentTabs) => {
        const currentKeys = Object.keys(currentTabs);
        // If the same tabs exist, return the same reference to avoid unnecessary re-renders
        if (currentKeys.length === activeTabIdSet.size && currentKeys.every(k => activeTabIdSet.has(k))) {
          return currentTabs;
        }
        const newTabs: { [key: string]: TabData } = {};
        for (const tabId of activeTabIdSet) {
          if (currentTabs[tabId]) {
            newTabs[tabId] = currentTabs[tabId];
          }
        }
        return newTabs;
      });

      if (onTabsChanged) {
        onTabsChanged(allTabIds);
      }
    },
    [LAYOUT_STORAGE_KEY, onTabsChanged]
  );

  return {
    layout,
    tabContents,
    loadTab,
    addTab,
    addTypedTab,
    resetLayout,
    toggleTab,
    showTab,
    onLayoutChange,
  };
}
