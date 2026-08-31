// Windows Sandbox run-mode types + helpers, shared by the session-creation
// dialog, the create funnel, and session persistence.
//
// Wire shape mirrors the Rust `SandboxSettings` (serde snake_case) so it can be
// passed straight through `invoke("create_debug_session", { sandbox })`.

export interface SandboxMount {
  /** Host folder mapped into the guest. */
  host_path: string;
  /** Mount read-only (default for the target's own image/data). */
  read_only: boolean;
}

/** What the ETW tracer records. Mirrors the Rust `EtwCapture`. */
export interface EtwCaptureConfig {
  /** Explicit per-operation token set; empty ⇒ the tracer's built-in default. */
  ops: string[];
}

/**
 * ETW capture config. Mirrors the Rust `EtwConfig`. Its presence on a session
 * (`session.etw`) means host ETW is collected for that target; sandbox sessions
 * nest the same shape inside the sandbox config (gated by `collect_etw`).
 */
export interface EtwConfig {
  capture: EtwCaptureConfig;
  /** Collect callstacks on recorded events (heavier). */
  callstacks: boolean;
}

export interface SandboxLaunchConfig {
  mounts: SandboxMount[];
  memory_mb: number;
  collect_etw: boolean;
  /** What the ETW tracer records. */
  etw: EtwConfig;
  /** Attach the debugger (true) or just run the target under ETW (false). */
  debug: boolean;
}

/** Last path component of a host path (handles both separators). */
export function sandboxBasename(hostPath: string): string {
  const trimmed = hostPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base || "mount";
}

/**
 * Guest mount point a host folder lands at inside the sandbox
 * (`C:\mounts\<basename>`), deduping basename collisions against `preceding`
 * mounts. Mirrors the backend's `resolve_mounts` so the dialog hint and the
 * actual mapping agree. Pass the mounts that appear *before* this one.
 */
export function guestPathForMount(hostPath: string, preceding: SandboxMount[]): string {
  const base = sandboxBasename(hostPath);
  const taken = preceding.map((m) => sandboxBasename(m.host_path).toLowerCase());
  let name = base;
  let n = 2;
  while (taken.includes(name.toLowerCase())) {
    name = `${base}-${n}`;
    n += 1;
  }
  return `C:\\mounts\\${name}`;
}

