import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  moduleBase,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW } from "../helpers/selectors";
import { leaf, leafLink, pick } from "../helpers/pe-helpers";

test.describe("PE Viewer (session)", () => {
  test("shows the structure tree for a live module and links into disassembly", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(90_000);
    await configureMinimalStopSettings(page);
    const sessionId = await createAndStartSession(page, "PE Viewer Session");
    try {
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // The main module (cmd.exe) has a real entry point (ntdll does not —
      // its AddressOfEntryPoint is 0). Its base is the ASLR-relocated one from
      // the live module list, which is what the tree must use for VAs.
      const base = await moduleBase(page, sessionId, "cmd.exe");
      expect(base).toBeTruthy();

      // The tab (and its module selection + display mode) survive between
      // specs — the page is never reloaded — so pick both explicitly.
      await goToWindow(page, "PE Viewer");
      await pick(page, "peviewer-module-select", new RegExp(`${base}.*cmd`, "i"));
      await pick(page, "peviewer-addr-mode", "VA");

      // The tree rendered for the live module. Its group set is the standalone
      // viewer's and pe-reader.spec already covers that; the barrier here is
      // just "the fetch came back and the tree is on screen".
      await expect(page.getByText("DOS Header").first()).toBeVisible({ timeout: 15_000 });
      // Read-only: enum fields decode to text, with no editable select anywhere.
      await expect(leaf(page, "Subsystem")).toContainText(/Windows (CUI|GUI) \(0x/);
      await expect(page.locator('[data-testid="pe-leaf"] [role="combobox"]')).toHaveCount(0);

      // The Optional Header is expanded by default; the entry point shows a VA
      // inside the module in VA mode...
      const entry = leafLink(page, "AddressOfEntryPoint");
      let entryVa = "";
      await expect(async () => {
        entryVa = (await entry.innerText()).trim();
        const rva = BigInt(entryVa) - BigInt(base!);
        expect(rva > 0n && rva < 0x10000000n).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      const entryRva = BigInt(entryVa) - BigInt(base!);

      // ...and the bare RVA once the display mode is switched.
      await pick(page, "peviewer-addr-mode", "RVA");
      await expect(async () => {
        const rva = (await entry.innerText()).trim();
        expect(BigInt(rva)).toBe(entryRva);
      }).toPass({ timeout: 5_000, intervals: [50, 100] });

      // Clicking a code address navigates the session's Disassembly tab to it.
      await entry.click();
      await expect(async () => {
        const first = (await page.locator(ASM_ROW).first().innerText()).trim();
        const addr = first.match(/^0x[0-9a-f]+/i)?.[0];
        expect(addr, `first row: ${JSON.stringify(first)}`).toBeTruthy();
        expect(BigInt(addr!)).toBe(BigInt(entryVa));
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      // PE Viewer is a wide view, so it shares the center panel with
      // Disassembly — the navigation above hid it behind that tab.
      await goToWindow(page, "PE Viewer");
      // Switching module re-fetches; a DLL shows its export directory.
      await pick(page, "peviewer-module-select", /ntdll/i);
      await expect(page.getByText(/^Exports — ntdll\.dll/i)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
