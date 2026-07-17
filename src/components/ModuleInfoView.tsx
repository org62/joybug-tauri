import React, { useMemo, useRef, useState } from 'react';
import { DockPanel, PanelToolbar, PanelBody } from '@/components/ui/panel';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Module } from '@/contexts/SessionContext';
import type {
  ModuleExtraInfo,
  ImageSectionHeader,
  ImportDescriptorInfo,
  RuntimeFunction,
} from '@/hooks/useModuleInfo';
import { Loader2, FileWarning, FileSearch, ChevronDown, ChevronRight } from 'lucide-react';
import { useInlineVirtualizer } from '@/hooks/useInlineVirtualizer';
import { moduleBasename } from '@/lib/sessionHelpers';
import {
  DATA_DIRECTORY_NAMES, DLL_CHARACTERISTICS_FLAGS, MACHINE_VALUES, SUBSYSTEM_VALUES,
  SECTION_CHARACTERISTICS_FLAGS, decodeFlags, decodeSectionName, decodeShortFlags,
  enumLabel, flattenImports, formatTimestamp, getExportForwardTarget, getExportRva, hex, hexBig,
  visibleImportRows,
} from '@/lib/peDecode';

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

// --- Helper utilities ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Clickable address link ---

const AddressLink: React.FC<{
  address: string;
  onClick?: (address: string) => void;
}> = ({ address, onClick }) => {
  if (!onClick) return <span className="font-mono">{address}</span>;
  return (
    <Button
      variant="link"
      className="h-auto p-0 font-mono text-blue-500 hover:text-blue-400"
      onClick={() => onClick(address)}
    >
      {address}
    </Button>
  );
};

// --- Section: PE Headers ---

const PEHeadersSection: React.FC<{
  info: ModuleExtraInfo;
  moduleBase: string;
  moduleName: string;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
}> = ({ info, moduleBase, moduleName, onNavigateToDisassembly, onNavigateToMemory }) => {
  const fh = info.nt_headers.FileHeader;
  const oh = info.nt_headers.OptionalHeader;
  const baseAddr = BigInt(moduleBase);
  const entryPointVA = baseAddr + BigInt(oh.AddressOfEntryPoint);
  const entryPointStr = `0x${entryPointVA.toString(16).toUpperCase()}`;

  return (
    <div className="space-y-3">
      {/* Module summary header */}
      <div className="border-b pb-2">
        <h3 className="font-semibold text-sm">{moduleBasename(moduleName)}</h3>
        <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
          <div>Base: <AddressLink address={moduleBase} onClick={onNavigateToMemory} /></div>
          <div>
            Entry Point:{' '}
            <AddressLink address={entryPointStr} onClick={onNavigateToDisassembly} />
          </div>
        </div>
      </div>

      {/* PE Header fields */}
      <div>
        <h4 className="font-medium text-xs text-muted-foreground mb-1">PE Headers</h4>
        <table className="w-full text-xs">
          <tbody>
            <HeaderRow label="Machine" value={enumLabel(MACHINE_VALUES, fh.Machine)} />
            <HeaderRow label="Timestamp" value={formatTimestamp(fh.TimeDateStamp)} />
            <HeaderRow label="Subsystem" value={enumLabel(SUBSYSTEM_VALUES, oh.Subsystem)} />
            <HeaderRow label="Image Base" value={hexBig(oh.ImageBase)} />
            <HeaderRow label="Image Size" value={`${hex(oh.SizeOfImage)} (${formatSize(oh.SizeOfImage)})`} />
            <HeaderRow label="Code Size" value={`${hex(oh.SizeOfCode)} (${formatSize(oh.SizeOfCode)})`} />
            <HeaderRow label="Section Alignment" value={hex(oh.SectionAlignment)} />
            <HeaderRow label="File Alignment" value={hex(oh.FileAlignment)} />
            <HeaderRow label="Checksum" value={hex(oh.CheckSum)} />
            <HeaderRow label="DLL Characteristics" value={decodeFlags(DLL_CHARACTERISTICS_FLAGS, oh.DllCharacteristics)} />
            <HeaderRow label="Stack Reserve" value={hexBig(oh.SizeOfStackReserve)} />
            <HeaderRow label="Heap Reserve" value={hexBig(oh.SizeOfHeapReserve)} />
          </tbody>
        </table>
      </div>
    </div>
  );
};

const HeaderRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <tr className="border-b border-border/40">
    <td className="py-0.5 pr-3 text-muted-foreground whitespace-nowrap">{label}</td>
    <td className="py-0.5 font-mono break-all">{value}</td>
  </tr>
);

// --- Section: Sections ---

const SectionsTable: React.FC<{
  sections: ImageSectionHeader[];
  moduleBase: string;
  onNavigateToMemory?: (address: string) => void;
}> = ({ sections, moduleBase, onNavigateToMemory }) => {
  const baseAddr = BigInt(moduleBase);
  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-1">
        Sections ({sections.length})
      </h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-0.5 pr-2">Name</th>
            <th className="text-left py-0.5 pr-2">VirtAddr</th>
            <th className="text-left py-0.5 pr-2">VirtSize</th>
            <th className="text-left py-0.5 pr-2">RawSize</th>
            <th className="text-left py-0.5">Flags</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((s, i) => {
            const va = `0x${(baseAddr + BigInt(s.VirtualAddress)).toString(16).toUpperCase()}`;
            return (
              <tr key={i} className="border-b border-border/40">
                <td className="py-0.5 pr-2 font-mono">{decodeSectionName(s.Name)}</td>
                <td className="py-0.5 pr-2">
                  <AddressLink address={va} onClick={onNavigateToMemory} />
                </td>
                <td className="py-0.5 pr-2 font-mono">{hex(s.VirtualSize)}</td>
                <td className="py-0.5 pr-2 font-mono">{hex(s.SizeOfRawData)}</td>
                <td className="py-0.5 font-mono text-muted-foreground">{decodeShortFlags(SECTION_CHARACTERISTICS_FLAGS, s.Characteristics)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// --- Section: Exports ---

const EXPORT_ROW_HEIGHT = 24;

const ExportsTable: React.FC<{
  exports: ModuleExtraInfo['exports'];
  moduleBase: string;
  entryPointRva: number;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onNavigateToDisassembly?: (address: string) => void;
}> = ({ exports, moduleBase, entryPointRva, scrollContainerRef, onNavigateToDisassembly }) => {
  const entries = exports?.entries ?? [];
  const { listRef, virtualizer, rowStyle } = useInlineVirtualizer(scrollContainerRef, entries.length, EXPORT_ROW_HEIGHT);

  if (!exports) return null;

  const baseAddr = BigInt(moduleBase);

  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-1">
        Exports — {exports.dll_name} ({entries.length})
      </h4>
      {/* Header row */}
      <div className="flex text-xs text-muted-foreground border-b">
        <span className="py-0.5 pr-2 shrink-0" style={{ width: 50 }}>Ord</span>
        <span className="py-0.5 pr-2 shrink-0" style={{ width: 200 }}>Name</span>
        <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>Address</span>
        <span className="py-0.5 flex-1">Forward</span>
      </div>
      {/* Virtualized rows — rendered inline within the outer ScrollArea */}
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index];
          const rva = getExportRva(entry.kind);
          const fwd = getExportForwardTarget(entry.kind);
          const va = rva !== null && rva !== 0 ? `0x${(baseAddr + BigInt(rva)).toString(16).toUpperCase()}` : null;
          const isEntryPoint = rva === entryPointRva;

          return (
            <div
              key={virtualRow.index}
              className={`flex text-xs border-b border-border/40 ${isEntryPoint ? 'bg-yellow-500/10' : ''}`}
              style={rowStyle(virtualRow)}
            >
              <span className="py-0.5 pr-2 font-mono shrink-0" style={{ width: 50 }}>{entry.ordinal}</span>
              <span className="py-0.5 pr-2 font-mono shrink-0 flex" style={{ width: 200 }}>
                {entry.name ? <TruncatedSymbol text={entry.name} className="flex-1" /> : '—'}
              </span>
              <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>
                {va ? (
                  <AddressLink address={va} onClick={onNavigateToDisassembly} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              <span className="py-0.5 font-mono text-muted-foreground flex-1 min-w-0 flex">
                <TruncatedSymbol text={fwd ?? ''} className="flex-1" />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- Section: DOS Header + Data Directories ---

const DataDirectoriesTable: React.FC<{
  info: ModuleExtraInfo;
  moduleBase: string;
  onNavigateToMemory?: (address: string) => void;
}> = ({ info, moduleBase, onNavigateToMemory }) => {
  const dirs = info.nt_headers.OptionalHeader.DataDirectory;
  const baseAddr = BigInt(moduleBase);
  const nonEmpty = dirs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.VirtualAddress !== 0 || d.Size !== 0);

  if (nonEmpty.length === 0) return null;

  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-1">
        Data Directories ({nonEmpty.length})
      </h4>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-0.5 pr-2">Directory</th>
            <th className="text-left py-0.5 pr-2">RVA</th>
            <th className="text-left py-0.5">Size</th>
          </tr>
        </thead>
        <tbody>
          {nonEmpty.map(({ d, i }) => {
            const va = `0x${(baseAddr + BigInt(d.VirtualAddress)).toString(16).toUpperCase()}`;
            return (
              <tr key={i} className="border-b border-border/40">
                <td className="py-0.5 pr-2">{DATA_DIRECTORY_NAMES[i] ?? `#${i}`}</td>
                <td className="py-0.5 pr-2">
                  <AddressLink address={va} onClick={onNavigateToMemory} />
                </td>
                <td className="py-0.5 font-mono">{hex(d.Size)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// --- Section: Imports ---

const IMPORT_ROW_HEIGHT = 24;

const ImportsTable: React.FC<{
  imports: ImportDescriptorInfo[];
  moduleBase: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onNavigateToMemory?: (address: string) => void;
}> = ({ imports, moduleBase, scrollContainerRef, onNavigateToMemory }) => {
  const { rows: allRows, entryCount: totalSymbols } = useMemo(() => flattenImports(imports), [imports]);
  // Individually foldable DLLs: collapsed ones keep their header row only.
  const [collapsedDlls, setCollapsedDlls] = useState<Set<number>>(new Set());
  const toggleDll = (i: number) =>
    setCollapsedDlls((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  const rows = useMemo(() => visibleImportRows(allRows, collapsedDlls), [allRows, collapsedDlls]);
  const baseAddr = BigInt(moduleBase);
  const { listRef, virtualizer, rowStyle } = useInlineVirtualizer(scrollContainerRef, rows.length, IMPORT_ROW_HEIGHT);

  if (imports.length === 0) return null;

  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-1">
        Imports ({imports.length} DLL{imports.length !== 1 ? 's' : ''}, {totalSymbols} symbols)
      </h4>
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const style = rowStyle(virtualRow);
          if (row.kind === 'dll') {
            const open = !collapsedDlls.has(row.dllIndex);
            return (
              <div
                key={virtualRow.index}
                className="flex items-center gap-1 text-xs font-medium border-b bg-muted/30 hover:bg-muted/50 px-1 cursor-pointer select-none"
                style={style}
                onClick={() => toggleDll(row.dllIndex)}
              >
                {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <span className="font-mono">{row.dll}</span>
                <span className="ml-1 text-muted-foreground">({row.count})</span>
              </div>
            );
          }
          const va = row.rva ? `0x${(baseAddr + BigInt(row.rva)).toString(16).toUpperCase()}` : null;
          return (
            <div key={virtualRow.index} className="flex text-xs border-b border-border/40 pl-3" style={style}>
              <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>
                {va ? <AddressLink address={va} onClick={onNavigateToMemory} /> : <span className="text-muted-foreground">—</span>}
              </span>
              <span className="py-0.5 font-mono flex-1 min-w-0 flex">
                <TruncatedSymbol text={row.text} className="flex-1" />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- Section: Runtime Functions (exception directory) ---

const RUNTIME_ROW_HEIGHT = 22;

const RuntimeFunctionsTable: React.FC<{
  runtimeFunctions: RuntimeFunction[];
  moduleBase: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onNavigateToDisassembly?: (address: string) => void;
}> = ({ runtimeFunctions, moduleBase, scrollContainerRef, onNavigateToDisassembly }) => {
  const baseAddr = BigInt(moduleBase);
  const { listRef, virtualizer, rowStyle } = useInlineVirtualizer(scrollContainerRef, runtimeFunctions.length, RUNTIME_ROW_HEIGHT);

  if (runtimeFunctions.length === 0) return null;

  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-1">
        Runtime Functions ({runtimeFunctions.length})
      </h4>
      <div className="flex text-xs text-muted-foreground border-b">
        <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>Begin</span>
        <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>End</span>
        <span className="py-0.5 flex-1">Unwind</span>
      </div>
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const rf = runtimeFunctions[virtualRow.index];
          const begin = `0x${(baseAddr + BigInt(rf.BeginAddress)).toString(16).toUpperCase()}`;
          const end = `0x${(baseAddr + BigInt(rf.EndAddress)).toString(16).toUpperCase()}`;
          return (
            <div
              key={virtualRow.index}
              className="flex text-xs border-b border-border/40"
              style={rowStyle(virtualRow)}
            >
              <span className="py-0.5 pr-2 shrink-0" style={{ width: 160 }}>
                <AddressLink address={begin} onClick={onNavigateToDisassembly} />
              </span>
              <span className="py-0.5 pr-2 shrink-0 font-mono" style={{ width: 160 }}>{end}</span>
              <span className="py-0.5 font-mono text-muted-foreground flex-1">{hex(rf.UnwindData)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- Main component ---

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

  const viewportRef = useRef<HTMLDivElement>(null);

  return (
    <DockPanel>
      {/* Module selector combobox */}
      <PanelToolbar>
        <Select
          value={selectedModuleBase ?? ''}
          onValueChange={onModuleSelect}
        >
          <SelectTrigger size="xs" className="w-full">
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
      </PanelToolbar>

      {/* Content area */}
      <PanelBody viewportRef={viewportRef}>
        <div className="p-2 space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm">Loading module info...</span>
            </div>
          )}

          {error && !isLoading && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FileWarning className="h-8 w-8 mb-2 text-red-500" />
              <p className="text-sm text-red-500">{error}</p>
            </div>
          )}

          {!isLoading && !error && !info && !selectedModuleBase && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <FileSearch className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-base font-medium">No module selected</p>
                <p className="text-sm mt-1">Select a module to view PE information</p>
              </div>
            </div>
          )}

          {!isLoading && !error && info && selectedModule && (
            <>
              <PEHeadersSection
                info={info}
                moduleBase={selectedModuleBase!}
                moduleName={selectedModule.name}
                onNavigateToDisassembly={onNavigateToDisassembly}
                onNavigateToMemory={onNavigateToMemory}
              />
              <SectionsTable sections={info.sections} moduleBase={selectedModuleBase!} onNavigateToMemory={onNavigateToMemory} />
              <DataDirectoriesTable info={info} moduleBase={selectedModuleBase!} onNavigateToMemory={onNavigateToMemory} />
              <ImportsTable
                imports={info.imports}
                moduleBase={selectedModuleBase!}
                scrollContainerRef={viewportRef}
                onNavigateToMemory={onNavigateToMemory}
              />
              <ExportsTable
                exports={info.exports}
                moduleBase={selectedModuleBase!}
                entryPointRva={info.nt_headers.OptionalHeader.AddressOfEntryPoint}
                scrollContainerRef={viewportRef}
                onNavigateToDisassembly={onNavigateToDisassembly}
              />
              {info.runtime_functions && (
                <RuntimeFunctionsTable
                  runtimeFunctions={info.runtime_functions}
                  moduleBase={selectedModuleBase!}
                  scrollContainerRef={viewportRef}
                  onNavigateToDisassembly={onNavigateToDisassembly}
                />
              )}
            </>
          )}
        </div>
      </PanelBody>
    </DockPanel>
  );
};
