import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  invoke,
  openWindowsSubmenu,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import {
  installEventCapture,
  clearCapturedEvents,
  waitForCapturedEvent,
} from "../helpers/event-helpers";
import { ASM_ROW } from "../helpers/selectors";
import type { Page } from "@playwright/test";

const FN_DISASM = "function-disassembly-updated";
const DEFAULT_MAX = 200;

interface EmittedInstruction {
  address: string;
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_patched?: boolean;
  original_bytes?: string;
  original_disasm?: string;
}

/** Current RIP as a number, from session state. */
async function getRip(page: Page, sessionId: string): Promise<number> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  const addr = s?.current_event?.address;
  if (addr == null) throw new Error("No current address (not paused?)");
  return addr;
}

/** Request a function disassembly at `address` and return the fresh instruction list. */
async function disassembleFunction(
  page: Page,
  sessionId: string,
  address: number,
): Promise<EmittedInstruction[]> {
  await clearCapturedEvents(page, FN_DISASM);
  await invoke(page, "request_function_disassembly", { sessionId, address, maxInstructions: DEFAULT_MAX, compareImage: true });
  const payload = await waitForCapturedEvent(
    page,
    FN_DISASM,
    (p) => p.session_id === sessionId && Array.isArray(p.instructions) && p.instructions.length > 0,
  );
  return payload.instructions as EmittedInstruction[];
}

test.describe("Image patch detection", () => {
  test("in-memory code differing from the on-disk image is flagged, hoverable, and restorable", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Image Patch");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page);
      await installEventCapture(page, [FN_DISASM]);

      // Image-patch highlighting is an opt-in lens (off by default so ordinary
      // stepping doesn't pay the per-instruction on-disk-image diff). This test
      // exercises it, so turn it on in the view — otherwise the view's own
      // re-decodes would clear the highlight this test asserts.
      const imageToggle = page.locator("#compare-image");
      if ((await imageToggle.getAttribute("data-state")) === "unchecked") {
        await imageToggle.click();
      }

      const rip = await getRip(page, sessionId);
      const ripHex = `0X${rip.toString(16).toUpperCase()}`;

      // Disassemble the current function and pick the instruction right after
      // RIP: adjacent to the PC (so it's rendered in the virtualized window) but
      // not the PC row itself (whose yellow highlight would outrank "patched").
      const insts = await disassembleFunction(page, sessionId, rip);
      const ripIdx = insts.findIndex((i) => i.address.toUpperCase() === ripHex);
      expect(ripIdx).toBeGreaterThanOrEqual(0);
      const targetIdx = ripIdx + 1 < insts.length ? ripIdx + 1 : ripIdx - 1;
      const target = insts[targetIdx];
      expect(target).toBeTruthy();
      // None of these disk-backed code instructions should read as patched yet.
      expect(target.is_patched ?? false).toBe(false);

      const targetAddrNum = parseInt(target.address, 16);
      const targetAddrHex = target.address; // "0x..." as the frontend uses it
      const originalMnemonic = target.mnemonic;
      const origFirstByte = parseInt(target.bytes.split(" ")[0], 16);
      // Flip the first byte so the in-memory bytes diverge from the image.
      const modifiedByte = origFirstByte ^ 0xff;

      // Raw memory write (no UI patch record) — exercises the image-diff path,
      // not the tracked-patch path.
      await invoke(page, "request_memory_write", {
        sessionId,
        address: targetAddrNum,
        data: [modifiedByte],
      });

      // Re-disassemble; the target instruction must now be flagged with the
      // original bytes + disassembly attached.
      await expect(async () => {
        const fresh = await disassembleFunction(page, sessionId, rip);
        const t = fresh.find((i) => i.address.toUpperCase() === targetAddrHex.toUpperCase());
        expect(t?.is_patched).toBe(true);
        expect(t?.original_disasm).toBeTruthy();
        expect(t?.original_bytes).toBeTruthy();
      }).toPass({ timeout: 10_000 });

      // DOM: the row renders with the patched highlight.
      const patchedRow = page.locator(`${ASM_ROW}[data-highlight="patched"]`).first();
      await expect(patchedRow).toBeVisible({ timeout: 10_000 });

      // Hover shows the original instruction in a tooltip.
      await patchedRow.hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toBeVisible({ timeout: 5_000 });
      await expect(tooltip).toContainText(originalMnemonic, { timeout: 5_000 });

      // Restore via the context menu → "Restore Original Bytes".
      await patchedRow.click({ button: "right" });
      const restoreItem = page.getByRole("menuitem", { name: "Restore Original Bytes" });
      await expect(restoreItem).toBeVisible({ timeout: 3_000 });
      await restoreItem.click();

      // The auto-refresh (patches-updated → re-request) should clear the flag.
      await expect(async () => {
        const fresh = await disassembleFunction(page, sessionId, rip);
        const t = fresh.find((i) => i.address.toUpperCase() === targetAddrHex.toUpperCase());
        expect(t?.is_patched ?? false).toBe(false);
        expect(t?.mnemonic).toBe(originalMnemonic);
      }).toPass({ timeout: 10_000 });

      // And the patched highlight is gone from the DOM.
      await expect(page.locator(`${ASM_ROW}[data-highlight="patched"]`)).toHaveCount(0, { timeout: 5_000 });

      await cleanupSession(page, sessionId);
    } finally {
      // No compare-image restore needed: the tauriPage fixture clears
      // localStorage (preserving only theme) after every test, so the toggled
      // setting can't leak into later specs.
      await restoreDefaultSettings(page);
    }
  });

  test("Image Patches window lists, filters, and restores image diffs", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Image Patch Window");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page);
      await installEventCapture(page, [FN_DISASM]);

      // Same setup as above: flip one byte of a non-PC instruction so the
      // in-memory code diverges from the on-disk image.
      const rip = await getRip(page, sessionId);
      const ripHex = `0X${rip.toString(16).toUpperCase()}`;
      const insts = await disassembleFunction(page, sessionId, rip);
      const ripIdx = insts.findIndex((i) => i.address.toUpperCase() === ripHex);
      expect(ripIdx).toBeGreaterThanOrEqual(0);
      const target = insts[ripIdx + 1 < insts.length ? ripIdx + 1 : ripIdx - 1];
      const targetAddrNum = parseInt(target.address, 16);
      const origFirstByte = parseInt(target.bytes.split(" ")[0], 16);
      await invoke(page, "request_memory_write", {
        sessionId,
        address: targetAddrNum,
        data: [origFirstByte ^ 0xff],
      });

      // Open the Image Patches window — it auto-scans on mount while paused.
      // The scan command is queued behind the memory write, so it sees the diff.
      await openWindowsSubmenu(page, "Debug");
      await page.getByRole("menuitemcheckbox", { name: "Image Patches" }).click();
      await page.keyboard.press("Escape");

      const row = page.locator('[data-testid="image-patch-row"]', { hasText: target.address });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      // The diff renders both sides: the original disassembly and both byte runs.
      await expect(row).toContainText(target.mnemonic);
      await expect(row).toContainText(target.bytes.split(" ")[0]);

      // Quick filter: a non-matching term hides the row and shows the empty state...
      const filter = page.getByPlaceholder("Filter by address or symbol");
      await filter.fill("zzzzzzzz");
      await expect(row).toHaveCount(0, { timeout: 5_000 });
      await expect(page.getByText("No matches")).toBeVisible({ timeout: 5_000 });
      // ...and an address fragment (case-insensitive) brings it back.
      await filter.fill(target.address.slice(-6).toLowerCase());
      await expect(row).toHaveCount(1, { timeout: 5_000 });
      await filter.fill("");

      // Restore from the row; patches-updated triggers a re-scan that clears it.
      await row.hover();
      await row.getByRole("button", { name: "Restore original bytes" }).click();
      await expect(
        page.locator('[data-testid="image-patch-row"]', { hasText: target.address }),
      ).toHaveCount(0, { timeout: 10_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
