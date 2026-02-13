import { createContext, useContext } from "react";
import { SerializableThreadContext } from "@/components/RegisterView";
import type { BreakpointState } from "@/hooks/useBreakpoints";

// Re-export for convenience in other components
export { type SerializableThreadContext } from "@/components/RegisterView";

export interface RawBreakpoint {
  id: string;
  address: number;
  module_name: string;
  module_offset: number;
  name: string | null;
  group: string | null;
  symbol: string | null;
  enabled: boolean;
  is_active: boolean;
}

export interface DebugSession {
  id: string;
  name: string;
  server_url: string;
  launch_command: string;
  is_local_run: boolean;
  status: SessionStatus;
  current_event: DebugEventInfo | null;
  created_at: string;
  disassembly_window_open: boolean;
  registers_window_open: boolean;
  callstack_window_open: boolean;
  breakpoints: RawBreakpoint[];
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
  is_function: boolean;
}

export type SessionStatus = 
  | "Stopped"
  | "Running"
  | "Paused"
  | { Error: string };

// Context for session data
export interface SessionContextData {
  session: DebugSession | null;
  displayStatus: SessionStatus;  // Debounced status for content views (prevents flicker on stepping)
  modules: Module[];
  threads: Thread[];
  loadModules: () => Promise<void>;
  loadThreads: () => Promise<void>;
  searchSymbols: (pattern: string, limit?: number) => Promise<Symbol[]>;
  breakpointState: BreakpointState;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
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