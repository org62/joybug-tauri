import { useEffect, useRef } from 'react';

/**
 * The cadence shared by the heavy "take a snapshot of the target" views
 * (image patches, process objects): re-snapshot on every pause, plus once when
 * the target first becomes reachable.
 *
 * The pause edge is the *debounced* `isPaused` (`displayStatus`), deliberately —
 * these snapshots are far too expensive for the raw `session-updated` stream
 * `useLiveRefresh` listens to, which fires on every step. The first-reachable
 * shot exists because a Running or non-invasive `Open` session never pauses and
 * so offers no edge to hang the snapshot on; the ref keeps a resume from
 * looking like that first time and firing a second one.
 *
 * `take` is held in a ref, so callback identity churn never re-arms the effect.
 */
export function useSnapshotOnPause(
  sessionId: string | undefined,
  canSnapshot: boolean | undefined,
  isPaused: boolean | undefined,
  take: () => void,
) {
  const takeRef = useRef(take);
  takeRef.current = take;

  const snapshotted = useRef(false);
  useEffect(() => {
    if (!sessionId || !canSnapshot) {
      snapshotted.current = false;
      return;
    }
    const first = !snapshotted.current;
    snapshotted.current = true;
    if (isPaused || first) takeRef.current();
  }, [sessionId, canSnapshot, isPaused]);
}
