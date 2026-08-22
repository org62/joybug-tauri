// Shared "what sessions exist and what are they doing" store.
//
// Two things above the router outlet need this: the command palette's session
// entries (App.tsx) and the header's active-session pill. Neither can use
// `useDebugSession` — that hook is per-session and heavyweight (1s polling of
// session/modules/threads plus symbol status), so a second mount would double
// all of it. And `SessionContext` only exists inside the /session/:id subtree.
//
// So: one module-level store, subscribed via useSyncExternalStore — the same
// pattern as lib/navigationStore.ts. Tauri listeners attach on the first
// subscriber and detach on the last, so nothing runs when nobody is watching.
//
// `session-updated` fires on *every* step and carries the whole session
// snapshot. We keep only the id/name/status triple and replace the array only
// when a triple actually changed, so stepping doesn't re-render the header.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DebugSession, SessionStatus } from "@/contexts/SessionContext";

export interface SessionSummary {
  id: string;
  name: string;
  status: SessionStatus;
  /** Carried so consumers can fall back to the executable for unnamed
   *  sessions — see sessionDisplayName in lib/sessionHelpers. */
  launch_command: string | null;
  attach_pid: number | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: SessionSummary[] = [];
let unlisteners: UnlistenFn[] = [];
// Bumped on every detach. `listen()` resolves asynchronously, so a
// subscribe-then-immediately-unsubscribe would otherwise land its unlisten
// callback in the array *after* detach() emptied it, leaking the listener.
let epoch = 0;

/** Status equality that also covers the `{ Error: string }` variant. */
function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.Error === b.Error;
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.launch_command === b.launch_command &&
    a.attach_pid === b.attach_pid &&
    sameStatus(a.status, b.status)
  );
}

function emit() {
  listeners.forEach((l) => l());
}

/** Replace the snapshot only if it differs — keeps the reference stable for
 *  useSyncExternalStore and stops step-rate churn from reaching React. */
function commit(next: SessionSummary[]) {
  if (
    next.length === snapshot.length &&
    next.every((s, i) => sameSummary(s, snapshot[i]))
  ) {
    return;
  }
  snapshot = next;
  emit();
}

async function refetch() {
  try {
    const sessions = await invoke<DebugSession[]>("get_debug_sessions");
    commit(sessions.map(toSummary));
  } catch {
    // Backend not ready yet — the next session-updated event will fill this in.
  }
}

function toSummary(s: DebugSession): SessionSummary {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    launch_command: s.launch_command ?? null,
    attach_pid: s.attach_pid ?? null,
  };
}

function upsert(session: DebugSession) {
  const entry = toSummary(session);
  const index = snapshot.findIndex((s) => s.id === entry.id);
  if (index === -1) {
    commit([...snapshot, entry]);
    return;
  }
  if (sameSummary(snapshot[index], entry)) return;
  const next = snapshot.slice();
  next[index] = entry;
  commit(next);
}

function attach() {
  const mine = epoch;
  const keep = (un: UnlistenFn) => {
    if (mine === epoch) unlisteners.push(un);
    else un();
  };
  refetch();
  listen<DebugSession>("session-updated", (e) => upsert(e.payload))
    .then(keep)
    .catch(() => {});
  // Removal isn't carried by a payload we can trust to be a full session, and
  // it's rare — just resync.
  listen("session-removed", () => refetch())
    .then(keep)
    .catch(() => {});
}

function detach() {
  epoch++;
  unlisteners.forEach((un) => un());
  unlisteners = [];
}

export function subscribeToSessionRoster(onStoreChange: Listener): () => void {
  const first = listeners.size === 0;
  listeners.add(onStoreChange);
  if (first) attach();
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) detach();
  };
}

export function getSessionRosterSnapshot(): SessionSummary[] {
  return snapshot;
}
