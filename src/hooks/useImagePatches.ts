import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** One contiguous run of in-memory code differing from the on-disk image. */
export interface ImagePatch {
  address: string;            // hex string "0x..."
  module: string;             // module short name (e.g. "ntdll.dll")
  rva: string;                // hex string "0x..."
  symbol: string | null;      // "module!name+0xoff"
  original_bytes: string;     // space-separated hex
  current_bytes: string;      // space-separated hex
  original_disasm: string;
  current_disasm: string;
  tracked: boolean;           // overlaps a tracked user patch
}

interface ImagePatchesPayload {
  session_id: string;
  patches: ImagePatch[];
  capped: boolean;
}

/**
 * Backing state for the Image Patches window. Scans on demand (and re-scans
 * when the session pauses or the patch set changes) — the hook lives in the
 * view's context wrapper so no scanning happens while the tab is closed.
 */
export function useImagePatches(sessionId?: string, isPaused?: boolean) {
  const [patches, setPatches] = useState<ImagePatch[]>([]);
  const [capped, setCapped] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);

  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  // Session cleanup: results describe a live process, so drop everything when
  // the session goes away. Kept across resumes — stale-but-labeled beats blank.
  useEffect(() => {
    if (!sessionId) {
      setPatches([]);
      setCapped(false);
      setScanning(false);
      setScanned(false);
    }
  }, [sessionId]);

  const scan = useCallback(async () => {
    if (!sessionId) return;
    setScanning(true);
    try {
      await invoke('scan_image_patches', { sessionId });
    } catch (e) {
      // Not paused (stepping raced the scan) — keep whatever we last showed.
      console.error('Failed to request image patch scan:', e);
      setScanning(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    const unlistenUpdated = listen<ImagePatchesPayload>('image-patches-updated', (event) => {
      if (event.payload.session_id === sessionId) {
        setPatches(event.payload.patches);
        setCapped(event.payload.capped);
        setScanning(false);
        setScanned(true);
      }
    });

    // Patch changes and image-byte restores emit patches-updated; the scan
    // result is stale the moment that fires.
    const unlistenPatches = listen<{ session_id: string }>('patches-updated', (event) => {
      if (event.payload.session_id === sessionId && isPausedRef.current) {
        scan();
      }
    });

    return () => {
      unlistenUpdated.then(f => f());
      unlistenPatches.then(f => f());
    };
  }, [sessionId, scan]);

  // Auto-scan on pause (debounced upstream via displayStatus, so rapid
  // stepping doesn't fire a scan per step).
  useEffect(() => {
    if (sessionId && isPaused) {
      scan();
    }
  }, [sessionId, isPaused, scan]);

  return useMemo(() => ({
    patches,
    capped,
    scanning,
    scanned,
    scan,
  }), [patches, capped, scanning, scanned, scan]);
}
