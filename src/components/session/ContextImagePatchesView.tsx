import { useSessionContext } from '@/contexts/SessionContext';
import { ImagePatchesView } from '@/components/ImagePatchesView';
import { useImagePatches } from '@/hooks/useImagePatches';

export function ContextImagePatchesView() {
  const sessionData = useSessionContext();

  // displayStatus is debounced, so rapid stepping doesn't trigger a scan per step.
  const isPaused = sessionData.displayStatus === 'Paused';
  const { patches, capped, scanning, scanned, scan } = useImagePatches(
    sessionData.session?.id,
    isPaused,
  );

  return (
    <ImagePatchesView
      patches={patches}
      capped={capped}
      scanning={scanning}
      scanned={scanned}
      canScan={isPaused}
      onScan={scan}
      onRestore={sessionData.patchState.restoreImageBytes}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
}
