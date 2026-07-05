import { useEffect, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { formatTauriError } from '@/lib/sessionHelpers';
import { AlertCircle, MemoryStick, Loader2 } from 'lucide-react';
import { VirtualizedList } from '@/components/ui/virtualized-list';
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
}

type StateFilter = 'all' | 'committed' | 'reserved' | 'free';
type TypeFilter = 'all' | 'image' | 'private' | 'mapped';

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

  // Handler for clicking a region to open in hex view
  const handleRegionClick = (region: MemoryRegion) => {
    if (onNavigateToAddress) {
      onNavigateToAddress(region.base_address);
    }
  };

  if (!sessionData?.session) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No session available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar with filters */}
      <div className="p-2 border-b flex items-center gap-2 flex-wrap shrink-0">
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

        <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
          <SelectTrigger size="sm" className="w-28">
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
          <SelectTrigger size="sm" className="w-28">
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
      </div>

      {/* Table header */}
      <div className="flex items-center px-2 py-1 border-b bg-muted/50 text-xs font-medium text-muted-foreground shrink-0">
        <span className="w-40">Base Address</span>
        <span className="w-20 text-right">Size</span>
        <span className="w-24 ml-2">State</span>
        <span className="w-24">Type</span>
        <span className="flex-1">Protection</span>
      </div>

      {/* Region list (virtualized) */}
      {filteredRegions.length > 0 ? (
        <VirtualizedList
          items={filteredRegions}
          rowHeight={REGION_ROW_HEIGHT}
          overscan={20}
          className="flex-1 min-h-0"
          getItemKey={(region, index) => `${region.base_address}-${index}`}
          renderItem={(region) => (
            <div
              onClick={() => handleRegionClick(region)}
              className="flex items-center px-2 border-b hover:bg-accent cursor-pointer text-xs h-full"
            >
              <span className="font-mono w-40 truncate">{region.base_address}</span>
              <span className="w-20 text-right">{region.region_size_formatted}</span>
              <span className="w-24 ml-2">{region.state}</span>
              <span className="w-24">{region.region_type}</span>
              <span className="flex-1 truncate">{region.protect}</span>
            </div>
          )}
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
    </div>
  );
}
