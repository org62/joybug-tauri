import { useCallback, useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { appNavHistory } from '@/lib/navHistory';
import type { DockingLayoutRef } from '@/components/DockingLayout';

/** Wire a dock host (SessionDocked / PeReader) to the app-wide navigation
 *  history: registers the dock controller and returns the `onTabSwitch`
 *  callback to pass to DockingLayout. `scope` identifies the host's content
 *  (session id / PE file path); tab/address history is only restored into
 *  the scope it was recorded in. */
export function useNavHistoryDock(
  dockingRef: RefObject<DockingLayoutRef | null>,
  opts: { disasmTabId: string; scope: string | undefined },
): { onTabSwitch: (fromTabId: string) => void } {
  const { disasmTabId, scope } = opts;

  // The store restores dock tabs through this controller; recordHistory: false
  // keeps the restoration itself from being re-recorded as a new switch.
  // Layout effect, not passive: on unmount the cleanup snapshots the host's
  // active tab for the route-departure record, and React runs a parent's
  // layout-effect cleanup before it detaches the child's imperative ref —
  // by the passive phase `dockingRef.current` is already null.
  useLayoutEffect(() => {
    return appNavHistory.setController({
      disasmTabId,
      scope,
      restoreTab: (tabId) => dockingRef.current?.showTab(tabId, { recordHistory: false }),
      activeTabOf: (tabId) => dockingRef.current?.activeTabOf(tabId) ?? null,
    });
  }, [dockingRef, disasmTabId, scope]);

  // A user tab switch is a navigation action: record the departed location.
  const onTabSwitch = useCallback(
    (fromTabId: string) => appNavHistory.recordDeparture(fromTabId),
    [],
  );

  return { onTabSwitch };
}
