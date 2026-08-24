/**
 * Display-row model for the hex view's "show symbols" mode.
 *
 * The hex view is a virtualized list of fixed-height rows. Normally row `i`
 * shows bytes `[i*bytesPerRow, (i+1)*bytesPerRow)` of the window. With symbols
 * on, a *symbol row* is inserted at each symbol's address: a symbol that sits
 * at the start of a data row goes directly above it, one in the middle splits
 * the data row into two *fragments* — the units before the symbol, then the
 * label (starting under its unit), then the units from the symbol on. Data
 * rows keep their aligned addresses untouched, so all byte-offset state
 * (selection, edits, pending writes) is unaffected — only the mapping from
 * data row to display index changes, which `displayStart` records.
 */

export interface HexLabel {
  text: string;
  kind: "symbol" | "bookmark";
}

/** One annotated address; several names can share it (NtClose/ZwClose). */
export interface HexSymbol {
  address: bigint;
  labels: HexLabel[];
}

export type HexRow =
  | {
      kind: "data";
      dataRow: number;
      /** Unit range `[unitFrom, unitTo)` this fragment shows; a whole row is
       *  `[0, unitsPerRow)`. Units outside it render as blank placeholders so
       *  the columns stay aligned across fragments. */
      unitFrom: number;
      unitTo: number;
    }
  | {
      kind: "symbol";
      /** The data row this label belongs to (the one containing `address`). */
      dataRow: number;
      /** Unit cell (in the hex column) the address falls in — the label starts there. */
      unitIndex: number;
      address: bigint;
      labels: HexLabel[];
    };

export interface HexRowModel {
  rows: HexRow[];
  /**
   * `displayStart[d]` is the display index of the first row (symbol rows and
   * fragments included) belonging to data row `d`; length `totalRows + 1` with
   * the sentinel `displayStart[totalRows] === rows.length`, so the group size
   * of `d` is `displayStart[d + 1] - displayStart[d]`.
   *
   * With no symbols this is the identity (`displayStart[d] === d`), which is
   * what lets the view's scroll math reduce to plain row arithmetic.
   */
  displayStart: Int32Array;
}

/** Shared "nothing" value so memoized consumers see one stable reference. */
export const EMPTY_SYMBOLS: HexSymbol[] = [];

/**
 * Merge the window's data rows with its symbols (sorted ascending by address,
 * unique addresses). Two-pointer walk: O(rows + symbols), one bigint→number
 * conversion per symbol (a window is at most a few tens of KiB).
 */
export function buildHexRows(
  totalRows: number,
  bytesPerRow: number,
  bytesPerUnit: number,
  unitsPerRow: number,
  baseAddress: bigint,
  symbols: HexSymbol[],
): HexRowModel {
  const rows: HexRow[] = [];
  const displayStart = new Int32Array(totalRows + 1);
  const windowBytes = totalRows * bytesPerRow;

  let s = 0;
  while (s < symbols.length && symbols[s].address < baseAddress) s++;

  for (let d = 0; d < totalRows; d++) {
    displayStart[d] = rows.length;
    const rowStart = d * bytesPerRow;
    const rowEnd = rowStart + bytesPerRow;
    // Next unit not yet emitted for this data row: every symbol closes the
    // fragment before its unit (if non-empty) and the last fragment runs to
    // the end of the row. Two symbols inside one unit share the split.
    let unitFrom = 0;
    while (s < symbols.length) {
      const off = Number(symbols[s].address - baseAddress);
      if (off >= rowEnd || off >= windowBytes) break;
      const unitIndex = Math.floor((off - rowStart) / bytesPerUnit);
      if (unitIndex > unitFrom) {
        rows.push({ kind: "data", dataRow: d, unitFrom, unitTo: unitIndex });
        unitFrom = unitIndex;
      }
      rows.push({
        kind: "symbol",
        dataRow: d,
        unitIndex,
        address: symbols[s].address,
        labels: symbols[s].labels,
      });
      s++;
    }
    rows.push({ kind: "data", dataRow: d, unitFrom, unitTo: unitsPerRow });
  }
  displayStart[totalRows] = rows.length;
  return { rows, displayStart };
}

/**
 * The data row a window byte offset falls in, clamped to the model. The single
 * definition of that rule: both the goto path and the scroll re-anchoring
 * locate their target this way, and they must agree.
 */
export function dataRowForOffset(model: HexRowModel, byteOffset: number, bytesPerRow: number): number {
  const totalRows = model.displayStart.length - 1;
  if (totalRows <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(byteOffset / bytesPerRow)), totalRows - 1);
}

/**
 * Display index a goto should land on for a window byte offset: the first row
 * of the target's group, so a symbol sitting exactly at the target shows its
 * label above the bytes.
 */
export function displayIndexForOffset(model: HexRowModel, byteOffset: number, bytesPerRow: number): number {
  return model.displayStart[dataRowForOffset(model, byteOffset, bytesPerRow)];
}
