import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SerializableThreadContext, RegisterDef, X64_REGISTERS, X64_DEBUG_REGISTERS, ARM64_REGISTERS } from '@/components/RegisterView';
import { DereferenceEntry, DereferenceResultPayload } from '@/lib/hexUtils';
import { SessionStatus } from '@/contexts/SessionContext';

/**
 * Hook to fetch dereference data for all registers
 * Shows what each register value points to in memory
 */
export function useRegisterDereference(
  context: SerializableThreadContext | undefined,
  sessionId: string | undefined,
  sessionStatus: SessionStatus | undefined,
  // DR0-DR3 point at HW-breakpoint targets; only fetch them when the debug
  // register section is visible to avoid backend round-trips on every pause.
  includeDebugRegisters = false
) {
  const [dereferenceData, setDereferenceData] = useState<Map<string, DereferenceEntry>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const pendingAddresses = useRef<Set<string>>(new Set());
  const requestedAddresses = useRef<Set<string>>(new Set());

  // Extract pointer-register values as addresses. The register defs'
  // showDereference flag encodes which registers hold pointers.
  const getRegisterAddresses = useCallback((ctx: SerializableThreadContext, includeDr: boolean): Map<string, string> => {
    let defs: RegisterDef[] = [];
    if (ctx.arch === 'X64') {
      defs = includeDr ? [...X64_REGISTERS, ...X64_DEBUG_REGISTERS] : X64_REGISTERS;
    } else if (ctx.arch === 'Arm64') {
      defs = ARM64_REGISTERS;
    }

    const registers = ctx as unknown as Record<string, string>;
    const addresses = new Map<string, string>();
    for (const { name, field, showDereference } of defs) {
      if (showDereference === false) continue;
      const value = registers[field];
      if (value && value !== '0x0000000000000000') {
        addresses.set(name, value);
      }
    }
    return addresses;
  }, []);

  // Normalize address to uppercase with 0x prefix
  const normalizeAddress = useCallback((addr: string): string => {
    let cleaned = addr.trim();
    if (cleaned.startsWith('0x') || cleaned.startsWith('0X')) {
      cleaned = cleaned.slice(2);
    }
    return '0x' + cleaned.toUpperCase().padStart(16, '0');
  }, []);

  // Request dereference for multiple addresses in a single batch command
  const requestDereferenceBatch = useCallback(async (addresses: string[]) => {
    if (!sessionId || addresses.length === 0) return;

    const normalized: string[] = [];
    for (const addr of addresses) {
      const n = normalizeAddress(addr);
      if (!pendingAddresses.current.has(n) && !requestedAddresses.current.has(n)) {
        pendingAddresses.current.add(n);
        normalized.push(n);
      }
    }

    if (normalized.length === 0) return;

    try {
      await invoke('request_dereference_batch', {
        sessionId,
        addresses: normalized,
      });
    } catch (err) {
      console.error(`Failed to batch dereference:`, err);
      for (const n of normalized) {
        pendingAddresses.current.delete(n);
      }
    }
  }, [sessionId, normalizeAddress]);

  // Set up event listener for dereference results
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    const setupListener = async () => {
      const unlisten = await listen<DereferenceResultPayload>('dereference-updated', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== sessionId) return;

        const baseAddr = normalizeAddress(event.payload.base_address);
        pendingAddresses.current.delete(baseAddr);
        requestedAddresses.current.add(baseAddr);

        // Add entries to the map
        setDereferenceData(prev => {
          const next = new Map(prev);
          for (const entry of event.payload.entries) {
            const entryAddr = normalizeAddress(entry.address);
            next.set(entryAddr, entry);
          }
          return next;
        });
      });

      return unlisten;
    };

    const cleanupPromise = setupListener();

    return () => {
      cancelled = true;
      cleanupPromise.then(fn => fn?.());
    };
  }, [sessionId, normalizeAddress]);

  // Request dereference for all registers when context changes
  useEffect(() => {
    if (!context || !sessionId || sessionStatus !== 'Paused') {
      return;
    }

    const addresses = getRegisterAddresses(context, includeDebugRegisters);

    // Clear previous state when context changes
    pendingAddresses.current.clear();
    requestedAddresses.current.clear();
    setDereferenceData(new Map());
    setIsLoading(true);

    // Send all addresses in a single batch command to avoid flooding the command queue
    const addressList = Array.from(addresses.values());
    requestDereferenceBatch(addressList).finally(() => {
      setIsLoading(false);
    });
  }, [context, sessionId, sessionStatus, includeDebugRegisters, getRegisterAddresses, requestDereferenceBatch]);

  // Reset when session stops
  useEffect(() => {
    if (sessionStatus === 'Stopped') {
      setDereferenceData(new Map());
      pendingAddresses.current.clear();
      requestedAddresses.current.clear();
    }
  }, [sessionStatus]);

  // Get dereference entry for a specific address
  const getDereferenceForAddress = useCallback((address: string): DereferenceEntry | undefined => {
    const normalized = normalizeAddress(address);
    return dereferenceData.get(normalized);
  }, [dereferenceData, normalizeAddress]);

  return {
    dereferenceData,
    isLoading,
    getDereferenceForAddress,
  };
}
