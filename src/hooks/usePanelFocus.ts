import React from "react";
import { panelFocus } from "@/lib/navigationStore";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";

/**
 * Focus a view's primary input when the user navigates to its tab ("Go to X" in
 * the command palette, or the panel's keyboard chord). Opt in from a view with:
 *
 *     const focusRef = usePanelFocus<HTMLInputElement>("symbols");
 *     <Input ref={focusRef} … />
 *
 * Pass `undefined` for hosts where the view isn't a dock tab (e.g. the PE
 * reader's symbol search) and the hook does nothing.
 *
 * Views share one channel, hence the tab-id match: goToTab requests focus for
 * every navigation, and only the view registered under that id claims it — a
 * request for a tab with no registered input just stays pending until the next
 * navigation overwrites it.
 */
export function usePanelFocus<T extends HTMLElement>(tabId?: string): React.RefObject<T> {
  const ref = React.useRef<T>(null);

  useNavigationChannel(
    panelFocus,
    () => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (el instanceof HTMLInputElement) el.select();
    },
    (id) => id === tabId,
  );

  return ref;
}
