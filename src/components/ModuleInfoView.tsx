import React, { useCallback, useMemo, useRef, useState } from 'react';
import { DockPanel, PanelToolbar, PanelBody } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Module } from '@/contexts/SessionContext';
import type { ModuleExtraInfo } from '@/hooks/useModuleInfo';
import { Loader2, FileWarning, FileSearch } from 'lucide-react';
import { EmptyState, ProcessUnavailableState } from '@/components/ui/empty-state';
import { moduleBasename } from '@/lib/sessionHelpers';
import { PeStructureTree, PE_TREE_MIN_WIDTH } from '@/components/pe/PeStructureTree';
import { AddrModeSelect } from '@/components/pe/AddrModeSelect';
import { AddrMode, AddrTriple, buildMapping, formatAddr } from '@/lib/peAddress';

interface ModuleInfoViewProps {
  modules: Module[];
  selectedModuleBase: string | null;
  onModuleSelect: (base: string) => void;
  info: ModuleExtraInfo | null;
  isLoading: boolean;
  error: string | null;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
}

/**
 * PE Viewer for a module of the live process: the same structure tree as the
 * standalone PE viewer, read-only, mapped at the module's actual load base so
 * every address links into the session's Memory / Disassembly tabs.
 */
export const ModuleInfoView: React.FC<ModuleInfoViewProps> = ({
  modules,
  selectedModuleBase,
  onModuleSelect,
  info,
  isLoading,
  error,
  onNavigateToDisassembly,
  onNavigateToMemory,
}) => {
  const selectedModule = useMemo(
    () => modules.find(m => m.base_address === selectedModuleBase),
    [modules, selectedModuleBase]
  );
  const [mode, setMode] = useState<AddrMode>('va');

  // The tree's big groups (imports/exports/exception) virtualize inline
  // against this panel viewport, so the panel has a single scroll region.
  const viewportRef = useRef<HTMLDivElement>(null);

  const mapping = useMemo(
    () => (info && selectedModuleBase ? buildMapping(info, BigInt(selectedModuleBase)) : null),
    [info, selectedModuleBase]
  );

  // Both targets are VA-addressed in a live process.
  const goToMemory = useCallback((t: AddrTriple) => onNavigateToMemory?.(formatAddr(t, 'va')), [onNavigateToMemory]);
  const goToDisasm = useCallback((t: AddrTriple) => onNavigateToDisassembly?.(formatAddr(t, 'va')), [onNavigateToDisassembly]);

  return (
    <DockPanel>
      <PanelToolbar>
        <Select
          value={selectedModuleBase ?? ''}
          disabled={modules.length === 0}
          onValueChange={onModuleSelect}
        >
          <SelectTrigger size="xs" className="flex-1 min-w-0" data-testid="peviewer-module-select">
            <SelectValue placeholder="Select a module..." />
          </SelectTrigger>
          <SelectContent>
            {modules.map((m) => (
              <SelectItem key={m.base_address} value={m.base_address} className="text-xs">
                <span className="font-mono">{m.base_address}</span>
                {' — '}
                {moduleBasename(m.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Sized to its label so a narrow panel leaves the module select
            (which carries the only identifying text) as much room as possible. */}
        <AddrModeSelect value={mode} onChange={setMode} className="shrink-0" data-testid="peviewer-addr-mode" />
      </PanelToolbar>

      <PanelBody viewportRef={viewportRef} minContentWidth={PE_TREE_MIN_WIDTH}>
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Loading module info...</span>
          </div>
        )}

        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FileWarning className="h-8 w-8 mb-2 text-syn-invalid" />
            <p className="text-sm text-syn-invalid">{error}</p>
          </div>
        )}

        {!isLoading && !error && !info && !selectedModuleBase && (
          <EmptyState
            icon={<FileSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />}
            title="No module selected"
            subtitle="Select a module to view PE information"
          />
        )}

        {/* A module is still selected (the choice persists across runs) but
            there is nothing to show: the process went away and its info was
            cleared. Without this branch the body renders blank. */}
        {!isLoading && !error && !info && selectedModuleBase && !selectedModule && (
          <ProcessUnavailableState icon={FileSearch} what="Module info" />
        )}

        {!isLoading && !error && info && mapping && selectedModule && (
          <PeStructureTree
            info={info}
            mapping={mapping}
            mode={mode}
            scrollRef={viewportRef}
            hexLabel="Memory"
            onGoToHex={goToMemory}
            onGoToDisasm={goToDisasm}
          />
        )}
      </PanelBody>
    </DockPanel>
  );
};
