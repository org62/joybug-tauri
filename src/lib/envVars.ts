/**
 * Environment variables for a launch travel as ordered `[name, value]` pairs
 * (the backend merges them over the debugger's own environment). The session
 * dialog edits them as `KEY=value` lines, so this is the round-trip between
 * the two shapes.
 */
export type EnvPairs = [string, string][];

export type ParseEnvResult =
  | { ok: true; pairs: EnvPairs }
  | { ok: false; error: string };

/**
 * Parse `KEY=value` lines. Blank lines and `#` comments are skipped; the value
 * is everything after the first `=` (kept verbatim, so it may contain `=`).
 * Returns an error instead of silently dropping a malformed line.
 */
export function parseEnvText(text: string): ParseEnvResult {
  const pairs: EnvPairs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `Line ${i + 1}: expected KEY=value, got "${line}"` };
    }
    const name = line.slice(0, eq).trim();
    if (!name || /\s/.test(name)) {
      return { ok: false, error: `Line ${i + 1}: invalid variable name "${name}"` };
    }
    pairs.push([name, line.slice(eq + 1)]);
  }
  return { ok: true, pairs };
}

export function formatEnvText(pairs: EnvPairs | null | undefined): string {
  return (pairs ?? []).map(([name, value]) => `${name}=${value}`).join("\n");
}
