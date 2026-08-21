import { invoke } from '@tauri-apps/api/core';
import { addSessionToStorage, touchSessionInStorage } from '@/lib/sessionStorage';
import { buildLaunchCommand, moduleBasename, pathDirname } from '@/lib/sessionHelpers';

export interface SessionRecordConfig {
  name: string;
  serverUrl: string;
  launchCommand: string;
  workingDirectory: string | null;
  isLocalRun: boolean;
}

/**
 * Backend create + localStorage persistence for a debug session. Shared by the
 * Debugger page's new-session dialog and every drag-drop launch path so the
 * two can't drift. Returns the new session id.
 */
export async function createSessionRecord(cfg: SessionRecordConfig): Promise<string> {
  const sessionId = await invoke<string>('create_debug_session', {
    name: cfg.name,
    serverUrl: cfg.serverUrl,
    launchCommand: cfg.launchCommand,
    workingDirectory: cfg.workingDirectory,
    isLocalRun: cfg.isLocalRun,
    attachPid: null,
  });

  addSessionToStorage({
    id: sessionId,
    name: cfg.name,
    server_url: cfg.serverUrl,
    launch_command: cfg.launchCommand,
    working_directory: cfg.workingDirectory,
    is_local_run: cfg.isLocalRun,
    created_at: new Date().toISOString(),
  });

  return sessionId;
}

/**
 * Create a local-run session (embedded debug server) for an executable and
 * start it. The caller navigates to `/session/<id>` with the returned id.
 */
export async function launchExecutable(exePath: string): Promise<string> {
  const sessionId = await createSessionRecord({
    name: moduleBasename(exePath).replace(/\.exe$/i, ''),
    serverUrl: '',
    launchCommand: buildLaunchCommand(exePath),
    workingDirectory: pathDirname(exePath) || null,
    isLocalRun: true,
  });
  await invoke('start_debug_session', { sessionId });
  touchSessionInStorage(sessionId);
  return sessionId;
}
