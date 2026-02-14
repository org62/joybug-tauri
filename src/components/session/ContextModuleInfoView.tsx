import { useState, useEffect, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useModuleInfo } from '@/hooks/useModuleInfo';
import { ModuleInfoView } from '@/components/ModuleInfoView';

const SELECT_MODULE_EVENT = 'select-peviewer-module';
const STORAGE_KEY = 'peviewer-selected-module';

export const ContextModuleInfoView: React.FC<{
  initialModuleBase?: string;
}> = ({ initialModuleBase }) => {
  const { session, displayStatus, modules, onNavigateToDisassembly, onNavigateToMemory } = useSessionContext();
  const sessionId = session?.id;
  const isPaused = displayStatus === 'Paused';

  const [selectedModuleBase, setSelectedModuleBase] = useState<string | null>(() => {
    // Restore from sessionStorage on mount (survives rc-dock tab moves)
    return initialModuleBase ?? sessionStorage.getItem(STORAGE_KEY);
  });

  const { info, isLoading, error } = useModuleInfo(sessionId, selectedModuleBase, isPaused);

  // Persist selection to sessionStorage so it survives tab moves
  const handleModuleSelect = useCallback((base: string) => {
    setSelectedModuleBase(base);
    sessionStorage.setItem(STORAGE_KEY, base);
  }, []);

  // Listen for external module selection events (from modules list click)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        handleModuleSelect(detail);
      }
    };
    window.addEventListener(SELECT_MODULE_EVENT, handler);
    return () => window.removeEventListener(SELECT_MODULE_EVENT, handler);
  }, [handleModuleSelect]);

  // Clear selection when session ends
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setSelectedModuleBase(null);
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, [sessionId, isPaused]);

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
