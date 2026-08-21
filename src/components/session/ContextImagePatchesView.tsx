import { useSessionContext } from '@/contexts/SessionContext';
import { ImagePatchesView } from '@/components/ImagePatchesView';
import { useImagePatches } from '@/hooks/useImagePatches';

export function ContextImagePatchesView() {
  const sessionData = useSessionContext();

  // The scan runs over OOB when the session isn't paused, so it needs a process
  // — not a pause. displayStatus is debounced, so rapid stepping doesn't
  // trigger a scan per step.
  const isPaused = sessionData.displayStatus === 'Paused';
  const { patches, capped, scanning, scanned, scan } = useImagePatches(
    sessionData.session?.id,
    sessionData.canUseMemoryOps,
    isPaused,
  );

  return (
    <ImagePatchesView
      patches={patches}
      capped={capped}
      scanning={scanning}
      scanned={scanned}
      canScan={sessionData.canUseMemoryOps}
      onScan={scan}
      onRestore={sessionData.patchState.restoreImageBytes}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
}
