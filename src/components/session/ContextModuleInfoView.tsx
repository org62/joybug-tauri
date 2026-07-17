import { useState, useEffect, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useModuleInfo } from '@/hooks/useModuleInfo';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { peviewerModuleNavigation } from '@/lib/navigationStore';
import { ModuleInfoView } from '@/components/ModuleInfoView';

const STORAGE_KEY = 'peviewer-selected-module';

export const ContextModuleInfoView: React.FC<{
  initialModuleBase?: string;
}> = ({ initialModuleBase }) => {
  const { session, canUseMemoryOps, modules, onNavigateToDisassembly, onNavigateToMemory } = useSessionContext();
  const sessionId = session?.id;
  const isActive = canUseMemoryOps;

  const [selectedModuleBase, setSelectedModuleBase] = useState<string | null>(() => {
    // Restore from sessionStorage on mount (survives rc-dock tab moves)
    return initialModuleBase ?? sessionStorage.getItem(STORAGE_KEY);
  });

  const { info, isLoading, error } = useModuleInfo(sessionId, selectedModuleBase, isActive);

  // Persist selection to sessionStorage so it survives tab moves
  const handleModuleSelect = useCallback((base: string) => {
    setSelectedModuleBase(base);
    sessionStorage.setItem(STORAGE_KEY, base);
  }, []);

  // External module selection (modules list click) — consumed on mount too, so
  // a selection made while this tab was closed lands once the tab opens.
  useNavigationChannel(peviewerModuleNavigation, handleModuleSelect);

  // Clear selection when session ends
  useEffect(() => {
    if (!sessionId) {
      setSelectedModuleBase(null);
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, [sessionId]);

  return (
    <ModuleInfoView
      modules={modules}
      selectedModuleBase={selectedModuleBase}
      onModuleSelect={handleModuleSelect}
      info={info}
      isLoading={isLoading}
      error={error}
      onNavigateToDisassembly={onNavigateToDisassembly}
      onNavigateToMemory={onNavigateToMemory}
    />
  );
};
