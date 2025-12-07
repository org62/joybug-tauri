import React from "react";
import DockLayout from "rc-dock";
import { useTheme } from "next-themes";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDocking, DockingConfig } from "@/hooks/useDocking";

export interface DockingLayoutProps extends DockingConfig {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onAddTab?: () => void;
  onResetLayout?: () => void;
  onToggleTab?: (tabId: string) => void;
  onTabsChanged?: (activeTabIds: string[]) => void;
}

export interface DockingLayoutRef {
  addTab: () => void;
  addTypedTab: (type: string, contentFactory: (tabId: string) => React.ReactElement) => string;
  resetLayout: () => void;
  toggleTab: (tabId: string) => void;
  getActiveTabs: () => string[];
}

const DockingLayoutComponent = React.forwardRef<DockingLayoutRef, DockingLayoutProps>(
  ({ children, className, style, onAddTab, onResetLayout, onToggleTab, onTabsChanged, ...config }, ref) => {
    const { resolvedTheme } = useTheme();
    const docking = useDocking({ ...config, onTabsChanged });

    // Expose operations through ref
    React.useImperativeHandle(ref, () => ({
      addTab: docking.addTab,
      addTypedTab: docking.addTypedTab,
      resetLayout: docking.resetLayout,
      toggleTab: docking.toggleTab,
      getActiveTabs: () => {
        const activeTabIds: string[] = [];
        const findTabIds = (box: any) => {
          if (box.tabs) {
            box.tabs.forEach((tab: any) => {
              if (tab.id) {
                activeTabIds.push(tab.id);
              }
            });
          }
          if (box.children) {
            box.children.forEach(findTabIds);
          }
        };
        findTabIds(docking.layout.dockbox);
        return activeTabIds;
      },
    }));

    // Handle external event callbacks
    React.useEffect(() => {
      if (onAddTab) {
        // Store the reference for potential cleanup
      }
    }, [onAddTab]);

    React.useEffect(() => {
      if (onResetLayout) {
        // Store the reference for potential cleanup
      }
    }, [onResetLayout]);

    React.useEffect(() => {
      if (onToggleTab) {
        // Store the reference for potential cleanup
      }
    }, [onToggleTab]);

    const enhancedLoadTab = React.useCallback(
      (tab: any) => {
        const loadedTab = docking.loadTab(tab);
        
        if (loadedTab.content) {
          const originalContent = 
            typeof loadedTab.content === "function" 
              ? (loadedTab.content as any)(loadedTab) 
              : loadedTab.content;
          
          loadedTab.content = (
            <div className="absolute inset-0">
              <ScrollArea className="h-full w-full">{originalContent}</ScrollArea>
            </div>
          );
        }

        return loadedTab;
      },
      [docking.loadTab]
    );

    return (
      <div className={className} style={style}>
        {children}
        <DockLayout
          key={resolvedTheme}
          layout={docking.layout}
          loadTab={enhancedLoadTab}
          onLayoutChange={docking.onLayoutChange}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
          }}
        />
      </div>
    );
  }
);

DockingLayoutComponent.displayName = "DockingLayout";

export default DockingLayoutComponent; 