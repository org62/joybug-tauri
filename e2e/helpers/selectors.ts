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

/** Hex-editor selectors. Every instance renders `hex-panel`; `data-memory-view-id`
 *  distinguishes them (the Memory tabs, the PE reader, the Stack tab's hex mode). */
export const HEX_PANEL = '[data-testid="hex-panel"]';
export const hexPanelFor = (memoryViewId: string) => `${HEX_PANEL}[data-memory-view-id="${memoryViewId}"]`;
export const HEX_ADDRESS = '[data-testid="hex-address"]';
export const HEX_OFFSET_ORIGIN = '[data-testid="hex-offset-origin"]';
