import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { reportSessionError } from '@/lib/sessionHelpers';
import { useSnapshotOnPause } from '@/hooks/useSnapshotOnPause';

/** The backend takes handle/HWND values as hex strings. */
const hexArg = (n: number) => `0x${n.toString(16)}`;

export interface HandleInfo {
  handle: number;
  type_index: number;
  type_name: string;
  granted_access: number;
  attributes: number;
  name: string;
}

export interface WindowInfo {
  handle: number;
  parent: number;
  thread_id: number;
  style: number;
  style_ex: number;
  wnd_proc: number;
  enabled: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  title: string;
  class_name: string;
}

export interface TcpConnectionInfo {
  local_address: string;
  local_port: number;
  remote_address: string;
  remote_port: number;
  state: string;
}

export type PrivilegeState = 'Disabled' | 'Enabled' | 'EnabledByDefault';

export interface PrivilegeInfo {
  name: string;
  state: PrivilegeState;
}

/** Result of `get_process_objects` — everything the Handles window shows. */
export interface ProcessObjects {
  handles: HandleInfo[];
  windows: WindowInfo[];
  tcp_connections: TcpConnectionInfo[];
  privileges: PrivilegeInfo[];
  desktop_window: number;
  warnings: string[];
}

/**
 * The Handles window's data. A snapshot is taken on every pause, once when the
 * target first becomes reachable, and on demand — not polled: naming a few
 * hundred handles is a few hundred `NtQueryObject` calls on the server, too
 * heavy for the 500ms live cadence the Threads view uses.
 */
export function useProcessObjects(sessionId?: string, canRefresh?: boolean, isPaused?: boolean) {
  const [objects, setObjects] = useState<ProcessObjects | null>(null);
  const [loading, setLoading] = useState(false);
  // Concurrency guard for the two refresh edges in `useSnapshotOnPause` (an
  // already-paused target fires both). `loading` can't serve: reading it here
  // would put it in `refresh`'s deps and churn the effect.
  const inFlight = useRef(false);

  // Live data: drop it when the process goes away.
  useEffect(() => {
    if (!sessionId || !canRefresh) {
      setObjects(null);
      setLoading(false);
    }
  }, [sessionId, canRefresh]);

  const refresh = useCallback(async () => {
    if (!sessionId || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const result = await invoke<ProcessObjects>('get_process_objects', { sessionId });
      setObjects(result);
    } catch (e) {
      reportSessionError('enumerate process handles', e, sessionId);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [sessionId]);

  useSnapshotOnPause(sessionId, canRefresh, isPaused, refresh);

  /** Run one mutation against the target, then re-snapshot to show its effect. */
  const mutate = useCallback(async (what: string, command: string, args: Record<string, unknown>) => {
    if (!sessionId) return;
    try {
      await invoke(command, { sessionId, ...args });
      await refresh();
    } catch (e) {
      reportSessionError(what, e, sessionId);
    }
  }, [sessionId, refresh]);

  const closeHandle = useCallback(
    (handle: number) => mutate('close handle', 'close_process_handle', { handle: hexArg(handle) }),
    [mutate],
  );

  const setPrivilege = useCallback(
    (name: string, enable: boolean) =>
      mutate(`${enable ? 'enable' : 'disable'} ${name}`, 'set_process_privilege', { name, enable }),
    [mutate],
  );

  const setWindowEnabled = useCallback(
    (hwnd: number, enabled: boolean) =>
      mutate(`${enabled ? 'enable' : 'disable'} window`, 'set_process_window_enabled', { hwnd: hexArg(hwnd), enabled }),
    [mutate],
  );

  return useMemo(
    () => ({ objects, loading, refresh, closeHandle, setPrivilege, setWindowEnabled }),
    [objects, loading, refresh, closeHandle, setPrivilege, setWindowEnabled],
  );
}
