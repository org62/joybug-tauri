import { useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { NavHistoryStore } from '@/lib/navHistory';
import type { DockingLayoutRef } from '@/components/DockingLayout';
import { setMouseNavHandler } from '@/lib/mouseNav';

/** Wire a NavHistoryStore to its dock host (SessionDocked / PeReader):
 *  registers the tab controller and the mouse back/forward handler, and
 *  returns the `onTabSwitch` callback to pass to DockingLayout. */
export function useNavHistoryDock(
  navHistory: NavHistoryStore,
  dockingRef: RefObject<DockingLayoutRef | null>,
): { onTabSwitch: (fromTabId: string) => void } {
  // The store restores dock tabs through this controller; recordHistory: false
  // keeps the restoration itself from being re-recorded as a new switch.
  useEffect(() => {
    return navHistory.setController({
      restoreTab: (tabId) => dockingRef.current?.showTab(tabId, { recordHistory: false }),
      activeTabOf: (tabId) => dockingRef.current?.activeTabOf(tabId) ?? null,
    });
  }, [navHistory, dockingRef]);

  // Mouse back/forward buttons walk the unified history. Always consumed
  // while the dock host is open: an exhausted history must be a no-op, not
  // a fall-through to native page navigation that yanks the user out of the
  // view. Unregisters on unmount, so mouse back/forward on real pages
  // (e.g. /logs) still navigates the router normally.
  useEffect(() => {
    return setMouseNavHandler((dir) => {
      if (dir === 'back') navHistory.goBack();
      else navHistory.goForward();
      return true;
    });
  }, [navHistory]);

  // A user tab switch is a navigation action: record the departed location.
  const onTabSwitch = useCallback(
    (fromTabId: string) => navHistory.recordDeparture(fromTabId),
    [navHistory],
  );

  return { onTabSwitch };
}
