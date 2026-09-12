/**
 * Parsing for the multi-line "paste a list" inputs (Code Explorer targets,
 * bulk breakpoints). One convention across the app, mirroring the backend's
 * own parsing in `resolve_custom_entries`: one entry per line, blank lines and
 * lines starting with `#` or `;` ignored, surrounding whitespace trimmed — so
 * the count the UI shows is the count that gets used.
 */

/** One kept line, carrying the 1-based source line so a rejected entry can be
 *  pointed at in the text the user pasted. */
export interface ListEntry {
  line: number;
  text: string;
}

/** The entries of a pasted list, each with its 1-based line number. */
export function numberedEntryLines(text: string): ListEntry[] {
  return text
    .split("\n")
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => text && !text.startsWith("#") && !text.startsWith(";"));
}

/** The entries of a pasted list. */
export function customEntryLines(text: string): string[] {
  return numberedEntryLines(text).map((entry) => entry.text);
}
