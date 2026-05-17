import { useSessionContext } from '@/contexts/SessionContext';
import { PatchesView } from '@/components/PatchesView';

export function ContextPatchesView() {
  const sessionData = useSessionContext();

  const {
    patches,
    undoPatch,
    undoPatches,
    enablePatch,
    updatePatch,
    enablePatchGroup,
  } = sessionData.patchState;

  return (
    <PatchesView
      patches={patches}
      onUndoPatch={undoPatch}
      onUndoPatches={undoPatches}
      onEnablePatch={enablePatch}
      onUpdatePatch={updatePatch}
      onEnablePatchGroup={enablePatchGroup}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
}
