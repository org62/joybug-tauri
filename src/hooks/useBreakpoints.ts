import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RawBreakpoint } from '@/contexts/SessionContext';
import { invokeToggleBreakpoint } from '@/lib/sessionHelpers';

export type { RawBreakpoint } from '@/contexts/SessionContext';

export interface Breakpoint {
  id: string;
  address: string;       // hex string "0x..."
  module_name: string;
  module_offset: string;  // hex string "0x..."
  name: string | null;
  group: string | null;
  symbol: string | null;
  enabled: boolean;
  is_active: boolean;
  bp_kind: string;            // "software" | "hardware"
  hw_type: string | null;     // "Execute" | "Write" | "ReadWrite"
  hw_size: number | null;     // 1, 2, 4, 8
}

interface BreakpointsUpdatedPayload {
  session_id: string;
  breakpoints: RawBreakpoint[];
}

function convertBreakpoints(raw: RawBreakpoint[]): Breakpoint[] {
  return raw.map(bp => ({
    id: bp.id,
    address: `0x${bp.address.toString(16).toUpperCase()}`,
    module_name: bp.module_name,
    module_offset: `0x${bp.module_offset.toString(16).toUpperCase()}`,
    name: bp.name,
    group: bp.group,
    symbol: bp.symbol,
    enabled: bp.enabled,
    is_active: bp.is_active,
    bp_kind: bp.bp_kind ?? "software",
    hw_type: bp.hw_type ?? null,
    hw_size: bp.hw_size ?? null,
  }));
}

export function useBreakpoints(sessionId?: string, isPaused?: boolean, sessionBreakpoints?: RawBreakpoint[]) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([]);

  // Keep a ref to sessionBreakpoints so the isPaused effect can read the
  // latest value without adding it to the dependency array.
  const sessionBpRef = useRef(sessionBreakpoints);
  sessionBpRef.current = sessionBreakpoints;

  // Session cleanup / seed: clear when session ends or resumes,
  // seed from session context when isPaused becomes true.
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setBreakpoints([]);
    } else if (sessionBpRef.current && sessionBpRef.current.length > 0) {
      setBreakpoints(convertBreakpoints(sessionBpRef.current));
    }
  }, [sessionId, isPaused]);

  // Listen for breakpoints-updated events (real-time updates during pause)
  useEffect(() => {
    if (!sessionId) return;

    const unlistenUpdated = listen<BreakpointsUpdatedPayload>('breakpoints-updated', (event) => {
      if (event.payload.session_id === sessionId) {
        setBreakpoints(convertBreakpoints(event.payload.breakpoints));
      }
    });

    return () => {
      unlistenUpdated.then(f => f());
    };
  }, [sessionId]);

  const toggleBreakpoint = useCallback(async (address: string) => {
    if (!sessionId) return;
    try {
      await invokeToggleBreakpoint(sessionId, address);
    } catch (e) {
      console.error('Failed to toggle breakpoint:', e);
    }
  }, [sessionId]);

  const removeBreakpoint = useCallback(async (breakpointId: string) => {
    if (!sessionId) return;
    try {
      await invoke('remove_breakpoint', { sessionId, breakpointId });
    } catch (e) {
      console.error('Failed to remove breakpoint:', e);
    }
  }, [sessionId]);

  const enableBreakpoint = useCallback(async (breakpointId: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_breakpoint', { sessionId, breakpointId, enabled });
    } catch (e) {
      console.error('Failed to enable/disable breakpoint:', e);
    }
  }, [sessionId]);

  const enableBreakpointGroup = useCallback(async (group: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_breakpoint_group', { sessionId, group, enabled });
    } catch (e) {
      console.error('Failed to enable/disable breakpoint group:', e);
    }
  }, [sessionId]);

  const updateBreakpoint = useCallback(async (breakpointId: string, name?: string, group?: string) => {
    if (!sessionId) return;
    try {
      await invoke('update_breakpoint', { sessionId, breakpointId, name: name ?? null, group: group ?? null });
    } catch (e) {
      console.error('Failed to update breakpoint:', e);
    }
  }, [sessionId]);

  const setHardwareBreakpoint = useCallback(async (address: string, hwType: string, hwSize: number) => {
    if (!sessionId) return;
    try {
      await invoke('set_hardware_breakpoint', { sessionId, address, hwType, hwSize });
    } catch (e) {
      console.error('Failed to set hardware breakpoint:', e);
    }
  }, [sessionId]);

  return useMemo(() => ({
    breakpoints,
    toggleBreakpoint,
    removeBreakpoint,
    enableBreakpoint,
    enableBreakpointGroup,
    updateBreakpoint,
    setHardwareBreakpoint,
  }), [breakpoints, toggleBreakpoint, removeBreakpoint, enableBreakpoint, enableBreakpointGroup, updateBreakpoint, setHardwareBreakpoint]);
}

export type BreakpointState = ReturnType<typeof useBreakpoints>;
