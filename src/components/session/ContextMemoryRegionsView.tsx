import { useEffect, useState, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Virtualizer } from '@tanstack/react-virtual';
import { useSessionContext } from '@/contexts/SessionContext';
import { contextToRegisters, formatTauriError } from '@/lib/sessionHelpers';
import { formatAddress } from '@/lib/hexUtils';
import { copyToClipboard } from '@/lib/clipboard';
import { useSymbolResolver } from '@/hooks/useSymbolResolver';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { memoryRegionsNavigation } from '@/lib/navigationStore';
import { useContextMenu } from '@/hooks/useContextMenu';
import { toastError } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { AlertCircle, MemoryStick, Loader2, Eye, Code, Copy } from 'lucide-react';
import { DockPanel, PanelToolbar } from '@/components/ui/panel';
import { VirtualizedList } from '@/components/ui/virtualized-list';
import { Badge } from '@/components/ui/badge';
import { AddressExpressionInput } from '@/components/AddressExpressionInput';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Fixed row height (px) for the virtualized region list. Matches the row's
// `text-xs` content plus vertical padding and the bottom border.
const REGION_ROW_HEIGHT = 25;

// Filter value → raw Win32 state/type string. Hoisted so the filter callback
// doesn't reallocate these maps for every region on each recompute.
const STATE_FILTER_MATCH: Record<string, string> = {
  committed: 'MEM_COMMIT',
  reserved: 'MEM_RESERVE',
  free: 'MEM_FREE',
};
const TYPE_FILTER_MATCH: Record<string, string> = {
  image: 'MEM_IMAGE',
  private: 'MEM_PRIVATE',
  mapped: 'MEM_MAPPED',
};

// Columns don't reflow below this width; the panel scrolls horizontally instead.
const REGIONS_MIN_WIDTH = 900;

// Badge kinds whose structure has a PDB type — clicking the badge opens the
// Types view with that type overlaid at the annotation's address.
const KIND_TYPE_OVERLAY: Record<string, string> = {
  teb: '_TEB',
  peb: '_PEB',
  kuser: '_KUSER_SHARED_DATA',
};

// Badge color per annotation kind (muted, dark-theme friendly).
const KIND_BADGE_CLASS: Record<string, string> = {
  module: 'bg-sky-500/15 text-sky-500 border-sky-500/30',
  section: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  teb: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  peb: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  heap: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  stack: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  kuser: 'bg-cyan-500/15 text-cyan-500 border-cyan-500/30',
};

interface RegionAnnotation {
  kind: string;
  label: string;
  address?: string;
}

interface MemoryRegion {
  base_address: string;
  allocation_base: string;
  region_size: number;
  region_size_formatted: string;
  state: string;
  state_raw: number;
  protect: string;
  protect_raw: number;
  region_type: string;
  type_raw: number;
  annotations: RegionAnnotation[];
}

type StateFilter = 'all' | 'committed' | 'reserved' | 'free';
type TypeFilter = 'all' | 'image' | 'private' | 'mapped';

const regionContains = (region: MemoryRegion, address: bigint) => {
  const base = BigInt(region.base_address);
  return base <= address && address < base + BigInt(region.region_size);
};

const regionEndAddress = (region: MemoryRegion) =>
  formatAddress(BigInt(region.base_address) + BigInt(region.region_size));

interface ContextMemoryRegionsViewProps {
  onNavigateToAddress?: (address: string) => void;
}

export function ContextMemoryRegionsView({ onNavigateToAddress }: ContextMemoryRegionsViewProps) {
  const sessionData = useSessionContext();
  const [regions, setRegions] = useState<MemoryRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>('committed');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [gotoInput, setGotoInput] = useState('');
  const [pendingGoto, setPendingGoto] = useState<bigint | null>(null);
  const [highlightedBase, setHighlightedBase] = useState<string | null>(null);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu<MemoryRegion>();

  const registers = useMemo(
    () => contextToRegisters(sessionData?.session?.current_event?.context),
    [sessionData?.session?.current_event?.context],
  );
  const resolveSymbol = useSymbolResolver();

  // Consume "go to memory region" navigations (must run before other effects
  // so a pending address is claimed ahead of initialization work).
  useNavigationChannel(memoryRegionsNavigation, (addr) => setPendingGoto(BigInt(addr)));

  const fetchMemoryRegions = async () => {
    if (!sessionData?.session?.id) return;

    setError(null);
    setIsLoading(true);

    try {
      await invoke('request_memory_regions', {
        sessionId: sessionData.session.id,
      });
    } catch (err) {
      const errorMessage = formatTauriError(err);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  // Filter regions based on state and type filters
  const filteredRegions = useMemo(() => {
    return regions.filter(region => {
      if (stateFilter !== 'all' && region.state !== STATE_FILTER_MATCH[stateFilter]) return false;
      if (typeFilter !== 'all' && region.region_type !== TYPE_FILTER_MATCH[typeFilter]) return false;
      return true;
    });
  }, [regions, stateFilter, typeFilter]);

  // Fetch memory regions whenever a process is available (paused, running, or
  // non-invasive Open) and clear when none is.
  useEffect(() => {
    if (sessionData.canUseMemoryOps && sessionData?.session?.id) {
      fetchMemoryRegions();
    } else if (!sessionData.canUseMemoryOps) {
      setRegions([]);
      setError(null);
      setIsLoading(false);
      setPendingGoto(null);
      setHighlightedBase(null);
      setGotoInput('');
    }
  }, [sessionData?.session?.id, sessionData.canUseMemoryOps, sessionData?.session?.current_event]);

  // Listen for memory regions updates
  useEffect(() => {
    const unlistenUpdated = listen('memory-regions-updated', (event: any) => {
      if (event.payload.session_id === sessionData?.session?.id) {
        setRegions(event.payload.regions);
        setError(null);
        setIsLoading(false);
      }
    });

    const unlistenError = listen('memory-regions-error', (event: any) => {
      if (event.payload.session_id === sessionData?.session?.id) {
        setError(event.payload.error);
        setRegions([]);
        setIsLoading(false);
      }
    });

    return () => {
      unlistenUpdated.then(f => f());
      unlistenError.then(f => f());
    };
  }, [sessionData?.session?.id]);

  // Resolve a pending goto once regions are available: find the containing
  // region, widen the filters if they hide it, then scroll to and highlight it.
  useEffect(() => {
    if (pendingGoto === null) return;
    if (regions.length === 0) return; // wait for load; fetch effect already runs

    const containing = regions.find(r => regionContains(r, pendingGoto));
    if (!containing) {
      toastError(
        `No memory region contains 0x${pendingGoto.toString(16).toUpperCase()}`,
        sessionData?.session?.id,
      );
      setPendingGoto(null);
      return;
    }

    const idx = filteredRegions.indexOf(containing);
    if (idx === -1) {
      // Hidden by the current filters — deterministically widen and re-run.
      setStateFilter('all');
      setTypeFilter('all');
      return;
    }

    virtualizerRef.current?.scrollToIndex(idx, { align: 'center' });
    setHighlightedBase(containing.base_address);
    setPendingGoto(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedBase(null), 2000);
  }, [pendingGoto, regions, filteredRegions, sessionData?.session?.id]);

  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  // Handler for clicking a region to open in hex view
  const handleRegionClick = (region: MemoryRegion) => {
    if (onNavigateToAddress) {
      onNavigateToAddress(region.base_address);
    }
  };

  if (!sessionData?.session) {
    return (
      <DockPanel>
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No session available</p>
          </div>
        </div>
      </DockPanel>
    );
  }

  return (
    <DockPanel data-testid="memory-regions-panel">
      {/* Toolbar with goto + filters */}
      <PanelToolbar className="flex-wrap">
        <AddressExpressionInput
          value={gotoInput}
          onChange={setGotoInput}
          onResolve={(address) => setPendingGoto(address)}
          registers={registers}
          resolveSymbol={resolveSymbol}
          sessionId={sessionData?.session?.id}
          inputClassName="w-48"
          focusTabId="memory_regions"
          historyKey="memory-regions-goto"
        />

        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
          <SelectTrigger size="xs" className="w-28">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="committed">Committed</SelectItem>
            <SelectItem value="reserved">Reserved</SelectItem>
            <SelectItem value="free">Free</SelectItem>
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger size="xs" className="w-28">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="image">Image</SelectItem>
            <SelectItem value="private">Private</SelectItem>
            <SelectItem value="mapped">Mapped</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground ml-auto">
          {filteredRegions.length} / {regions.length} regions
        </span>
      </PanelToolbar>

      {/* Table header — scrolls horizontally in sync with the list viewport */}
      <div ref={headerScrollRef} className="overflow-hidden border-b bg-muted/50 shrink-0">
        <div
          className="flex items-center px-2 py-1 text-xs font-medium text-muted-foreground whitespace-nowrap"
          style={{ minWidth: REGIONS_MIN_WIDTH }}
        >
          <span className="w-40 shrink-0">Base Address</span>
          <span className="w-40 shrink-0">End Address</span>
          <span className="w-20 shrink-0 text-right">Size</span>
          <span className="w-24 shrink-0 ml-2">State</span>
          <span className="w-24 shrink-0">Type</span>
          <span className="w-28 shrink-0">Protection</span>
          <span className="flex-1">Details</span>
        </div>
      </div>

      {/* Region list (virtualized) */}
      {filteredRegions.length > 0 ? (
        <VirtualizedList
          items={filteredRegions}
          rowHeight={REGION_ROW_HEIGHT}
          overscan={20}
          className="flex-1 min-h-0"
          virtualizerRef={virtualizerRef}
          minContentWidth={`${REGIONS_MIN_WIDTH}px`}
          onViewportScroll={(e) => {
            if (headerScrollRef.current) {
              headerScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          getItemKey={(region, index) => `${region.base_address}-${index}`}
          renderItem={(region) => {
            const highlighted = region.base_address === highlightedBase;
            return (
            <div
              data-testid="memory-region-row"
              data-base={region.base_address}
              data-highlighted={highlighted ? '' : undefined}
              onClick={() => handleRegionClick(region)}
              onContextMenu={(e) => openContextMenu(e, region)}
              className={cn(
                'flex items-center px-2 border-b hover:bg-accent cursor-pointer text-xs h-full whitespace-nowrap',
                highlighted && 'bg-primary/20',
              )}
            >
              <span className="font-mono w-40 shrink-0 truncate">{region.base_address}</span>
              <span className="font-mono w-40 shrink-0 truncate">{regionEndAddress(region)}</span>
              <span className="w-20 shrink-0 text-right">{region.region_size_formatted}</span>
              <span className="w-24 shrink-0 ml-2">{region.state}</span>
              <span className="w-24 shrink-0">{region.region_type}</span>
              <span className="w-28 shrink-0 truncate">{region.protect}</span>
              <span className="flex-1 flex items-center gap-1 overflow-hidden">
                {region.annotations.map((a, i) => {
                  const typeName = a.address ? KIND_TYPE_OVERLAY[a.kind] : undefined;
                  const onOpenType =
                    typeName && sessionData.onNavigateToType
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          sessionData.onNavigateToType!(typeName, a.address!);
                        }
                      : undefined;
                  return (
                    <Badge
                      key={`${a.kind}-${a.label}-${i}`}
                      size="xs"
                      variant="outline"
                      title={onOpenType ? `${a.label} — open ${typeName} in Types` : a.label}
                      className={cn(
                        KIND_BADGE_CLASS[a.kind] ?? '',
                        onOpenType && 'cursor-pointer hover:underline',
                      )}
                      onClick={onOpenType}
                    >
                      {a.label}
                    </Badge>
                  );
                })}
              </span>
            </div>
            );
          }}
        />
      ) : (
        <div className="flex-1 min-h-0">
          {error ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-base font-medium">{error}</p>
                <p className="text-sm mt-1">Memory regions will retry automatically</p>
              </div>
            </div>
          ) : !sessionData.canUseMemoryOps ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-base font-medium">Open or run a process to view memory regions</p>
              </div>
            </div>
          ) : isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <Loader2 className="h-12 w-12 mx-auto mb-4 opacity-50 animate-spin" />
                <p className="text-base font-medium">Loading memory regions...</p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
              <div className="text-center">
                <MemoryStick className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-base font-medium">No memory regions found</p>
                {sessionData.canUseMemoryOps && (
                  <p className="text-sm mt-1">Try adjusting the filters</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeContextMenu}>
          <ContextMenuItem
            icon={<Eye className="text-blue-400" />}
            onClick={() => onNavigateToAddress?.(contextMenu.data.base_address)}
          >
            View in Memory
          </ContextMenuItem>
          {sessionData.onNavigateToDisassembly && (
            <ContextMenuItem
              icon={<Code className="text-green-400" />}
              onClick={() => sessionData.onNavigateToDisassembly?.(contextMenu.data.base_address)}
            >
              View in Disassembly
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Copy />}
            onClick={() => copyToClipboard(contextMenu.data.base_address, 'base address')}
          >
            Copy Base Address
          </ContextMenuItem>
          <ContextMenuItem
            icon={<Copy />}
            onClick={() =>
              copyToClipboard(
                `${contextMenu.data.base_address}-${regionEndAddress(contextMenu.data)}`,
                'address range',
              )
            }
          >
            Copy Address Range
          </ContextMenuItem>
        </ContextMenu>
      )}
    </DockPanel>
  );
}
