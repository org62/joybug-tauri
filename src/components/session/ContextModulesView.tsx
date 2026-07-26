import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { useSessionContext, Module, ModuleSymbolStatus, PdbLoadResult } from '@/contexts/SessionContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useContextMenu } from '@/hooks/useContextMenu';
import { moduleBasename } from '@/lib/sessionHelpers';
import { parseAddress } from '@/lib/hexUtils';
import { Layers, FileSymlink, RotateCcw, Loader2, Copy, Trash2 } from 'lucide-react';

/** Pre-parsed quick-filter query, computed once per filter change (the list
 *  re-filters per keystroke and per modules poll, so keep query parsing out
 *  of the per-module loop). */
interface ModuleFilter {
  text: string;
  textNoPrefix: string;
  addr: bigint | null;
}

function parseModuleFilter(query: string): ModuleFilter | null {
  const text = query.trim().toLowerCase();
  if (!text) return null;
  return {
    text,
    textNoPrefix: text.replace(/^0x/, ''),
    // Address-in-range: "0x7ffc12345678" (or bare hex) finds the containing module
    addr: parseAddress(text),
  };
}

/** Match a module against the query: substring on name/path (case-
 *  insensitive), substring on the base address hex, or — when the query parses
 *  as a hex address — any module whose [base, base+size) range contains it. */
function moduleMatchesFilter(module: Module, q: ModuleFilter): boolean {
  if (module.name.toLowerCase().includes(q.text) || module.path.toLowerCase().includes(q.text)) return true;
  const baseHex = module.base_address.toLowerCase();
  if (baseHex.includes(q.text) || baseHex.replace(/^0x/, '').includes(q.textNoPrefix)) return true;
  if (q.addr !== null) {
    const base = BigInt(module.base_address);
    if (q.addr >= base && q.addr < base + BigInt(module.size)) return true;
  }
  return false;
}

interface ContextModulesViewProps {
  onOpenModuleInfo?: (moduleBase: string) => void;
}

// Fixed row height (px) for the virtualized module list. Rows are uniform (2 lines
// of truncated text), so a fixed height avoids per-row getBoundingClientRect measurement.
const MODULE_ROW_HEIGHT = 44;

interface PdbMismatchPrompt {
  module: Module;
  pdbPath: string;
  mismatch: NonNullable<PdbLoadResult['mismatch']>;
}

function SymbolStatusBadge({ status }: { status: ModuleSymbolStatus | undefined }) {
  if (!status) return null;
  switch (status.status) {
    case 'loaded':
      return (
        <Badge variant="outline" size="xs" title={status.pdb_path ?? undefined}>
          {status.symbol_count ?? 0} syms
        </Badge>
      );
    case 'loading':
      return (
        <Badge variant="outline" size="xs" title="Downloading symbols…">
          <Loader2 className="h-3 w-3 animate-spin" />
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" size="xs" title={status.error ?? undefined}>
          no symbols
        </Badge>
      );
    default:
      return null;
  }
}

export const ContextModulesView: React.FC<ContextModulesViewProps> = ({ onOpenModuleInfo }) => {
  const sessionData = useSessionContext();
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<Module>();
  const [mismatchPrompt, setMismatchPrompt] = useState<PdbMismatchPrompt | null>(null);
  const [filter, setFilter] = useState('');

  // Load modules when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadModules();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const modules = sessionData?.modules ?? [];

  const filteredModules = useMemo(() => {
    const q = parseModuleFilter(filter);
    return q ? modules.filter((m) => moduleMatchesFilter(m, q)) : modules;
  }, [modules, filter]);

  // Both base_address strings come from the same backend hex formatting, so
  // they can be compared verbatim.
  const statusByBase = useMemo(() => {
    const map = new Map<string, ModuleSymbolStatus>();
    for (const s of sessionData?.symbolStatuses ?? []) {
      map.set(s.base_address, s);
    }
    return map;
  }, [sessionData?.symbolStatuses]);

  const failedStatuses = useMemo(
    () => (sessionData?.symbolStatuses ?? []).filter((s) => s.status === 'failed'),
    [sessionData?.symbolStatuses],
  );

  const loadPdbForModule = async (module: Module, pdbPath: string, force: boolean) => {
    try {
      const result = await sessionData.loadModulePdb(module.base_address, pdbPath, force);
      if (result.loaded) {
        toast.success(`Loaded ${result.symbol_count ?? 0} symbols for ${moduleBasename(module.name)}`);
      } else if (result.mismatch) {
        setMismatchPrompt({ module, pdbPath, mismatch: result.mismatch });
      }
    } catch (error) {
      toast.error(`Failed to load PDB: ${error}`);
    }
  };

  const handleLoadPdbFromFile = async (module: Module) => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'PDB Files', extensions: ['pdb'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;
    await loadPdbForModule(module, selected, false);
  };

  const handleRetrySymbols = async (module: Module) => {
    try {
      await sessionData.retryModuleSymbols(module.base_address);
      toast.success(`Retrying symbol download for ${moduleBasename(module.name)}`);
    } catch (error) {
      toast.error(`Failed to retry symbol download: ${error}`);
    }
  };

  // Re-try every failed download (also lifts their persisted don't-retry marks).
  const handleRetryAllSymbols = async () => {
    if (failedStatuses.length === 0) return;
    try {
      await Promise.all(failedStatuses.map((s) => sessionData.retryModuleSymbols(s.base_address)));
      toast.success(`Retrying symbol download for ${failedStatuses.length} module${failedStatuses.length === 1 ? '' : 's'}`);
    } catch (error) {
      toast.error(`Failed to retry symbol downloads: ${error}`);
    }
  };

  const formatBytes = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  return (
    <DockPanel>
      <PanelToolbar>
        <Input
          inputSize="xs"
          className="flex-1 min-w-0"
          placeholder="Filter modules (name, path, address)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {filteredModules.length}/{modules.length}
          </span>
        )}
        <Button
          variant="outline"
          size="xs"
          title="Retry downloading symbols for every module whose download failed"
          disabled={failedStatuses.length === 0}
          onClick={handleRetryAllSymbols}
        >
          <RotateCcw />
          Retry symbols{failedStatuses.length > 0 ? ` (${failedStatuses.length})` : ''}
        </Button>
      </PanelToolbar>
      {filteredModules.length > 0 ? (
        <VirtualizedList
          items={filteredModules}
          rowHeight={MODULE_ROW_HEIGHT}
          overscan={15}
          className="flex-1 min-h-0"
          getItemKey={(_module, index) => index}
          renderItem={(module) => (
            /* Two lines, not three. The full path was ~90% redundant with the name
               beside it and cost a third of the panel's vertical budget on a list
               that runs to 50-100 entries on a real target — it lives in the row
               tooltip now, and in the context menu's Copy Full Path. The "Base:"
               label went with it: a bare hex value in a modules list needs no
               caption. Note the quick filter still matches on path, so a row can
               match on text that isn't visible. */
            <div
              title={module.path}
              className={`flex items-center justify-between font-mono px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900 h-full${onOpenModuleInfo ? ' cursor-pointer' : ''}`}
              onClick={onOpenModuleInfo ? () => onOpenModuleInfo(module.base_address) : undefined}
              onContextMenu={(e) => openContextMenu(e, module)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm truncate">{moduleBasename(module.name)}</h3>
                  <Badge variant="outline" size="xs">
                    {formatBytes(module.size)}
                  </Badge>
                  <SymbolStatusBadge status={statusByBase.get(module.base_address)} />
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {module.base_address}
                </p>
              </div>
            </div>
          )}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
            {modules.length > 0 ? (
              <>
                <p className="text-base font-medium">No modules match the filter</p>
                <p className="text-sm mt-1">Names, paths, and addresses are matched</p>
              </>
            ) : (
              <>
                <p className="text-base font-medium">No modules loaded yet</p>
                <p className="text-sm mt-1">Modules will appear here during debugging</p>
              </>
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
          <ContextMenuItem
            icon={<Copy className="h-3.5 w-3.5 text-muted-foreground" />}
            onClick={() => navigator.clipboard.writeText(contextMenu.data.base_address)}
          >
            Copy Base Address
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Copy className="h-3.5 w-3.5 text-muted-foreground" />}
            onClick={() => navigator.clipboard.writeText(contextMenu.data.path)}
          >
            Copy Full Path
          </ContextMenuItem>
          {statusByBase.get(contextMenu.data.base_address)?.pdb_path && (
            <ContextMenuItem
              icon={<Copy className="h-3.5 w-3.5 text-muted-foreground" />}
              onClick={() =>
                navigator.clipboard.writeText(
                  statusByBase.get(contextMenu.data.base_address)!.pdb_path!,
                )
              }
            >
              Copy Symbol Path
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<FileSymlink className="h-3.5 w-3.5" />}
            onClick={() => handleLoadPdbFromFile(contextMenu.data)}
          >
            Load PDB from file…
          </ContextMenuItem>
          {statusByBase.get(contextMenu.data.base_address)?.status === 'failed' && (
            <ContextMenuItem
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => handleRetrySymbols(contextMenu.data)}
            >
              Retry symbol download
            </ContextMenuItem>
          )}
          {statusByBase.get(contextMenu.data.base_address)?.status === 'not_requested' && (
            <ContextMenuItem
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => handleRetrySymbols(contextMenu.data)}
            >
              Download symbols
            </ContextMenuItem>
          )}
          {statusByBase.get(contextMenu.data.base_address)?.status === 'loaded' && (
            <ContextMenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => sessionData.unloadModuleSymbols(contextMenu.data.base_address)}
            >
              Unload symbols
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}

      <Dialog open={mismatchPrompt !== null} onOpenChange={(isOpen) => { if (!isOpen) setMismatchPrompt(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>PDB doesn't match the module</DialogTitle>
            <DialogDescription>
              The selected PDB was not built from this exact binary. Symbols may resolve to wrong addresses.
            </DialogDescription>
          </DialogHeader>
          {mismatchPrompt && (
            <div className="text-sm space-y-1 font-mono">
              <p className="truncate" title={mismatchPrompt.module.name}>
                Module: {mismatchPrompt.mismatch.pe_guid} age {mismatchPrompt.mismatch.pe_age}
              </p>
              <p className="truncate" title={mismatchPrompt.pdbPath}>
                PDB: {mismatchPrompt.mismatch.pdb_guid} age {mismatchPrompt.mismatch.pdb_age}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMismatchPrompt(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const prompt = mismatchPrompt;
                setMismatchPrompt(null);
                if (prompt) loadPdbForModule(prompt.module, prompt.pdbPath, true);
              }}
            >
              Load anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DockPanel>
  );
};
