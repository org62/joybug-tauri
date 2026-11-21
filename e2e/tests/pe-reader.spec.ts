import { test, expect, navigateTo, gotoFreshPe } from "../helpers/test-fixtures";
import { ASM_PANEL, ASM_ROW, HEX_ADDRESS, SELECTED_ROW, hexPanelFor } from "../helpers/selectors";
import { fixtureExe, rowAddress } from "../helpers/session-helpers";
import { openPe, leaf, leafLink, pick } from "../helpers/pe-helpers";
import type { Page } from "../helpers/test-fixtures";

// A dependency-free 64-bit system DLL that always exists on the test host.
const NTDLL = "C:\\Windows\\System32\\ntdll.dll";
// Its 32-bit sibling: a real PE32 with imports, exports and a code entry
// point (SysWOW64\ntdll.dll has neither an import directory nor an entry).
const KERNEL32_X86 = "C:\\Windows\\SysWOW64\\kernel32.dll";

/** Choose the address display mode of the standalone viewer. */
const pickAddrMode = (page: Page, option: string) => pick(page, "pe-addr-mode", option);

test.describe("PE Viewer", () => {
  test("empty page shows the placeholder", async ({ tauriPage: page }) => {
    // gotoFreshPe forces a full load so the placeholder is asserted against a
    // genuine fresh start, not a PE another test opened and left cached.
    await gotoFreshPe(page);
    await expect(page.getByText("No file open").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("nav shows PE Viewer", async ({ tauriPage: page }) => {
    await navigateTo(page, "/");
    await expect(page.getByText("PE Viewer", { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("deep-link opens a 64-bit PE and renders the structure tree + tabs", async ({
    tauriPage: page,
  }) => {
    await openPe(page, NTDLL);

    // Foldable structure tree — top-level nodes.
    await expect(page.getByText("NT Headers", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sections", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Imports", { exact: false }).first()).toBeVisible();

    // Dock tabs and the loaded file name.
    await expect(page.getByText("Symbols", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Strings", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Disassembly", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ntdll.dll", { exact: false }).first()).toBeVisible();
  });

  test("hex goto accepts a pasted VA and loads bytes at its file offset", async ({
    tauriPage: page,
  }) => {
    await openPe(page, NTDLL);

    // The hex view is file-offset addressed; a VA (>= the 0x180000000 image
    // base of system DLLs) must be translated through the section mappings
    // instead of being read as an offset past EOF ("No memory loaded").
    const gotoInput = page.getByPlaceholder("Address or symbol...").last();
    await gotoInput.fill("0x180001000");
    await gotoInput.press("Enter");
    await expect(page.getByText(/0x180001000/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("No memory loaded")).not.toBeVisible();
  });

  test("opens a 32-bit PE and decodes it as x86 / PE32", async ({ tauriPage: page }) => {
    await openPe(page, KERNEL32_X86);

    await expect(page.getByTestId("pe-arch-badge")).toHaveText(/x86 · PE32$/);
    // Optional Header is expanded by default; its Magic decodes to PE32, not PE32+.
    await expect(leaf(page, "Magic")).toContainText("PE32 (32-bit)");
    // ImageBase is a 4-byte field here: 8 hex digits, not zero-padded to 16.
    await expect(leaf(page, "ImageBase")).toContainText(/0x[0-9A-F]{8}\b/);
    await expect(leaf(page, "ImageBase")).not.toContainText(/0x0{8}[0-9A-F]{8}/);
    // PE32 has the BaseOfData field that PE32+ lacks.
    await expect(leaf(page, "BaseOfData")).toBeVisible();
    // The File Header group is collapsed by default.
    await page.getByText("File Header", { exact: true }).first().click();
    await expect(leaf(page, "Machine")).toContainText("x86 (I386)");
    // x86 images carry no exception directory, so that group never renders.
    await expect(page.getByText("Exception (Runtime Functions)")).toHaveCount(0);
  });

  test("32-bit import table uses 4-byte IAT slots", async ({ tauriPage: page }) => {
    await openPe(page, KERNEL32_X86);
    await pickAddrMode(page, "VA");
    const base = BigInt((await leaf(page, "ImageBase").innerText()).match(/0x[0-9A-F]+/i)![0]);

    await page.getByText("Imports", { exact: false }).first().click();
    const rows = page.locator('[data-testid="pe-import-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    // Two consecutive entries of the first DLL: both inside the image and
    // exactly one 32-bit pointer apart (a pe64 parse would have doubled the
    // stride).
    const first = BigInt((await rows.nth(0).locator("button").first().innerText()).trim());
    const second = BigInt((await rows.nth(1).locator("button").first().innerText()).trim());
    expect(first > base && first < base + 0x1000000n).toBe(true);
    expect(second - first).toBe(4n);
  });

  test("an offline indirect call opens its import slot in Hex, not as code", async ({
    tauriPage: page,
  }) => {
    await openPe(page, fixtureExe("overlap_asm"));
    await pickAddrMode(page, "VA");

    // Take the expected slot from the import table, independently of the decoder.
    await page.getByText("Imports", { exact: false }).first().click();
    const entry = page.getByTestId("pe-import-row").filter({ hasText: "ExitProcess" });
    await expect(entry).toBeVisible();
    const slot = BigInt((await entry.locator("button").first().innerText()).trim());

    // Hex normally has its own panel and is already active. Close it so a
    // successful click must open it, not just leave the existing tab visible.
    const hexTab = page.locator(".dock-tab", { hasText: /^Hex$/ });
    await hexTab.locator(".dock-tab-close-btn").click();
    await expect(hexTab).toHaveCount(0);
    await page.getByText("Disassembly", { exact: true }).first().click();
    const goto = page.locator(`${ASM_PANEL} input`).first();
    await goto.fill("overlap_asm!main");
    await goto.press("Enter");
    // The real main starts with a stack adjustment; the incremental-link thunk doesn't.
    const main = page.locator(SELECTED_ROW);
    await expect(main).toContainText(/sub\s*rsp/i);
    // In overlap_asm.asm, sub/call/xor occupy 4 + 5 + 2 bytes before the import call.
    const importCall = rowAddress(BigInt((await main.getAttribute("data-address"))!) + 11n);
    const call = page.locator(`${ASM_ROW}[data-address="${importCall}"]`);
    await expect(call).toContainText(/call[^[]*\[/i);
    await expect(call.locator('[title^="Jump to "]')).toHaveCount(0);
    const operand = call.locator('[title^="Open memory at "]');
    await expect(operand).toHaveAttribute("title", new RegExp(`^Open memory at 0x0*${slot.toString(16)}$`, "i"));
    await operand.click();

    await expect(hexTab).toHaveClass(/dock-tab-active/);
    const rowVA = slot & ~15n;
    const gutter = page.locator(`${hexPanelFor("pe-hex")} ${HEX_ADDRESS}`);
    await expect(gutter.filter({ hasText: new RegExp(`^0x${rowVA.toString(16)}$`, "i") }).first()).toBeVisible();
  });

  test("hex goto accepts a 32-bit VA", async ({ tauriPage: page }) => {
    await openPe(page, KERNEL32_X86);
    await pickAddrMode(page, "VA");
    // The entry point is inside `.text` for sure (the first section of this
    // image starts at RVA 0x10000, so `base + 0x1000` would be header gap).
    const va = (await leafLink(page, "AddressOfEntryPoint").innerText()).trim();
    expect(va).toMatch(/^0x1[0-9A-F]{7}$/);
    const gotoInput = page.getByPlaceholder("Address or symbol...").last();
    await gotoInput.fill(va);
    await gotoInput.press("Enter");
    await expect(page.getByText(new RegExp(va, "i")).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("No memory loaded")).not.toBeVisible();
  });

  test("disassembly of a 32-bit PE decodes in 32-bit mode", async ({ tauriPage: page }) => {
    await openPe(page, KERNEL32_X86);
    await pickAddrMode(page, "VA");
    const entry = BigInt((await leafLink(page, "AddressOfEntryPoint").innerText()).trim());
    await page.getByText("Disassembly", { exact: true }).first().click();
    // The view opens at the entry point, a hot-patchable x86 prologue. In
    // 64-bit mode `55` would read as `push rbp`; 32-bit registers prove the
    // Mode32 decoder was picked from the file's machine field.
    const at = (offset: bigint) => page.locator(`${ASM_ROW}[data-address="${rowAddress(entry + offset)}"]`);
    await expect(at(0n)).toContainText(/mov\s*edi,\s*edi/, { timeout: 10_000 });
    await expect(at(2n)).toContainText(/push\s*ebp/);
    await expect(at(3n)).toContainText(/mov\s*ebp,\s*esp/);
  });
});
