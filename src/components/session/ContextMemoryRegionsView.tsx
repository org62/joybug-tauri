import { useEffect, useState, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSessionContext } from '@/contexts/SessionContext';
import { AlertCircle, MemoryStick, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
  const isOpenRef = useRef(false);

  const fetchMemoryRegions = async () => {
    if (!sessionData?.session?.id) return;

    setError(null);
    setIsLoading(true);

    try {
      await invoke('request_memory_regions', {
        sessionId: sessionData.session.id,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  // Filter regions based on state and type filters
  const filteredRegions = useMemo(() => {
    return regions.filter(region => {
      // State filter
      if (stateFilter !== 'all') {
        const stateMatch: Record<string, string> = {
          committed: 'MEM_COMMIT',
          reserved: 'MEM_RESERVE',
          free: 'MEM_FREE',
        };
        if (region.state !== stateMatch[stateFilter]) return false;
      }

      // Type filter
      if (typeFilter !== 'all') {
        const typeMatch: Record<string, string> = {
          image: 'MEM_IMAGE',
          private: 'MEM_PRIVATE',
          mapped: 'MEM_MAPPED',
        };
        if (region.region_type !== typeMatch[typeFilter]) return false;
      }

      return true;
    });
  }, [regions, stateFilter, typeFilter]);

  // Auto-fetch memory regions on every pause if window is open
  useEffect(() => {
    if (sessionData?.session?.status === 'Paused' && isOpenRef.current) {
      fetchMemoryRegions();
    } else if (sessionData?.session?.status !== 'Paused') {
      setRegions([]);
      setError(null);
    }
  }, [sessionData?.session?.status, sessionData?.session?.current_event]);

  // Fetch memory regions when component first mounts if session is already paused
  useEffect(() => {
    if (sessionData?.session?.status === 'Paused' && sessionData?.session?.id) {
      fetchMemoryRegions();
    }
  }, [sessionData?.session?.id]);

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

  // Track if component is visible (mounted)
  useEffect(() => {
    isOpenRef.current = true;
    return () => {
      isOpenRef.current = false;
    };
  }, []);

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
    <div className="flex flex-col h-full">
      {/* Toolbar with filters */}
      <div className="p-2 border-b flex items-center gap-2 flex-wrap">
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
      <div className="flex items-center px-2 py-1 border-b bg-muted/50 text-xs font-medium text-muted-foreground">
        <span className="w-40">Base Address</span>
        <span className="w-20 text-right">Size</span>
        <span className="w-24 ml-2">State</span>
        <span className="w-24">Type</span>
        <span className="flex-1">Protection</span>
      </div>

      {/* Region list */}
      <div className="flex-1 overflow-auto">
        {filteredRegions.length > 0 ? (
          filteredRegions.map((region, index) => (
            <div
              key={`${region.base_address}-${index}`}
              onClick={() => handleRegionClick(region)}
              className="flex items-center px-2 py-1 border-b hover:bg-accent cursor-pointer text-xs"
            >
              <span className="font-mono w-40 truncate">{region.base_address}</span>
              <span className="w-20 text-right">{region.region_size_formatted}</span>
              <span className="w-24 ml-2">{region.state}</span>
              <span className="w-24">{region.region_type}</span>
              <span className="flex-1 truncate">{region.protect}</span>
            </div>
          ))
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">{error}</p>
              <p className="text-sm mt-1">Memory regions will retry automatically on next pause</p>
            </div>
          </div>
        ) : sessionData.session.status !== 'Paused' ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <div className="text-center">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">Session must be paused to view memory regions</p>
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
              {sessionData.session.status === 'Paused' && (
                <p className="text-sm mt-1">Try adjusting the filters</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
