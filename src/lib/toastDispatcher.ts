import { toast } from "sonner";

/**
 * Burst-aware toast dispatcher.
 *
 * Problem: the backend emits a toast per debug event. Normally these are rare and
 * useful (a DLL loads, a thread starts, an OutputDebugString fires). But some
 * targets (e.g. games/engines) emit thousands in a burst, and sonner measures
 * every toast's height with a forced layout reflow — flooding it freezes the UI.
 *
 * Strategy: per "category" (derived from the message), show the first few full
 * messages, then collapse the rest of the burst into a single summary toast that
 * updates in place ("1000× OutputDebugString") at a throttled rate. After a quiet
 * period the category resets, so later rare events show their full message again.
 */

type Level = "info" | "error";

const WINDOW_MS = 2000;                 // rolling window for counting per category
const PER_CATEGORY_INDIVIDUAL_LIMIT = 3; // full messages shown per category before coalescing
const GLOBAL_INDIVIDUAL_LIMIT = 12;      // cap on full toasts across all categories per window
const SUMMARY_THROTTLE_MS = 300;         // min interval between summary-toast updates
const BURST_RESET_MS = 1500;             // quiet period after which a category resets to normal

interface CategoryState {
  times: number[];          // event timestamps within the rolling window
  bursting: boolean;        // once true, everything coalesces until reset
  total: number;            // total events since the burst/category began (shown in summary)
  summaryId?: string | number;
  level: Level;             // summary level — an error makes the whole summary an error
  lastSummaryUpdate: number;
  pendingUpdate?: ReturnType<typeof setTimeout>;
  resetTimer?: ReturnType<typeof setTimeout>;
}

const categories = new Map<string, CategoryState>();
let globalIndividual: number[] = [];

/**
 * Derive a coarse category from a message so distinct-but-similar messages group
 * together: "OutputDebugString: foo" → "OutputDebugString", "DLL loaded: a.dll @ 0x.."
 * → "DLL loaded", "ThreadCreated(pid=..)" → "ThreadCreated".
 */
function deriveCategory(message: string): string {
  const m = message.match(/^([A-Za-z][A-Za-z ]*?)(?:[:(]| @ |$)/);
  return m ? m[1].trim() : message.slice(0, 32);
}

function prune(arr: number[], now: number): number[] {
  let i = 0;
  while (i < arr.length && now - arr[i] > WINDOW_MS) i++;
  return i > 0 ? arr.slice(i) : arr;
}

function renderSummary(category: string, st: CategoryState) {
  st.lastSummaryUpdate = Date.now();
  st.summaryId = toast[st.level](`${st.total}× ${category}`, { id: st.summaryId });
}

/** Update the summary toast at most once per SUMMARY_THROTTLE_MS, with a trailing update. */
function scheduleSummary(category: string, st: CategoryState) {
  const elapsed = Date.now() - st.lastSummaryUpdate;
  if (elapsed >= SUMMARY_THROTTLE_MS) {
    renderSummary(category, st);
  } else if (!st.pendingUpdate) {
    st.pendingUpdate = setTimeout(() => {
      st.pendingUpdate = undefined;
      renderSummary(category, st);
    }, SUMMARY_THROTTLE_MS - elapsed);
  }
}

export function dispatchToast(level: Level, message: string): void {
  const now = Date.now();
  const category = deriveCategory(message);

  let st = categories.get(category);
  if (!st) {
    st = { times: [], bursting: false, total: 0, level, lastSummaryUpdate: 0 };
    categories.set(category, st);
  }

  st.total += 1;
  if (level === "error") st.level = "error"; // errors make the summary sticky-error

  if (st.bursting) {
    // Already coalescing this category. Skip the rolling-window bookkeeping —
    // its per-event array allocations are exactly the cost we're avoiding during
    // a burst — and just update the throttled summary. (`times` is only read to
    // decide when to *start* bursting, so it's dead weight once we're here.)
    scheduleSummary(category, st);
  } else {
    st.times = prune(st.times, now);
    globalIndividual = prune(globalIndividual, now);
    st.times.push(now);

    const overCategory = st.times.length > PER_CATEGORY_INDIVIDUAL_LIMIT;
    const overGlobal = globalIndividual.length >= GLOBAL_INDIVIDUAL_LIMIT;

    if (!overCategory && !overGlobal) {
      // Normal volume: show the full message.
      toast[level](message);
      globalIndividual.push(now);
    } else {
      // Burst threshold crossed: collapse into a throttled "N× category" summary.
      st.bursting = true;
      scheduleSummary(category, st);
    }
  }

  // (Re)arm reset: after a quiet period the category returns to showing full messages.
  if (st.resetTimer) clearTimeout(st.resetTimer);
  st.resetTimer = setTimeout(() => {
    if (st!.pendingUpdate) clearTimeout(st!.pendingUpdate);
    categories.delete(category);
  }, BURST_RESET_MS);
}
