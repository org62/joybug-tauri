import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RawBreakpoint } from '@/contexts/SessionContext';
import { invokeToggleBreakpoint, reportSessionError } from '@/lib/sessionHelpers';

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
  bp_kind: string;            // "software" | "hardware" | "watchpoint"
  hw_type: string | null;     // "Execute" | "Write" | "ReadWrite"
  hw_size: number | null;     // 1, 2, 4, 8
  tracing: boolean;           // derived: an active watchpoint is armed & collecting
  source_file: string | null; // resolved source file (display only)
  source_line: number | null; // resolved source line (display only)
  single_shot: boolean;       // one-shot: auto-removed after first hit
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
    tracing: (bp.bp_kind ?? "software") === "watchpoint" && bp.is_active,
    source_file: bp.source_file ?? null,
    source_line: bp.source_line ?? null,
    single_shot: bp.single_shot ?? false,
  }));
}

export function useBreakpoints(sessionId?: string, canUseMemoryOps?: boolean, sessionBreakpoints?: RawBreakpoint[]) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([]);

  // Keep a ref to sessionBreakpoints so the re-seed effect can read the
  // latest value without adding it to the dependency array.
  const sessionBpRef = useRef(sessionBreakpoints);
  sessionBpRef.current = sessionBreakpoints;

  // Seed from the session payload when the session appears and re-seed when a
  // process appears/disappears. Not gated on the status — persisted breakpoints
  // stay visible (and metadata-editable) while Stopped; only the session going
  // away clears them. Live edits arrive via breakpoints-updated (the backend
  // also emits it on process exit, marking every row inactive).
  useEffect(() => {
    if (!sessionId) {
      setBreakpoints([]);
    } else if (sessionBpRef.current && sessionBpRef.current.length > 0) {
      setBreakpoints(convertBreakpoints(sessionBpRef.current));
    }
  }, [sessionId, canUseMemoryOps]);

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

  const toggleBreakpoint = useCallback(async (address: string, singleShot = false) => {
    if (!sessionId) return;
    try {
      await invokeToggleBreakpoint(sessionId, address, singleShot);
    } catch (e) {
      reportSessionError('toggle breakpoint', e, sessionId);
    }
  }, [sessionId]);

  const removeBreakpoint = useCallback(async (breakpointId: string) => {
    if (!sessionId) return;
    try {
      await invoke('remove_breakpoint', { sessionId, breakpointId });
    } catch (e) {
      reportSessionError('remove breakpoint', e, sessionId);
    }
  }, [sessionId]);

  const removeBreakpoints = useCallback(async (breakpointIds: string[]) => {
    if (!sessionId) return;
    try {
      await invoke('remove_breakpoints', { sessionId, breakpointIds });
    } catch (e) {
      reportSessionError('remove breakpoints', e, sessionId);
    }
  }, [sessionId]);

  const enableBreakpoint = useCallback(async (breakpointId: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_breakpoint', { sessionId, breakpointId, enabled });
    } catch (e) {
      reportSessionError('enable/disable breakpoint', e, sessionId);
    }
  }, [sessionId]);

  const enableBreakpointGroup = useCallback(async (group: string, enabled: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('enable_breakpoint_group', { sessionId, group, enabled });
    } catch (e) {
      reportSessionError('enable/disable breakpoint group', e, sessionId);
    }
  }, [sessionId]);

  const updateBreakpoint = useCallback(async (breakpointId: string, name?: string, group?: string) => {
    if (!sessionId) return;
    try {
      await invoke('update_breakpoint', { sessionId, breakpointId, name: name ?? null, group: group ?? null });
    } catch (e) {
      reportSessionError('update breakpoint', e, sessionId);
    }
  }, [sessionId]);

  const setHardwareBreakpoint = useCallback(async (address: string, hwType: string, hwSize: number) => {
    if (!sessionId) return;
    try {
      await invoke('set_hardware_breakpoint', { sessionId, address, hwType, hwSize });
    } catch (e) {
      reportSessionError('set hardware breakpoint', e, sessionId);
    }
  }, [sessionId]);

  return useMemo(() => ({
    breakpoints,
    toggleBreakpoint,
    removeBreakpoint,
    removeBreakpoints,
    enableBreakpoint,
    enableBreakpointGroup,
    updateBreakpoint,
    setHardwareBreakpoint,
  }), [breakpoints, toggleBreakpoint, removeBreakpoint, removeBreakpoints, enableBreakpoint, enableBreakpointGroup, updateBreakpoint, setHardwareBreakpoint]);
}

export type BreakpointState = ReturnType<typeof useBreakpoints>;
