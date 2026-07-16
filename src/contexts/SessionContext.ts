import { createContext, useContext } from "react";
import { SerializableThreadContext } from "@/components/RegisterView";
import type { BreakpointState } from "@/hooks/useBreakpoints";
import type { PatchState } from "@/hooks/usePatches";
import type { BookmarkState } from "@/hooks/useBookmarks";
import type { WatchpointTraceState } from "@/hooks/useWatchpointTrace";

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
  bp_kind: string;            // "software" | "hardware" | "watchpoint"
  hw_type: string | null;     // "Execute" | "Write" | "ReadWrite"
  hw_size: number | null;     // 1, 2, 4, 8
  source_file: string | null;
  source_line: number | null;
}

export interface RawPatch {
  id: string;
  address: number;
  module_name: string;
  module_offset: number;
  original_bytes: number[];
  patched_bytes: number[];
  assembly_text: string;
  original_disassembly: string;
  enabled: boolean;
  is_applied: boolean;
  group: string | null;
}

/** A bookmark resolved for display (sent in the session snapshot and bookmarks-updated events). */
export interface ResolvedBookmark {
  id: string;
  kind: string;                    // "value" | "pointer" | "code"
  module_name: string | null;
  module_offset: number | null;
  raw_address: string | null;
  name: string | null;
  comment: string | null;
  group: string | null;
  value_type: string | null;
  pointer_offsets: number[] | null;
  base_symbol: string | null;
  asm_text: string | null;
  locked: boolean;
  resolved_address: string;        // "0x.." | "mod+0x.." | ""
  is_resolved: boolean;
  current_value: string | null;
}

export interface DebugSession {
  id: string;
  name: string;
  server_url: string;
  launch_command: string;
  working_directory: string | null;
  is_local_run: boolean;
  attach_pid: number | null;
  non_invasive: boolean;
  status: SessionStatus;
  current_event: DebugEventInfo | null;
  created_at: string;
  disassembly_window_open: boolean;
  registers_window_open: boolean;
  callstack_window_open: boolean;
  breakpoints: RawBreakpoint[];
  patches: RawPatch[];
  bookmarks: ResolvedBookmark[];
}

export interface DebugEventInfo {
  event_type: string;
  process_id: number;
  thread_id: number;
  details: string;
  can_continue: boolean;
  address?: number;
  context?: SerializableThreadContext;
  exception_code?: number;
  exception_first_chance?: boolean;
}

export interface Module {
  name: string;
  base_address: string;
  size: number;
  path: string;
}

export type SymbolStatusKind = "loaded" | "loading" | "failed" | "not_requested";

export interface ModuleSymbolStatus {
  module_path: string;
  base_address: string;
  status: SymbolStatusKind;
  symbol_count?: number | null;
  error?: string | null;
  pdb_path?: string | null;
}

export interface PdbLoadResult {
  loaded: boolean;
  symbol_count?: number | null;
  mismatch?: {
    pe_guid: string;
    pe_age: number;
    pdb_guid: string;
    pdb_age: number;
  } | null;
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
  | "Open"
  | { Error: string };

// Context for session data
export interface SessionContextData {
  session: DebugSession | null;
  displayStatus: SessionStatus;  // Debounced status for content views (prevents flicker on stepping)
  /** True when memory/enumeration ops are usable: paused, running (invasive), or a
   * non-invasive Open session. These ops run over OOB and don't need a pause. */
  canUseMemoryOps: boolean;
  modules: Module[];
  threads: Thread[];
  symbolStatuses: ModuleSymbolStatus[];
  /** Identity of the set of modules with loaded symbols; changes when background
   * symbol loading completes so views can refresh symbol-derived data. */
  symbolsRefreshKey: string;
  loadModules: () => Promise<Module[]>;
  loadThreads: () => Promise<Thread[]>;
  loadModulePdb: (baseAddress: string, pdbPath: string, force: boolean) => Promise<PdbLoadResult>;
  retryModuleSymbols: (baseAddress: string) => Promise<void>;
  searchSymbols: (pattern: string, limit?: number) => Promise<Symbol[]>;
  breakpointState: BreakpointState;
  patchState: PatchState;
  bookmarkState: BookmarkState;
  watchpointState: WatchpointTraceState;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
  /** Activate the Source tab and reveal the given address's source line. */
  onNavigateToSource?: (address: string) => void;
  /** Start a hardware access trace ("find what reads/writes this address"): arm a
   * watchpoint of the given mode/size and open the Access Trace panel. */
  onFindAccesses?: (address: string, mode: "Write" | "ReadWrite", size: number) => void;
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