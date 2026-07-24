export interface SessionConfig {
  id: string;
  name: string;
  server_url: string;
  launch_command: string;
  working_directory?: string | null;
  is_local_run: boolean;
  created_at: string;
  last_used_at?: string | null;
}

const SESSIONS_KEY = 'joybug-debug-sessions';

// Sessions are re-created with fresh IDs on every app restart, so cross-restart
// matching is by content, mirroring restoreSessionsFromStorage.
function contentKey(s: Pick<SessionConfig, 'name' | 'launch_command' | 'is_local_run'>): string {
  return `${s.name}\0${s.launch_command}\0${s.is_local_run}`;
}

export function saveSessionsToStorage(sessions: SessionConfig[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function loadSessionsFromStorage(): SessionConfig[] {
  try {
    const data = localStorage.getItem(SESSIONS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Failed to load sessions from storage:', error);
    return [];
  }
}

export function addSessionToStorage(session: SessionConfig) {
  const sessions = loadSessionsFromStorage();
  // Remove any existing session with the same ID to avoid duplicates
  const filtered = sessions.filter(s => s.id !== session.id);
  filtered.push(session);
  saveSessionsToStorage(filtered);
}

export function updateSessionInStorage(updatedSession: SessionConfig) {
  const sessions = loadSessionsFromStorage();
  const index = sessions.findIndex(s => s.id === updatedSession.id);
  if (index !== -1) {
    sessions[index] = {
      ...updatedSession,
      last_used_at: updatedSession.last_used_at ?? sessions[index].last_used_at,
    };
    saveSessionsToStorage(sessions);
  }
}

// Record that a session was just started/viewed, for most-recently-used ordering.
export function touchSessionInStorage(sessionId: string) {
  const sessions = loadSessionsFromStorage();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.last_used_at = new Date().toISOString();
    saveSessionsToStorage(sessions);
  }
}

export function removeSessionFromStorage(sessionId: string) {
  const sessions = loadSessionsFromStorage();
  const filtered = sessions.filter(s => s.id !== sessionId);
  saveSessionsToStorage(filtered);
}

// Helper to convert DebugSession to SessionConfig
export function sessionToConfig(session: any): SessionConfig {
  return {
    id: session.id,
    name: session.name,
    server_url: session.server_url,
    launch_command: session.launch_command,
    working_directory: session.working_directory ?? null,
    is_local_run: session.is_local_run ?? false,
    created_at: session.created_at,
  };
}

// Sync storage with current sessions (replaces entire storage). Carries
// last_used_at over from the previous storage — by ID within a run, by content
// across restarts (IDs change).
export function syncSessionsToStorage(sessions: SessionConfig[]) {
  const existing = loadSessionsFromStorage();
  const byId = new Map(existing.map(s => [s.id, s]));
  const byContent = new Map(existing.map(s => [contentKey(s), s]));
  const merged = sessions.map(s => {
    const prev = byId.get(s.id) ?? byContent.get(contentKey(s));
    if (!prev) return s;
    // Keep the previously-stored created_at: addSessionToStorage records it at
    // millisecond precision, whereas the backend's created_at is only
    // second-granular, so preserving it keeps same-second creations orderable.
    return {
      ...s,
      created_at: prev.created_at ?? s.created_at,
      last_used_at: s.last_used_at ?? prev.last_used_at,
    };
  });
  saveSessionsToStorage(merged);
} 