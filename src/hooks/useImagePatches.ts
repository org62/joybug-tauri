import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSnapshotOnPause } from '@/hooks/useSnapshotOnPause';

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
 *
 * `canScan` is "a process is reachable", not "paused": the backend runs the
 * scan over the out-of-band connection when the session isn't paused, so a
 * running target — or a non-invasive `Open` one that was never attached — scans
 * just the same.
 */
export function useImagePatches(sessionId?: string, canScan?: boolean, isPaused?: boolean) {
  const [patches, setPatches] = useState<ImagePatch[]>([]);
  const [capped, setCapped] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);

  const canScanRef = useRef(canScan);
  canScanRef.current = canScan;

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

  // Resolves once this hook's event listeners are attached. The result comes
  // back as an event, so a scan requested before then is emitted into the void
  // and the view sits on "Scanning..." forever. That's reachable now that the
  // first scan fires on mount: with the module images already cached from an
  // earlier scan, the backend can answer in well under the listener's own IPC
  // round-trip.
  const listenersReady = useRef<Promise<unknown> | null>(null);

  const scan = useCallback(async () => {
    if (!sessionId) return;
    setScanning(true);
    try {
      await listenersReady.current;
      await invoke('scan_image_patches', { sessionId });
    } catch (e) {
      // Target gone (the session stopped mid-scan) — keep what we last showed.
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
      if (event.payload.session_id === sessionId && canScanRef.current) {
        scan();
      }
    });

    listenersReady.current = Promise.all([unlistenUpdated, unlistenPatches]);

    return () => {
      listenersReady.current = null;
      unlistenUpdated.then(f => f());
      unlistenPatches.then(f => f());
    };
  }, [sessionId, scan]);

  // Auto-scan on every (debounced) pause, and once when the target first
  // becomes reachable.
  useSnapshotOnPause(sessionId, canScan, isPaused, scan);

  return useMemo(() => ({
    patches,
    capped,
    scanning,
    scanned,
    scan,
  }), [patches, capped, scanning, scanned, scan]);
}
