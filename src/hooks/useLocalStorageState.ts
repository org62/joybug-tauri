import { useCallback, useState } from "react";

/**
 * A `useState` whose value is persisted to `localStorage` under `key`. Reads the
 * initial value once (falling back to `defaultValue` on miss or parse error) and
 * writes on every update. JSON-serializable values only.
 */
export function useLocalStorageState<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) return JSON.parse(saved) as T;
    } catch {
      // ignore malformed persisted value
    }
    return defaultValue;
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // ignore quota/serialization errors
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
