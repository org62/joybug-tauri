import { useSessionContext } from '@/contexts/SessionContext';
import { ProcessHandlesView } from '@/components/ProcessHandlesView';
import { useProcessObjects } from '@/hooks/useProcessObjects';

export function ContextProcessHandlesView() {
  const sessionData = useSessionContext();

  // Enumeration runs over OOB, so it needs a process, not a pause. The hook
  // re-snapshots on every pause (displayStatus is debounced, so rapid stepping
  // doesn't enumerate per step).
  const { objects, loading, refresh, closeHandle, setPrivilege, setWindowEnabled } = useProcessObjects(
    sessionData.session?.id,
    sessionData.canUseMemoryOps,
    sessionData.isPaused,
  );

  return (
    <ProcessHandlesView
      objects={objects}
      loading={loading}
      canRefresh={sessionData.canUseMemoryOps}
      hasSession={!!sessionData.session?.id}
      onRefresh={refresh}
      onCloseHandle={closeHandle}
      onSetPrivilege={setPrivilege}
      onSetWindowEnabled={setWindowEnabled}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
    />
  );
}
