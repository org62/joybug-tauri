import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RawPatch } from '@/contexts/SessionContext';
import { toastError } from '@/lib/logger';
import { reportSessionError } from '@/lib/sessionHelpers';

export type { RawPatch } from '@/contexts/SessionContext';

export interface Patch {
  id: string;
  address: string;           // hex string "0x..."
  module_name: string;
  module_offset: string;      // hex string "0x..."
  original_bytes: number[];
  patched_bytes: number[];
  assembly_text: string;
  original_disassembly: string;
  enabled: boolean;
  is_applied: boolean;
  group: string | null;
}

interface PatchesUpdatedPayload {
  session_id: string;
  patches: RawPatch[];
  /// Bumped by the backend only on view-affecting changes; the every-pause
  /// re-broadcast keeps it stable (used by useAssemblyView to skip re-decodes).
  revision: number;
}

interface AssemblePatchErrorPayload {
  session_id: string;
  error: string;
}

function convertPatches(raw: RawPatch[]): Patch[] {
  return raw.map(p => ({
    id: p.id,
    address: `0x${p.address.toString(16).toUpperCase()}`,
    module_name: p.module_name,
    module_offset: `0x${p.module_offset.toString(16).toUpperCase()}`,
    original_bytes: p.original_bytes,
    patched_bytes: p.patched_bytes,
    assembly_text: p.assembly_text,
    original_disassembly: p.original_disassembly,
    enabled: p.enabled,
    is_applied: p.is_applied,
    group: p.group,
  }));
}

export function usePatches(sessionId?: string, canUseMemoryOps?: boolean, sessionPatches?: RawPatch[]) {
  const [patches, setPatches] = useState<Patch[]>([]);

  const sessionPatchRef = useRef(sessionPatches);
  sessionPatchRef.current = sessionPatches;

  // Seed from the session payload when the session appears and re-seed when a
  // process appears/disappears. Persisted patches stay visible (and
  // metadata-editable) while Stopped; only the session going away clears them.
  useEffect(() => {
    if (!sessionId) {
      setPatches([]);
    } else if (sessionPatchRef.current && sessionPatchRef.current.length > 0) {
      setPatches(convertPatches(sessionPatchRef.current));
    }
  }, [sessionId, canUseMemoryOps]);

  // Listen for patches-updated events
  useEffect(() => {
    if (!sessionId) return;

    const unlistenUpdated = listen<PatchesUpdatedPayload>('patches-updated', (event) => {
      if (event.payload.session_id === sessionId) {
        setPatches(convertPatches(event.payload.patches));
      }
    });

    const unlistenError = listen<AssemblePatchErrorPayload>('assemble-patch-error', (event) => {
      if (event.payload.session_id === sessionId) {
        toastError(event.payload.error, sessionId);
      }
    });

    return () => {
      unlistenUpdated.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionId]);

  const assemblePatch = useCallback(async (address: string, assemblyText: string, nopPad?: boolean): Promise<string | null> => {
    if (!sessionId) return null;
    try {
      await invoke('assemble_patch', { sessionId, address, assemblyText, nopPad: nopPad ?? false });
      return null;
    } catch (e: unknown) {
      // Extract the error message for inline display
      if (typeof e === 'string') return e;
      if (typeof e === 'object' && e !== null) {
        const values = Object.values(e as Record<string, unknown>);
        if (values.length > 0 && typeof values[0] === 'string') return values[0];
      }
      return 'Assembly failed';
    }
  }, [sessionId]);

  const undoPatch = useCallback(async (patchId: string) => {
    if (!sessionId) return;
    try {
      await invoke('undo_patch', { sessionId, patchId });
    } catch (e) {
      reportSessionError('undo patch', e, sessionId);
    }
  }, [sessionId]);

  const undoPatches = useCallback(async (patchIds: string[]) => {
    if (!sessionId) return;
    try {
      await invoke('undo_patches', { sessionId, patchIds });
    } catch (e) {
      reportSessionError('undo patches', e, sessionId);
    }
  }, [sessionId]);

  const enablePatch = useCallback(async (patchId: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_patch', { sessionId, patchId, enabled });
    } catch (e) {
      reportSessionError('enable/disable patch', e, sessionId);
    }
  }, [sessionId]);

  const updatePatch = useCallback(async (patchId: string, group?: string) => {
    if (!sessionId) return;
    try {
      await invoke('update_patch', { sessionId, patchId, group: group ?? null });
    } catch (e) {
      reportSessionError('update patch', e, sessionId);
    }
  }, [sessionId]);

  const enablePatchGroup = useCallback(async (group: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_patch_group', { sessionId, group, enabled });
    } catch (e) {
      reportSessionError('enable/disable patch group', e, sessionId);
    }
  }, [sessionId]);

  // Restore the original bytes at a patched address. The backend undoes a
  // tracked UI patch when one covers the address, else raw-restores from the
  // on-disk image (external hook, self-modifying code). It emits
  // patches-updated, which refreshes the assembly view.
  const restoreImageBytes = useCallback(async (address: string) => {
    if (!sessionId) return;
    try {
      await invoke('restore_image_bytes', { sessionId, address });
    } catch (e) {
      reportSessionError('restore image bytes', e, sessionId);
    }
  }, [sessionId]);

  return useMemo(() => ({
    patches,
    assemblePatch,
    undoPatch,
    undoPatches,
    enablePatch,
    updatePatch,
    enablePatchGroup,
    restoreImageBytes,
  }), [patches, assemblePatch, undoPatch, undoPatches, enablePatch, updatePatch, enablePatchGroup, restoreImageBytes]);
}

export type PatchState = ReturnType<typeof usePatches>;
