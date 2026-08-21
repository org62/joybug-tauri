import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * A route's claim on the window-global file drop. While a claim is registered
 * and enabled, FileDropProvider hands drops to it instead of running the
 * Debug/PE-Viewer chooser.
 *
 * The object is mutated in place by useFileDropTarget (never replaced), so the
 * provider always reads the current handler without re-subscribing.
 */
export interface FileDropClaim {
  /** Overlay text shown while a file is dragged over the window. */
  message: string;
  /** False while a modal is open: the drop is ignored, not passed to the chooser. */
  enabled: boolean;
  onDrop: (paths: string[]) => void;
}

export interface FileDropContextValue {
  /** Register a claim; returns the unregister function. */
  claim: (claim: FileDropClaim) => () => void;
}

export const FileDropContext = createContext<FileDropContextValue | null>(null);

export interface UseFileDropTargetOptions {
  message: string;
  onDrop: (paths: string[]) => void;
  /** Default true. Pass false while modal dialogs are open so a drop can't fire underneath them. */
  enabled?: boolean;
}

/**
 * Claim the window-global file drop for as long as this component is mounted.
 * `onDrop` identity churn never re-registers (the claim object is stable and
 * mutated in place); `enabled` re-registers so the provider re-renders and the
 * drop overlay hides while a dialog is open.
 */
export function useFileDropTarget({ message, onDrop, enabled = true }: UseFileDropTargetOptions): void {
  const ctx = useContext(FileDropContext);
  const claimRef = useRef<FileDropClaim>({ message, enabled, onDrop });
  Object.assign(claimRef.current, { message, enabled, onDrop });

  const claim = ctx?.claim;
  useEffect(() => {
    if (!claim) return;
    return claim(claimRef.current);
  }, [claim, enabled, message]);
}
