/** Shared assembly-view selectors used across specs. */
export const ASM_PANEL = '[data-testid="assembly-panel"]';
/** The instruction row itself, unscoped — for composing against another root. */
export const ASM_ROW_ONLY = '[data-testid="asm-row"]';
export const ASM_ROW = `${ASM_PANEL} ${ASM_ROW_ONLY}`;
export const PC_ROW = `${ASM_ROW}[data-highlight="pc"]`;
/** Synthetic `db 0xXX` rows emitted where a byte couldn't be decoded. */
export const ASM_INVALID_ROW = `${ASM_ROW}[data-invalid]`;
/** Symbol label rows inserted above exact-symbol (offset 0) instructions. */
export const ASM_LABEL_ROW = `${ASM_PANEL} [data-testid="asm-label-row"]`;
