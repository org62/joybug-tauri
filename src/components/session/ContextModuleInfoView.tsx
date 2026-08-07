import { useState, useEffect, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useModuleInfo } from '@/hooks/useModuleInfo';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { peviewerModuleNavigation } from '@/lib/navigationStore';
import { ModuleInfoView } from '@/components/ModuleInfoView';

const STORAGE_KEY = 'peviewer-selected-module';

/** Persisted selection: base for direct restore across rc-dock tab moves,
 *  name to remap the selection across an ASLR relocation (session restart). */
interface StoredSelection {
  base: string;
  name?: string;
}

function readStoredSelection(): StoredSelection | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const ContextModuleInfoView: React.FC<{
  initialModuleBase?: string;
}> = ({ initialModuleBase }) => {
  const { session, canUseMemoryOps, modules, onNavigateToDisassembly, onNavigateToMemory } = useSessionContext();
  const sessionId = session?.id;
  const isActive = canUseMemoryOps;

  const [selectedModuleBase, setSelectedModuleBase] = useState<string | null>(() => {
    // Restore from sessionStorage on mount (survives rc-dock tab moves)
    return initialModuleBase ?? readStoredSelection()?.base ?? null;
  });

  const { info, isLoading, error } = useModuleInfo(sessionId, selectedModuleBase, isActive);

  // Persist selection to sessionStorage so it survives tab moves (the sync
  // effect below fills in the module name once the base resolves)
  const handleModuleSelect = useCallback((base: string) => {
    setSelectedModuleBase(base);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ base } satisfies StoredSelection));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedModuleBase(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  // External module selection (modules list click) — consumed on mount too, so
  // a selection made while this tab was closed lands once the tab opens.
  useNavigationChannel(peviewerModuleNavigation, handleModuleSelect);

  // Clear selection when session ends
  useEffect(() => {
    if (!sessionId) clearSelection();
  }, [sessionId, clearSelection]);

  // A restart keeps the session id but relocates modules (ASLR), so a selected
  // base can go stale. While the base resolves, record the module's name next
  // to it; once a new module list arrives without the base, remap the selection
  // to the same-named module, or drop it if that module is gone.
  useEffect(() => {
    if (!selectedModuleBase || modules.length === 0) return;
    const current = modules.find((m) => m.base_address === selectedModuleBase);
    if (current) {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ base: current.base_address, name: current.name } satisfies StoredSelection),
      );
      return;
    }
    const lastName = readStoredSelection()?.name;
    const relocated = lastName ? modules.find((m) => m.name === lastName) : undefined;
    if (relocated) {
      handleModuleSelect(relocated.base_address);
    } else {
      clearSelection();
    }
  }, [modules, selectedModuleBase, handleModuleSelect, clearSelection]);

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
