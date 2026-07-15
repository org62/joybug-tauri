import React, { useMemo, useRef, useLayoutEffect, useState } from 'react';
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
  ExportKind,
} from '@/hooks/useModuleInfo';
import { Loader2, FileWarning, FileSearch } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { moduleBasename } from '@/lib/sessionHelpers';

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

function decodeSectionName(nameBytes: number[]): string {
  const bytes = nameBytes.filter(b => b !== 0);
  return String.fromCharCode(...bytes);
}

function decodeSectionFlags(characteristics: number): string {
  const flags: string[] = [];
  if (characteristics & 0x00000020) flags.push('Code');
  if (characteristics & 0x00000040) flags.push('InitData');
  if (characteristics & 0x00000080) flags.push('UninitData');
  if (characteristics & 0x20000000) flags.push('X');
  if (characteristics & 0x40000000) flags.push('R');
  if (characteristics & 0x80000000) flags.push('W');
  return flags.join(' | ');
}

function getMachineType(machine: number): string {
  switch (machine) {
    case 0x14c: return 'x86 (I386)';
    case 0x8664: return 'x64 (AMD64)';
    case 0xAA64: return 'ARM64';
    case 0x1c0: return 'ARM';
    case 0x1c4: return 'ARM Thumb-2';
    default: return `Unknown (0x${machine.toString(16)})`;
  }
}

function getSubsystem(subsystem: number): string {
  switch (subsystem) {
    case 1: return 'Native';
    case 2: return 'Windows GUI';
    case 3: return 'Windows CUI';
    case 5: return 'OS/2 CUI';
    case 7: return 'POSIX CUI';
    case 9: return 'Windows CE GUI';
    case 10: return 'EFI Application';
    case 11: return 'EFI Boot Service Driver';
    case 12: return 'EFI Runtime Driver';
    case 13: return 'EFI ROM';
    case 14: return 'Xbox';
    default: return `Unknown (${subsystem})`;
  }
}

function decodeDllCharacteristics(chars: number): string {
  const flags: string[] = [];
  if (chars & 0x0020) flags.push('HIGH_ENTROPY_VA');
  if (chars & 0x0040) flags.push('DYNAMIC_BASE');
  if (chars & 0x0080) flags.push('FORCE_INTEGRITY');
  if (chars & 0x0100) flags.push('NX_COMPAT');
  if (chars & 0x0200) flags.push('NO_ISOLATION');
  if (chars & 0x0400) flags.push('NO_SEH');
  if (chars & 0x0800) flags.push('NO_BIND');
  if (chars & 0x1000) flags.push('APPCONTAINER');
  if (chars & 0x2000) flags.push('WDM_DRIVER');
  if (chars & 0x4000) flags.push('GUARD_CF');
  if (chars & 0x8000) flags.push('TERMINAL_SERVER_AWARE');
  return flags.join(', ');
}

function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) return '0';
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  // PE format exists since ~1993; dates outside a reasonable range are likely
  // content hashes from reproducible/deterministic builds (e.g. MSVC /Brepro)
  if (year < 1980 || year > new Date().getFullYear() + 1) {
    return `0x${timestamp.toString(16).toUpperCase()}`;
  }
  return `${date.toISOString().replace('T', ' ').replace('.000Z', '')} (0x${timestamp.toString(16).toUpperCase()})`;
}

function getExportRva(kind: ExportKind): number | null {
  if ('Symbol' in kind) return kind.Symbol.rva;
  return null;
}

function getExportForwardTarget(kind: ExportKind): string | null {
  if ('Forward' in kind) return kind.Forward.target;
  return null;
}

function hex(value: number, width: number = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

function hexBig(value: number, width: number = 16): string {
  // For values that could be > 32-bit, use BigInt formatting
  return `0x${BigInt(value).toString(16).toUpperCase().padStart(width, '0')}`;
}

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
            <HeaderRow label="Machine" value={getMachineType(fh.Machine)} />
            <HeaderRow label="Timestamp" value={formatTimestamp(fh.TimeDateStamp)} />
            <HeaderRow label="Subsystem" value={getSubsystem(oh.Subsystem)} />
            <HeaderRow label="Image Base" value={hexBig(oh.ImageBase)} />
            <HeaderRow label="Image Size" value={`${hex(oh.SizeOfImage)} (${formatSize(oh.SizeOfImage)})`} />
            <HeaderRow label="Code Size" value={`${hex(oh.SizeOfCode)} (${formatSize(oh.SizeOfCode)})`} />
            <HeaderRow label="Section Alignment" value={hex(oh.SectionAlignment)} />
            <HeaderRow label="File Alignment" value={hex(oh.FileAlignment)} />
            <HeaderRow label="Checksum" value={hex(oh.CheckSum)} />
            <HeaderRow label="DLL Characteristics" value={decodeDllCharacteristics(oh.DllCharacteristics)} />
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
                <td className="py-0.5 font-mono text-muted-foreground">{decodeSectionFlags(s.Characteristics)}</td>
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
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const entries = exports?.entries ?? [];

  // Measure distance from scroll container top to the virtualized list
  useLayoutEffect(() => {
    if (listRef.current && scrollContainerRef.current) {
      const listTop = listRef.current.getBoundingClientRect().top;
      const scrollTop = scrollContainerRef.current.getBoundingClientRect().top;
      setScrollMargin(listTop - scrollTop + scrollContainerRef.current.scrollTop);
    }
  });

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => EXPORT_ROW_HEIGHT,
    overscan: 30,
    scrollMargin,
  });

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
              style={{
                position: 'absolute',
                top: virtualRow.start - virtualizer.options.scrollMargin,
                left: 0,
                right: 0,
                height: EXPORT_ROW_HEIGHT,
              }}
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
              <ExportsTable
                exports={info.exports}
                moduleBase={selectedModuleBase!}
                entryPointRva={info.nt_headers.OptionalHeader.AddressOfEntryPoint}
                scrollContainerRef={viewportRef}
                onNavigateToDisassembly={onNavigateToDisassembly}
              />
            </>
          )}
        </div>
      </PanelBody>
    </DockPanel>
  );
};
