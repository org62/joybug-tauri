import type { Thread } from '@/contexts/SessionContext';

const TICKS_PER_SECOND = 10_000_000n;
const FILETIME_UNIX_EPOCH_SECONDS = 11_644_473_600n;
export const UNAVAILABLE_THREAD_VALUE = '—';

/** Cumulative time, not a wall clock: hours are deliberately unbounded. */
export function formatThreadTime(ticks: string | null): string {
  if (ticks === null) return UNAVAILABLE_THREAD_VALUE;
  const value = BigInt(ticks);
  const seconds = value / TICKS_PER_SECOND;
  const hours = (seconds / 3600n).toString().padStart(2, '0');
  const minutes = ((seconds / 60n) % 60n).toString().padStart(2, '0');
  const remainder = (seconds % 60n).toString().padStart(2, '0');
  return `${hours}:${minutes}:${remainder}.${(value % TICKS_PER_SECOND).toString().padStart(7, '0')}`;
}

/** Retain all seven FILETIME fractional digits, including before the Unix epoch. */
export function formatThreadCreationTime(ticks: string | null): string {
  if (ticks === null) return UNAVAILABLE_THREAD_VALUE;
  const value = BigInt(ticks);
  const unixTicks = value - FILETIME_UNIX_EPOCH_SECONDS * TICKS_PER_SECOND;
  // BigInt division truncates toward zero; Date needs floor for pre-1970 values.
  const milliseconds = unixTicks >= 0n ? unixTicks / 10_000n : (unixTicks - 9_999n) / 10_000n;
  const date = new Date(Number(milliseconds));
  if (!Number.isFinite(date.getTime())) return UNAVAILABLE_THREAD_VALUE;
  const fraction = (value % TICKS_PER_SECOND).toString().padStart(7, '0');
  return date.toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}

export function formatThreadCycles(cycles: string | null): string {
  return cycles === null ? UNAVAILABLE_THREAD_VALUE : BigInt(cycles).toString();
}

export function formatThreadLastError(error: number | null): string {
  return error === null ? UNAVAILABLE_THREAD_VALUE : `0x${error.toString(16).padStart(8, '0')}`;
}

const PRIORITIES: Readonly<Record<number, string>> = {
  [-15]: 'Idle', [-2]: 'Lowest', [-1]: 'Below normal', [0]: 'Normal',
  [1]: 'Above normal', [2]: 'Highest', [15]: 'Time critical',
};

export function formatThreadPriority(priority: number | null): string {
  if (priority === null) return UNAVAILABLE_THREAD_VALUE;
  return PRIORITIES[priority] ? `${PRIORITIES[priority]} (${priority})` : String(priority);
}

// KWAIT_REASON from installed windows-sys 0.59 Wdk::System::SystemServices.
const WAIT_REASONS = [
  'Executive', 'FreePage', 'PageIn', 'PoolAllocation', 'DelayExecution', 'Suspended',
  'UserRequest', 'WrExecutive', 'WrFreePage', 'WrPageIn', 'WrPoolAllocation',
  'WrDelayExecution', 'WrSuspended', 'WrUserRequest', 'WrSpare0', 'WrQueue',
  'WrLpcReceive', 'WrLpcReply', 'WrVirtualMemory', 'WrPageOut', 'WrRendezvous',
  'WrKeyedEvent', 'WrTerminated', 'WrProcessInSwap', 'WrCpuRateControl',
  'WrCalloutStack', 'WrKernel', 'WrResource', 'WrPushLock', 'WrMutex', 'WrQuantumEnd',
  'WrDispatchInt', 'WrPreempted', 'WrYieldExecution', 'WrFastMutex', 'WrGuardedMutex',
  'WrRundown', 'WrAlertByThreadId', 'WrDeferredPreempt', 'WrPhysicalFault', 'WrIoRing',
  'WrMdlCache',
] as const;

export function formatThreadWaitReason(state: number | null, reason: number | null): string {
  if (state === null) return UNAVAILABLE_THREAD_VALUE;
  if (state !== 5) return 'Not waiting';
  if (reason === null) return UNAVAILABLE_THREAD_VALUE;
  return `${WAIT_REASONS[reason] ?? 'Unknown'} (${reason})`;
}

export interface ThreadRoles { main: boolean; current: boolean; event: boolean }

/** Modules-style single, trimmed, case-insensitive substring; never a navigation command. */
export function matchesThreadFilter(
  thread: Thread, query: string, symbol: string | null, roles: ThreadRoles,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const values = [thread.name, String(thread.id), `0x${thread.id.toString(16)}`,
    thread.start_address, symbol, roles.main ? 'main' : null,
    roles.current ? 'current' : null, roles.event ? 'event' : null];
  return values.some(value => value !== null && value.toLowerCase().includes(needle));
}
