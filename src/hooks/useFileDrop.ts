import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { toastError, toastInfo } from '@/lib/logger';

/**
 * Reduce a native drop to the single path a consumer accepts: takes the first
 * dropped file (toasting when extras are ignored), rejects paths that don't
 * match `pattern` with `rejectMessage`, and returns the accepted path or null.
 */
export function pickDroppedFile(
  paths: string[],
  accept: { pattern: RegExp; rejectMessage: string },
): string | null {
  const dropped = paths[0];
  if (!dropped) return null;
  if (paths.length > 1) toastInfo('Multiple files dropped; using the first');
  if (!accept.pattern.test(dropped)) {
    toastError(accept.rejectMessage);
    return null;
  }
  return dropped;
}

export interface UseFileDropOptions {
  /** Called with the absolute filesystem paths of the dropped files. */
  onDrop: (paths: string[]) => void;
  /** Default true. Pass false while modal dialogs are open so a drop can't fire underneath them. */
  enabled?: boolean;
}

/**
 * Subscribes to Tauri's native window drag-drop (which delivers real file
 * paths and suppresses HTML5 drops). The event is window-global — one
 * consumer per route; our consumers live on different routes so they never
 * coexist.
 *
 * `onDrop` is kept in a ref: callback identity churn never re-subscribes.
 */
export function useFileDrop({ onDrop, enabled = true }: UseFileDropOptions): { isDragOver: boolean } {
  const [isDragOver, setIsDragOver] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    if (!enabled) {
      setIsDragOver(false);
      return;
    }

    let disposed = false;
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (disposed) return;
      switch (event.payload.type) {
        case 'enter':
          setIsDragOver(true);
          break;
        case 'leave':
          setIsDragOver(false);
          break;
        case 'drop':
          setIsDragOver(false);
          onDropRef.current(event.payload.paths);
          break;
      }
    });

    // Test seam: native OS drops can't be synthesized over CDP, so e2e tests
    // dispatch this CustomEvent to exercise the drop-handling path.
    const onTestDrop = (e: Event) => {
      const paths = (e as CustomEvent<{ paths: string[] }>).detail?.paths;
      if (paths?.length) onDropRef.current(paths);
    };
    window.addEventListener('joybug:test-file-drop', onTestDrop);

    return () => {
      disposed = true;
      unlistenPromise.then((fn) => fn());
      window.removeEventListener('joybug:test-file-drop', onTestDrop);
    };
  }, [enabled]);

  return { isDragOver };
}
