import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  fixtureExe,
  invoke,
  rowAddress,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  enableImagePatchLens,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  disassembleFunction,
  resolveSymbolVa,
  FN_DISASM_EVENT,
} from "../helpers/event-helpers";
import { ASM_PANEL, ASM_ROW, SELECTED_ROW } from "../helpers/selectors";

/** Address compare that does not care about hex digit case. */
const sameAddr = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

// The overlap_asm fixture hides `rdtsc; ret` inside the immediate of a
// `movabs rax, 9090909090C3310Fh`, in a function that has .pdata unwind info.
// Those bounds are what used to break this: "disassemble the function
// containing X" re-anchors its decode to the function start, and a
// mid-instruction X satisfies `start <= X < end` just as well as a real
// boundary does — so the response came back correctly aligned, without a single
// row at the address the user actually typed, and the view silently did nothing.
//
// The fixture is x64-pinned, so on an ARM64 host it runs emulated. This spec
// therefore never sets a breakpoint in it and never steps it: it stops at the
// initial system breakpoint and only reads, writes and disassembles memory.
test.describe("Overlapping instructions", () => {
  test("disassembles at an address inside an instruction, and flags patched bytes there", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(120_000);
    await configureMinimalStopSettings(page);

    const sessionId = await createAndStartSession(
      page,
      "Overlap Disasm",
      `${fixtureExe("overlap_asm")} ovlp`,
    );

    try {
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      await installEventCapture(page, [FN_DISASM_EVENT, "symbols-updated"]);
      await enableImagePatchLens(page);

      const input = page.locator(`${ASM_PANEL} input`).first();
      const goto = async (expression: string) => {
        await input.fill(expression);
        await input.press("Enter");
      };

      // --- locate the overlapping code ------------------------------------
      // Exact match: incremental linking also publishes an `@ILT+N(overlap_fn)`
      // jump thunk, and decoding that would find no overlapping code at all.
      const fnAddr = Number(BigInt(await resolveSymbolVa(page, sessionId, "overlap_fn", { exact: true })));
      const aligned = await disassembleFunction(page, sessionId, fnAddr);

      // `rdtsc` exists nowhere in this image except inside that immediate, so
      // its absence here is what makes it "hidden".
      expect(
        aligned.some((i) => i.mnemonic.toLowerCase() === "rdtsc"),
        "the hidden instruction must not appear in the aligned listing",
      ).toBe(false);

      const outer = aligned.find((i) => i.bytes.toUpperCase().startsWith("48 B8"));
      expect(outer, "overlap_fn carries the movabs whose immediate hides code").toBeTruthy();
      const outerHex = outer!.address; // as emitted, so it works as a CSS selector value
      const hiddenAddr = Number(BigInt(outer!.address)) + 2; // skip the 48 B8 opcode
      const hiddenHex = rowAddress(hiddenAddr);

      // --- the regression: goto an address inside an instruction -----------
      await goto(hiddenHex);
      const landed = page.locator(SELECTED_ROW);
      await expect(landed).toHaveAttribute("data-address", hiddenHex, { timeout: 15_000 });
      await expect(landed).toContainText("rdtsc", { timeout: 10_000 });

      // --- patch the immediate, in place -----------------------------------
      // 0F 31 (rdtsc) -> 0F A2 (cpuid): a raw write, so this exercises the
      // image-diff path (memory vs. the file on disk), not a tracked patch.
      await invoke(page, "request_memory_write", {
        sessionId,
        address: hiddenAddr,
        data: [0x0f, 0xa2],
      });

      await expect(async () => {
        const fresh = await disassembleFunction(page, sessionId, hiddenAddr);
        const hidden = fresh.find((i) => sameAddr(i.address, hiddenHex));
        expect(hidden?.mnemonic.toLowerCase()).toBe("cpuid");
        expect(hidden?.is_patched).toBe(true);
        expect(hidden?.original_disasm ?? "").toContain("rdtsc");
      }).toPass({ timeout: 15_000, intervals: [50, 100, 200] });

      // That row is the goto's landing spot, so it is also `selected` — the
      // state that used to swallow the patch highlight whole.
      const patchedSelected = page.locator(`${SELECTED_ROW}[data-patched]`);
      await expect(patchedSelected).toHaveAttribute("data-address", hiddenHex, { timeout: 15_000 });
      await expect(patchedSelected).toContainText("cpuid");

      await patchedSelected.hover();
      const tooltip = page.getByRole("tooltip").filter({ hasText: "Original (on disk)" });
      await expect(tooltip).toBeVisible({ timeout: 5_000 });
      await expect(tooltip).toContainText("rdtsc", { timeout: 5_000 });
      await page.mouse.move(0, 0);

      // --- and the same bytes read as patched in the aligned view ----------
      await goto(rowAddress(fnAddr));
      const outerRow = page.locator(`${ASM_ROW}[data-address="${outerHex}"]`);
      await expect(outerRow).toHaveAttribute("data-patched", "", { timeout: 15_000 });
      // Not the row the goto landed on — the marker is independent of selection.
      await expect(outerRow).not.toHaveAttribute("data-highlight", "selected");

      const alignedAfter = await disassembleFunction(page, sessionId, fnAddr);
      const outerAfter = alignedAfter.find((i) => sameAddr(i.address, outerHex));
      expect(outerAfter?.is_patched).toBe(true);
      expect(outerAfter?.bytes.toUpperCase()).toContain("48 B8 0F A2");

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
