import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { useSessionContext, Module, ModuleSymbolStatus, PdbLoadResult } from '@/contexts/SessionContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DockPanel } from '@/components/ui/panel';
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
import { Layers, FileSymlink, RotateCcw, Loader2, Copy } from 'lucide-react';

interface ContextModulesViewProps {
  onOpenModuleInfo?: (moduleBase: string) => void;
}

// Fixed row height (px) for the virtualized module list. Rows are uniform (3 lines
// of truncated text), so a fixed height avoids per-row getBoundingClientRect measurement.
const MODULE_ROW_HEIGHT = 72;

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

  // Load modules when component mounts or session changes
  useEffect(() => {
    if (sessionData?.session?.id) {
      sessionData.loadModules();
    }
  }, [sessionData?.session?.id, sessionData?.session?.status, sessionData?.session?.current_event]);

  const modules = sessionData?.modules ?? [];

  // Both base_address strings come from the same backend hex formatting, so
  // they can be compared verbatim.
  const statusByBase = useMemo(() => {
    const map = new Map<string, ModuleSymbolStatus>();
    for (const s of sessionData?.symbolStatuses ?? []) {
      map.set(s.base_address, s);
    }
    return map;
  }, [sessionData?.symbolStatuses]);

  const loadPdbForModule = async (module: Module, pdbPath: string, force: boolean) => {
    try {
      const result = await sessionData.loadModulePdb(module.base_address, pdbPath, force);
      if (result.loaded) {
        toast.success(`Loaded ${result.symbol_count ?? 0} symbols for ${getFileName(module.name)}`);
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
      toast.success(`Retrying symbol download for ${getFileName(module.name)}`);
    } catch (error) {
      toast.error(`Failed to retry symbol download: ${error}`);
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

  const getFileName = (fullPath: string) => {
    const parts = fullPath.split(/[\\/]/);
    return parts[parts.length - 1];
  };

  return (
    <DockPanel>
      {modules.length > 0 ? (
        <VirtualizedList
          items={modules}
          rowHeight={MODULE_ROW_HEIGHT}
          overscan={15}
          className="flex-1 min-h-0"
          getItemKey={(_module, index) => index}
          renderItem={(module) => (
            <div
              className={`flex items-center justify-between px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900 h-full${onOpenModuleInfo ? ' cursor-pointer' : ''}`}
              onClick={onOpenModuleInfo ? () => onOpenModuleInfo(module.base_address) : undefined}
              onContextMenu={(e) => openContextMenu(e, module)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-medium text-sm truncate">{getFileName(module.name)}</h3>
                  <Badge variant="outline" size="xs">
                    {formatBytes(module.size)}
                  </Badge>
                  <SymbolStatusBadge status={statusByBase.get(module.base_address)} />
                </div>
                <p className="text-xs text-muted-foreground mb-1 truncate">
                  Base: <span className="font-mono">{module.base_address}</span>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {module.path}
                </p>
              </div>
            </div>
          )}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No modules loaded yet</p>
            <p className="text-sm mt-1">Modules will appear here during debugging</p>
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
