import { useEffect } from 'react';

/** The slice of a @tanstack/react-virtual Virtualizer ref the hook needs. */
interface VirtualizerRefLike {
  readonly current: { readonly scrollElement: HTMLElement | null } | null;
}

/** Run `apply` now and again over the next frames — a freshly replaced or
 * just-revealed virtualized list isn't measured yet on the first call. */
export function applyOverFrames(apply: () => void): void {
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 40);
}

/**
 * rc-dock keeps hidden tabs mounted at zero height, so a centering scroll that
 * lands while the tab is hidden runs against a 0-height viewport and is
 * silently lost. Re-apply the last centering target the moment the panel
 * becomes visible again (viewport height 0 → positive).
 *
 * The view's center function must record its target in `targetRef` and bail
 * while the viewport height is 0 (see AssemblyView.scrollToInstruction /
 * SourceView.centerOn).
 *
 * @param virtualizerRef source of the scroll element (may mount late)
 * @param enabled        false while the view has no rows (nothing to center)
 * @param targetRef      last requested centering target; null when none
 * @param centerOn       centers a target; called on reveal
 */
export function useRecenterOnReveal<T>(
  virtualizerRef: VirtualizerRefLike,
  enabled: boolean,
  targetRef: React.MutableRefObject<T | null>,
  centerOn: (target: T) => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const attach = () => {
      const el = virtualizerRef.current?.scrollElement;
      if (!el) {
        raf = requestAnimationFrame(attach);
        return;
      }
      let prevHeight = el.clientHeight;
      ro = new ResizeObserver(() => {
        const h = el.clientHeight;
        const becameVisible = prevHeight === 0 && h > 0;
        prevHeight = h;
        if (becameVisible && targetRef.current != null) {
          centerOn(targetRef.current);
        }
      });
      ro.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
    // virtualizerRef/targetRef are stable ref containers.
  }, [enabled, centerOn]);
}
