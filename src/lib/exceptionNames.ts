// Symbolic names for common Windows exception / NTSTATUS codes, so the UI can
// show "EXCEPTION_SINGLE_STEP" instead of a bare 0x80000004.
//
// The backend ships the name on `ExceptionDetail.name` (see
// `session/exceptions.rs`, which owns the authoritative table); this one is the
// fallback for an event that reaches the UI without a decoded record.

export const EXCEPTION_SINGLE_STEP = 0x80000004;

const EXCEPTION_NAMES: Record<number, string> = {
  0x80000001: "EXCEPTION_GUARD_PAGE",
  0x80000002: "EXCEPTION_DATATYPE_MISALIGNMENT",
  0x80000003: "EXCEPTION_BREAKPOINT",
  [EXCEPTION_SINGLE_STEP]: "EXCEPTION_SINGLE_STEP",
  0xc0000005: "EXCEPTION_ACCESS_VIOLATION",
  0xc0000006: "EXCEPTION_IN_PAGE_ERROR",
  0xc000001d: "EXCEPTION_ILLEGAL_INSTRUCTION",
  0xc0000025: "EXCEPTION_NONCONTINUABLE_EXCEPTION",
  0xc0000026: "EXCEPTION_INVALID_DISPOSITION",
  0xc000008c: "EXCEPTION_ARRAY_BOUNDS_EXCEEDED",
  0xc000008d: "EXCEPTION_FLT_DENORMAL_OPERAND",
  0xc000008e: "EXCEPTION_FLT_DIVIDE_BY_ZERO",
  0xc000008f: "EXCEPTION_FLT_INEXACT_RESULT",
  0xc0000090: "EXCEPTION_FLT_INVALID_OPERATION",
  0xc0000091: "EXCEPTION_FLT_OVERFLOW",
  0xc0000092: "EXCEPTION_FLT_STACK_CHECK",
  0xc0000093: "EXCEPTION_FLT_UNDERFLOW",
  0xc0000094: "EXCEPTION_INT_DIVIDE_BY_ZERO",
  0xc0000095: "EXCEPTION_INT_OVERFLOW",
  0xc0000096: "EXCEPTION_PRIV_INSTRUCTION",
  0xc00000fd: "EXCEPTION_STACK_OVERFLOW",
  0xc000001c: "STATUS_INVALID_SYSTEM_SERVICE", // Linux: SIGSYS
  0xc0000409: "STATUS_STACK_BUFFER_OVERRUN", // Linux: SIGABRT

  0xe06d7363: "EXCEPTION_MSVC_CPP", // C++ EH throw
};

/**
 * POSIX signals a Linux target can be made to stop on. The backend reports
 * one as an exception with code `SIGNAL_EXCEPTION_BASE | signo` (see
 * `joybug_core::posix_signals`), and only when an exception rule names it —
 * otherwise the signal reaches the target unseen. The fault signals (SIGSEGV,
 * SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGSYS) are not here: they always stop,
 * under the exception codes above.
 */
export const SIGNAL_EXCEPTION_BASE = 0x4c530000;

export const POSIX_SIGNALS: { signo: number; name: string }[] = [
  { signo: 1, name: "SIGHUP" },
  { signo: 2, name: "SIGINT" },
  { signo: 3, name: "SIGQUIT" },
  { signo: 10, name: "SIGUSR1" },
  { signo: 12, name: "SIGUSR2" },
  { signo: 13, name: "SIGPIPE" },
  { signo: 14, name: "SIGALRM" },
  { signo: 15, name: "SIGTERM" },
  { signo: 17, name: "SIGCHLD" },
  { signo: 18, name: "SIGCONT" },
  { signo: 19, name: "SIGSTOP" },
  { signo: 20, name: "SIGTSTP" },
  { signo: 21, name: "SIGTTIN" },
  { signo: 22, name: "SIGTTOU" },
  { signo: 23, name: "SIGURG" },
  { signo: 24, name: "SIGXCPU" },
  { signo: 25, name: "SIGXFSZ" },
  { signo: 26, name: "SIGVTALRM" },
  { signo: 27, name: "SIGPROF" },
  { signo: 28, name: "SIGWINCH" },
  { signo: 29, name: "SIGIO" },
  { signo: 30, name: "SIGPWR" },
];

/** The exception code a signal is reported as. */
export function signalExceptionCode(signo: number): number {
  return (SIGNAL_EXCEPTION_BASE | signo) >>> 0;
}

/** The signal number behind an exception code, or null when it is not one. */
export function exceptionCodeSignal(code: number): number | null {
  const signo = code & 0xffff;
  return (code & 0xffff0000) >>> 0 === SIGNAL_EXCEPTION_BASE && signo >= 1 && signo <= 64 ? signo : null;
}

function signalName(signo: number): string {
  const known = POSIX_SIGNALS.find((s) => s.signo === signo);
  if (known) return known.name;
  return signo >= 34 ? (signo === 34 ? "SIGRTMIN" : `SIGRTMIN+${signo - 34}`) : `SIG${signo}`;
}

/** Format an exception code as 0x-padded hex (e.g. 0xC0000005). */
export function formatExceptionCode(code: number): string {
  return `0x${code.toString(16).padStart(8, "0").toUpperCase()}`;
}

/** Symbolic name for a code if known, otherwise its hex representation. */
export function exceptionName(code: number): string {
  const signo = exceptionCodeSignal(code);
  if (signo !== null) return signalName(signo);
  return EXCEPTION_NAMES[code] ?? formatExceptionCode(code);
}
