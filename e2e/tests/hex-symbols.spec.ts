import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  openMemoryHexPanel,
  resetDockLayout,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForModuleSymbols,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import {
  HEX_ADDRESS,
  HEX_SYMBOL_ROW,
  HEX_SYMBOLS_TOGGLE,
} from "../helpers/selectors";

/** One rendered gutter or symbol row, as `readSequence` reports it. */
interface SeqRow {
  kind?: string;
  address: string;
  unitFrom: number;
  unitTo: number;
  text: string;
}

/**
 * The hex view's "show symbols" toggle interleaves a label row at each
 * symbol's address: above its data row when the symbol starts the row, or
 * splitting the row into a fragment before the label and a continuation
 * fragment (same aligned address, repeated) from the symbol on. Data rows
 * keep their aligned addresses, 16 bytes apart, in order.
 *
 * The toggle persists in localStorage, which the fixture resets around every
 * test, so it is off when this spec starts and can't leak out of it.
 */
test.describe("Hex symbol rows", () => {
  test("toggling symbols interleaves label rows without moving the hex rows", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(120_000);

    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "Hex Symbols");
    try {
      await waitForPaused(page, sessionId);

      // `ntdll!NtClose` in the goto box resolves through the symbol search,
      // which needs ntdll's symbols usable (its exports already carry NtClose).
      await waitForModuleSymbols(page, sessionId, "ntdll", { accept: ["loaded", "exports_only"] });

      const hex = await openMemoryHexPanel(page, "ntdll!NtClose");
      const gutter = hex.locator(HEX_ADDRESS);
      const toggle = hex.locator(HEX_SYMBOLS_TOGGLE);
      const symbolRows = hex.locator(HEX_SYMBOL_ROW);

      // --- Off by default ------------------------------------------------------
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(symbolRows).toHaveCount(0);

      // --- On: NtClose gets a row, data rows are untouched ----------------------
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      const ntCloseRow = hex.locator(HEX_SYMBOL_ROW, { hasText: /NtClose/ }).first();
      await expect(ntCloseRow).toBeVisible({ timeout: 15_000 });

      // Walk every rendered gutter/symbol row of THIS panel, in DOM order, in
      // one snapshot. A single `evaluate` on the panel element rather than a
      // comma-selector locator: `hex.locator("a, b")` does not scope both
      // alternatives to `hex`, so the second one matches document-wide and
      // pulls in rows from other mounted hex views (rc-dock keeps hidden
      // panels alive), producing a sequence that interleaves two views.
      const readSequence = (): Promise<SeqRow[]> =>
        hex.evaluate((panel) =>
          Array.from(
            panel.querySelectorAll('[data-testid="hex-address"],[data-testid="hex-symbol-row"]'),
          ).map((el) => {
            const e = el as HTMLElement;
            return {
              kind: e.dataset.testid,
              address: e.dataset.address ?? "",
              unitFrom: Number(e.dataset.unitFrom ?? -1),
              unitTo: Number(e.dataset.unitTo ?? -1),
              text: e.innerText,
            };
          }),
        );
      // Gutter addresses: a split row repeats its address on the continuation
      // fragment; distinct addresses stay contiguous, and fragments of one row
      // tile its 16 units in order.
      const checkGutter = (seq: SeqRow[]) => {
        const data = seq.filter((r) => r.kind === "hex-address");
        expect(data.length).toBeGreaterThan(4);
        for (let i = 1; i < data.length; i++) {
          const prev = BigInt(data[i - 1].address);
          const cur = BigInt(data[i].address);
          if (cur === prev) {
            expect(data[i].unitFrom).toBe(data[i - 1].unitTo);
          } else {
            expect(cur - prev).toBe(16n);
            expect(data[i - 1].unitTo).toBe(16);
            expect(data[i].unitFrom).toBe(0);
          }
        }
      };
      // The label sits between the fragments of the data row holding its
      // address (or directly above the row when it starts it): the gutter
      // rows on both sides carry that row's aligned address.
      const checkLabelPlacement = (seq: SeqRow[], re: RegExp) => {
        const at = seq.findIndex((r) => r.kind === "hex-symbol-row" && re.test(r.text));
        expect(at).toBeGreaterThanOrEqual(0);
        const symAddr = BigInt(seq[at].address);
        const nextData = seq.slice(at + 1).find((r) => r.kind === "hex-address");
        expect(nextData).toBeDefined();
        const rowAddr = BigInt(nextData!.address);
        expect(symAddr >= rowAddr && symAddr < rowAddr + 16n).toBe(true);
        const unit = Number(symAddr - rowAddr);
        expect(nextData!.unitFrom).toBe(unit);
        if (unit > 0) {
          const prevData = seq.slice(0, at).reverse().find((r) => r.kind === "hex-address");
          expect(prevData?.address).toBe(rowAddr.toString());
          expect(prevData?.unitTo).toBe(unit);
        }
        return { symAddr, rowAddr };
      };
      /**
       * Read the rows and assert the whole layout in one go, retrying on a
       * fresh snapshot until it holds. Toggling symbols (or a bookmark
       * arriving) changes the row model, which re-anchors the scroll and
       * re-renders the virtualized window; a single snapshot can land in that
       * transition, when the rendered range no longer matches the model and
       * the target label may be outside it. Polling asserts the settled
       * layout — the property under test — instead of one arbitrary frame.
       */
      const expectSettledLayout = async (re: RegExp) => {
        let placement!: { symAddr: bigint; rowAddr: bigint };
        await expect(async () => {
          const seq = await readSequence();
          checkGutter(seq);
          placement = checkLabelPlacement(seq, re);
        }).toPass({ timeout: 15_000, intervals: [50, 100, 250] });
        return placement;
      };

      const { rowAddr } = await expectSettledLayout(/NtClose/);
      // Symbol rows never impersonate the byte grid (other specs find the
      // first byte cell by this class).
      expect(await ntCloseRow.locator(".cursor-pointer").count()).toBe(0);

      // --- Mid-row label splits the data row -----------------------------------
      // A bookmark is a host-side label with a known address; +8 into NtClose's
      // row is always mid-row, so this exercises the split whatever alignment
      // the export itself has.
      const midAddr = rowAddr + 8n;
      await invoke(page, "add_bookmark", {
        sessionId,
        kind: "value",
        address: `0x${midAddr.toString(16)}`,
        valueType: "U32",
        name: "e2e-mid",
      });
      const midRow = hex.locator(HEX_SYMBOL_ROW, { hasText: /e2e-mid/ }).first();
      await expect(midRow).toBeVisible({ timeout: 15_000 });
      const mid = await expectSettledLayout(/e2e-mid/);
      expect(mid.symAddr).toBe(midAddr);
      expect(mid.rowAddr).toBe(rowAddr);
      // The fragment before the label shows units [0, 8), the one after [8, 16).
      const beforeFrag = hex.locator(`${HEX_ADDRESS}[data-address="${rowAddr}"][data-unit-to="8"]`);
      const afterFrag = hex.locator(`${HEX_ADDRESS}[data-address="${rowAddr}"][data-unit-from="8"]`);
      await expect(beforeFrag).toHaveCount(1);
      await expect(afterFrag).toHaveCount(1);
      await expect(afterFrag).toHaveAttribute("data-unit-to", "16");

      // --- Off again: rows vanish, gutter still contiguous ---------------------
      await toggle.click();
      await expect(symbolRows).toHaveCount(0);
      const after = (
        await gutter.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.address ?? ""))
      ).map(BigInt);
      for (let i = 1; i < after.length; i++) {
        expect(after[i] - after[i - 1]).toBe(16n);
      }
    } finally {
      await cleanupSession(page, sessionId);
      // The Memory tab this spec opened would otherwise stay open for every
      // later spec, mounting its view (and its fetches) before they start.
      await resetDockLayout(page);
      await restoreDefaultSettings(page);
    }
  });
});
