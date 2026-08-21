import { ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileDropContext, FileDropClaim } from "@/contexts/FileDropContext";
import {
  useFileDrop,
  pickDroppedFile,
  PE_FILE_PATTERN,
  PE_FILE_REJECT_MESSAGE,
} from "@/hooks/useFileDrop";
import { FileDropOverlay } from "@/components/FileDropOverlay";
import { FileDropChoiceDialog } from "@/components/FileDropChoiceDialog";
import { launchExecutable } from "@/lib/launchFile";
import { formatTauriError } from "@/lib/sessionHelpers";
import { toastError } from "@/lib/logger";

const DEFAULT_MESSAGE = "Drop a PE file to debug or inspect";

/**
 * The app's single consumer of Tauri's window-global file drop.
 *
 * A route that wants the drop for itself registers a claim (useFileDropTarget)
 * and keeps its existing behaviour. Anywhere else — Home, Logs, Settings,
 * About, the session view — the drop still lands: an .exe offers a choice
 * between debugging and inspecting it, any other PE goes to the PE Viewer
 * (nothing to choose: it can't be launched).
 *
 * Must be rendered inside the Router: the fallback navigates.
 */
export function FileDropProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // Ref for drop-time reads (always current), state for render (overlay text).
  const claimsRef = useRef<FileDropClaim[]>([]);
  const [claims, setClaims] = useState<FileDropClaim[]>([]);
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);

  const claim = useCallback((entry: FileDropClaim) => {
    claimsRef.current = [...claimsRef.current.filter((c) => c !== entry), entry];
    setClaims(claimsRef.current);
    return () => {
      claimsRef.current = claimsRef.current.filter((c) => c !== entry);
      setClaims(claimsRef.current);
    };
  }, []);

  const openInPeViewer = useCallback((path: string) => {
    navigate(`/pe?path=${encodeURIComponent(path)}`);
  }, [navigate]);

  const debugFile = useCallback(async (path: string) => {
    try {
      navigate(`/session/${await launchExecutable(path)}`);
    } catch (error) {
      console.error("Failed to launch dropped executable:", error);
      toastError(formatTauriError(error));
    }
  }, [navigate]);

  const handleDrop = useCallback((paths: string[]) => {
    // The route on top owns the drop; a disabled claim (its own modal is open)
    // swallows it rather than falling through to a second dialog.
    const active = claimsRef.current[claimsRef.current.length - 1];
    if (active) {
      if (active.enabled) active.onDrop(paths);
      return;
    }

    const dropped = pickDroppedFile(paths, {
      pattern: PE_FILE_PATTERN,
      rejectMessage: PE_FILE_REJECT_MESSAGE,
    });
    if (!dropped) return;

    if (/\.exe$/i.test(dropped)) setPendingChoice(dropped);
    else openInPeViewer(dropped);
  }, [openInPeViewer]);

  const { isDragOver } = useFileDrop({ onDrop: handleDrop, enabled: pendingChoice === null });

  const active = claims[claims.length - 1];
  const value = useMemo(() => ({ claim }), [claim]);

  return (
    <FileDropContext.Provider value={value}>
      {children}
      <FileDropOverlay
        active={isDragOver && (active?.enabled ?? true)}
        message={active?.message ?? DEFAULT_MESSAGE}
      />
      <FileDropChoiceDialog
        path={pendingChoice}
        onClose={() => setPendingChoice(null)}
        onDebug={() => {
          const path = pendingChoice;
          setPendingChoice(null);
          if (path) debugFile(path);
        }}
        onInspect={() => {
          const path = pendingChoice;
          setPendingChoice(null);
          if (path) openInPeViewer(path);
        }}
      />
    </FileDropContext.Provider>
  );
}
