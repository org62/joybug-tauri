import { createContext, useContext } from "react";
import { SerializableThreadContext } from "@/components/RegisterView";

// Re-export for convenience in other components
export { type SerializableThreadContext } from "@/components/RegisterView";

export interface DebugSession {
  id: string;
  name:string;
  server_url: string;
  launch_command: string;
  status: SessionStatus;
  current_event: DebugEventInfo | null;
  created_at: string;
}

export interface DebugEventInfo {
  event_type: string;
  process_id: number;
  thread_id: number;
  details: string;
  can_continue: boolean;
  address?: number;
  context?: SerializableThreadContext;
}

export interface Module {
  name: string;
  base_address: string;
  size: number;
  path: string;
}

export interface Thread {
  id: number;
  status: string;
  start_address: string;
}

export interface Symbol {
  name: string;
  module_name: string;
  rva: number;
  va: string;
  display_name: string;
}

export type SessionStatus = 
  | "Created"
  | "Connecting" 
  | "Connected"
  | "Running"
  | "Paused"
  | "Finished"
  | { Error: string };

// Context for session data
export interface SessionContextData {
  session: DebugSession | null;
  modules: Module[];
  threads: Thread[];
  loadModules: () => Promise<void>;
  loadThreads: () => Promise<void>;
  searchSymbols: (pattern: string, limit?: number) => Promise<Symbol[]>;
}

export const SessionContext = createContext<SessionContextData | null>(null);

// Hook to use session context
export const useSessionContext = () => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSessionContext must be used within a SessionProvider");
  }
  return context;
}; 