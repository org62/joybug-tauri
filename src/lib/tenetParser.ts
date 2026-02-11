export interface TenetEntry {
  registers: Record<string, string>;
  memoryReads: { address: string; data: string }[];
  memoryWrites: { address: string; data: string }[];
}

/**
 * Parse a Tenet format trace text into structured entries.
 *
 * Each line is comma-separated key=value pairs.
 * First line has full register dump, subsequent lines are deltas.
 * Memory accesses: mr=addr:data, mw=addr:data, mrw=addr:data
 */
export function parseTenetTrace(traceText: string): TenetEntry[] {
  const lines = traceText.split('\n').filter(l => l.trim().length > 0);
  const entries: TenetEntry[] = [];
  let prevRegisters: Record<string, string> = {};

  for (const line of lines) {
    const parts = line.split(',');
    const currentRegisters: Record<string, string> = { ...prevRegisters };
    const memoryReads: { address: string; data: string }[] = [];
    const memoryWrites: { address: string; data: string }[] = [];

    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;

      const key = part.substring(0, eqIdx);
      const value = part.substring(eqIdx + 1);

      if (key === 'mr' || key === 'mrw') {
        const colonIdx = value.indexOf(':');
        if (colonIdx !== -1) {
          const address = value.substring(0, colonIdx);
          const data = value.substring(colonIdx + 1);
          memoryReads.push({ address, data });
          if (key === 'mrw') {
            memoryWrites.push({ address, data });
          }
        }
      } else if (key === 'mw') {
        const colonIdx = value.indexOf(':');
        if (colonIdx !== -1) {
          memoryWrites.push({
            address: value.substring(0, colonIdx),
            data: value.substring(colonIdx + 1),
          });
        }
      } else {
        currentRegisters[key] = value;
      }
    }

    entries.push({
      registers: { ...currentRegisters },
      memoryReads,
      memoryWrites,
    });

    prevRegisters = currentRegisters;
  }

  return entries;
}
