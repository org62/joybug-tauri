export interface SessionConfig {
  id: string;
  name: string;
  server_url: string;
  launch_command: string;
  created_at: string;
}

const SESSIONS_KEY = 'joybug-debug-sessions';

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
    sessions[index] = updatedSession;
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
    created_at: session.created_at,
  };
}

// Sync storage with current sessions (replaces entire storage)
export function syncSessionsToStorage(sessions: SessionConfig[]) {
  saveSessionsToStorage(sessions);
} 