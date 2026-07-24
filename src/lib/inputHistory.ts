const PREFIX = "input-history:";

export const INPUT_HISTORY_LIMIT = 10;

/**
 * MRU history of submitted values for a logical input (most recent first).
 * Read lazily at the moment recall starts, so there is no reactive state to
 * keep in sync — pushes from any component are visible to the next read.
 */
export function readInputHistory(key: string): string[] {
  try {
    const saved = localStorage.getItem(PREFIX + key);
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    }
  } catch {
    // ignore malformed persisted value
  }
  return [];
}

/**
 * Record a submitted value: dedupes, moves to front, caps the list.
 * Call from the submit path once the value is accepted (parse/command
 * succeeded), so histories only collect proven-good values.
 */
export function pushInputHistory(key: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const next = [trimmed, ...readInputHistory(key).filter((v) => v !== trimmed)].slice(
    0,
    INPUT_HISTORY_LIMIT,
  );
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    // ignore quota/serialization errors
  }
}
