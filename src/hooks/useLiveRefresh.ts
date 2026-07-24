import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

export type RefreshReason = 'interval' | 'pause';

/**
 * Shared live-refresh cadence for views that display target memory/values:
 * - fires `onRefresh('interval')` every `intervalMs` while the target is live
 *   (caller passes `isTargetLive(status)` — Running or non-invasive Open),
 * - fires `onRefresh('pause')` once on a non-Paused → Paused transition
 *   (step/breakpoint), so a step refreshes and highlights what changed.
 *
 * `onRefresh` is kept in a ref: callback identity churn never re-arms the
 * interval or the listener.
 */
export function useLiveRefresh(
  sessionId: string | undefined,
  isLive: boolean,
  onRefresh: (reason: RefreshReason) => void,
  intervalMs = 500,
) {
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    if (!sessionId || !isLive) return;
    const interval = setInterval(() => cbRef.current('interval'), intervalMs);
    return () => clearInterval(interval);
  }, [sessionId, isLive, intervalMs]);

  // Listens for session-updated directly (bypasses React batching which can
  // swallow the Running→Paused transition during fast steps, making
  // status-based effects miss it).
  useEffect(() => {
    if (!sessionId) return;

    let prevStatus: string | null = null;

    const setupListener = async () => {
      return listen<{ id: string; status: string }>('session-updated', (event) => {
        if (event.payload.id !== sessionId) return;
        const newStatus = event.payload.status;
        const wasNonPaused = prevStatus !== null && prevStatus !== 'Paused';
        prevStatus = newStatus;
        if (newStatus === 'Paused' && wasNonPaused) {
          cbRef.current('pause');
        }
      });
    };

    const cleanup = setupListener();
    return () => { cleanup.then(fn => fn?.()); };
  }, [sessionId]);
}
