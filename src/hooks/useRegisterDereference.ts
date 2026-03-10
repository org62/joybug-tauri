import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SerializableThreadContext } from '@/components/RegisterView';
import { DereferenceEntry, DereferenceResultPayload } from '@/lib/hexUtils';
import { SessionStatus } from '@/contexts/SessionContext';

/**
 * Hook to fetch dereference data for all registers
 * Shows what each register value points to in memory
 */
export function useRegisterDereference(
  context: SerializableThreadContext | undefined,
  sessionId: string | undefined,
  sessionStatus: SessionStatus | undefined
) {
  const [dereferenceData, setDereferenceData] = useState<Map<string, DereferenceEntry>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const pendingAddresses = useRef<Set<string>>(new Set());
  const requestedAddresses = useRef<Set<string>>(new Set());

  // Extract all register values as addresses
  const getRegisterAddresses = useCallback((ctx: SerializableThreadContext): Map<string, string> => {
    const addresses = new Map<string, string>();

    if (ctx.arch === 'X64') {
      const regs: [string, string][] = [
        ['RAX', ctx.rax], ['RBX', ctx.rbx], ['RCX', ctx.rcx], ['RDX', ctx.rdx],
        ['RSI', ctx.rsi], ['RDI', ctx.rdi], ['RBP', ctx.rbp], ['RSP', ctx.rsp],
        ['RIP', ctx.rip],
        ['R8', ctx.r8], ['R9', ctx.r9], ['R10', ctx.r10], ['R11', ctx.r11],
        ['R12', ctx.r12], ['R13', ctx.r13], ['R14', ctx.r14], ['R15', ctx.r15],
      ];
      // Skip eflags - it's not a pointer
      for (const [name, value] of regs) {
        if (value && value !== '0x0000000000000000') {
          addresses.set(name, value);
        }
      }
    } else if (ctx.arch === 'Arm64') {
      const regs: [string, string][] = [
        ['X0', ctx.x0], ['X1', ctx.x1], ['X2', ctx.x2], ['X3', ctx.x3],
        ['X4', ctx.x4], ['X5', ctx.x5], ['X6', ctx.x6], ['X7', ctx.x7],
        ['X8', ctx.x8], ['X9', ctx.x9], ['X10', ctx.x10], ['X11', ctx.x11],
        ['X12', ctx.x12], ['X13', ctx.x13], ['X14', ctx.x14], ['X15', ctx.x15],
        ['X16', ctx.x16], ['X17', ctx.x17], ['X18', ctx.x18], ['X19', ctx.x19],
        ['X20', ctx.x20], ['X21', ctx.x21], ['X22', ctx.x22], ['X23', ctx.x23],
        ['X24', ctx.x24], ['X25', ctx.x25], ['X26', ctx.x26], ['X27', ctx.x27],
        ['X28', ctx.x28], ['FP', ctx.x29], ['LR', ctx.x30],
        ['SP', ctx.sp], ['PC', ctx.pc],
      ];
      // Skip cpsr - it's not a pointer
      for (const [name, value] of regs) {
        if (value && value !== '0x0000000000000000') {
          addresses.set(name, value);
        }
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

    const addresses = getRegisterAddresses(context);

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
  }, [context, sessionId, sessionStatus, getRegisterAddresses, requestDereferenceBatch]);

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
