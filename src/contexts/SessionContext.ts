import { createContext, useContext } from "react";
import { SerializableThreadContext } from "@/components/RegisterView";
import type { BreakpointState } from "@/hooks/useBreakpoints";
import type { PatchState } from "@/hooks/usePatches";
import type { BookmarkState } from "@/hooks/useBookmarks";
import type { WatchpointTraceState } from "@/hooks/useWatchpointTrace";
import type { SandboxLaunchConfig, EtwConfig } from "@/lib/sandbox";
import type { CallStackFrame } from "@/components/CallStackFrameList";

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
  single_shot?: boolean;      // one-shot: auto-removed after first hit
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
  /** Extra env vars merged over the debugger's environment at launch; null inherits. */
  environment: [string, string][] | null;
  is_local_run: boolean;
  attach_pid: number | null;
  non_invasive: boolean;
  /** Windows Sandbox config when this session runs its target in a sandbox. */
  sandbox: SandboxLaunchConfig | null;
  /** Session-level (host) ETW config; present ⇒ the ETW panel is active. */
  etw: EtwConfig | null;
  status: SessionStatus;
  current_event: DebugEventInfo | null;
  /** Thread the user switched to while paused (null = event thread). */
  selected_thread_id?: number | null;
  /** Target instruction-set architecture once a process exists ("X86" for a
   *  WOW64 target); null before launch/attach/open. */
  arch?: "X64" | "Arm64" | "X86" | null;
  /** Target pointer width in bytes: 4 for WOW64, else 8 (also 8 while unknown). */
  pointer_size?: number;
  created_at: string;
  disassembly_window_open: boolean;
  registers_window_open: boolean;
  callstack_window_open: boolean;
  breakpoints: RawBreakpoint[];
  patches: RawPatch[];
  bookmarks: ResolvedBookmark[];
}

/** Decoded exception record + callstack, built by the backend for every
 *  `Exception` event (see `session/exceptions.rs`). Addresses are `0x…`
 *  strings at the target's pointer width. */
export interface ExceptionDetail {
  code: number;
  /** Symbolic name (EXCEPTION_ACCESS_VIOLATION) when the code is known. */
  name: string | null;
  first_chance: boolean;
  address: string;
  /** `module!symbol+0x..` or `module+0x..` for the faulting address. */
  address_symbol: string | null;
  /** "read" | "write" | "execute" — access violations / in-page errors only. */
  access: string | null;
  referenced_address: string | null;
  referenced_symbol: string | null;
  /** In-page error only: the NTSTATUS behind the fault. */
  nt_status: number | null;
  parameters: string[];
  callstack: CallStackFrame[];
  /** `write to 0xDEAD0000 (mod!sym+0x10)` for a memory fault, composed by the
   *  backend so the log line and the UI never word it differently. */
  access_clause: string | null;
}

export interface DebugEventInfo {
  event_type: string;
  process_id: number;
  /** Thread that raised the event. The thread whose context is displayed is
   *  `DebugSession.selected_thread_id`, falling back to this. */
  thread_id: number;
  details: string;
  can_continue: boolean;
  address?: number;
  context?: SerializableThreadContext;
  exception_code?: number;
  exception_first_chance?: boolean;
  /** Present on `Exception` events. */
  exception?: ExceptionDetail;
}

export interface Module {
  name: string;
  base_address: string;
  size: number;
  path: string;
}

export type SymbolStatusKind = "loaded" | "exports_only" | "loading" | "failed" | "not_requested";

/** The module has symbols usable for search/resolution (full PDB or the PE-export fallback). */
export const hasUsableSymbols = (status: SymbolStatusKind | undefined): boolean =>
  status === "loaded" || status === "exports_only";

/** The PDB is still missing (download failed, or only exports loaded) — retry applies. */
export const isPdbMissing = (status: SymbolStatusKind | undefined): boolean =>
  status === "failed" || status === "exports_only";

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
  start_address: string;
  /** Live SuspendThread nesting count; 0 = runnable. The view derives the
   *  "Running"/"Suspended" label from it. */
  suspend_count: number;
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
  | "Provisioning"
  | "Paused"
  | "Open"
  | { Error: string };

// Context for session data
export interface SessionContextData {
  session: DebugSession | null;
  displayStatus: SessionStatus;  // Debounced status for content views (prevents flicker on stepping)
  /** True when the target is paused at a debug event: stepping, register edits
   * and applying/undoing patch bytes need this. See the policy table in
   * `lib/sessionHelpers.ts`. */
  isPaused: boolean;
  /** True when memory/enumeration ops are usable: paused, running (invasive), or a
   * non-invasive Open session. These ops run over OOB and don't need a pause. */
  canUseMemoryOps: boolean;
  /** Pid of the process the live data belongs to, or undefined with no process.
   * Cached results (scans) key on this so they drop when the target restarts —
   * their addresses belong to the dead process. */
  processId: number | undefined;
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
  unloadModuleSymbols: (baseAddress: string) => Promise<void>;
  searchSymbols: (pattern: string, limit?: number) => Promise<Symbol[]>;
  breakpointState: BreakpointState;
  patchState: PatchState;
  bookmarkState: BookmarkState;
  watchpointState: WatchpointTraceState;
  onNavigateToDisassembly?: (address: string) => void;
  onNavigateToMemory?: (address: string) => void;
  /** Activate the Memory Regions tab and highlight the region containing address. */
  onNavigateToMemoryRegion?: (address: string) => void;
  /** Activate the Source tab and reveal the given address's source line. */
  onNavigateToSource?: (address: string) => void;
  /** Open the Types tab with a named type overlaid on an address (e.g. a thread's
   *  TEB → `("_TEB", tebAddress)`). */
  onNavigateToType?: (typeName: string, address: string) => void;
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