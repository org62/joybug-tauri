import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { fixtureExe, invoke } from "../helpers/session-helpers";
import { IS_WINDOWS, IMAGE_HEADER_GROUP } from "../helpers/launch-commands";
import { openPe, pick } from "../helpers/pe-helpers";
import { ASM_PANEL, ASM_ROW, SELECTED_ROW } from "../helpers/selectors";
import { assemblyViewport, expectAssemblyContext, expectAssemblyWheel, refreshUnderPointer } from "../helpers/assembly-viewport";
import type { Page } from "../helpers/test-fixtures";

async function gotoVa(page: Page, va: string) {
  const input = page.locator(`${ASM_PANEL} input`).first();
  await input.fill(va);
  await input.press("Enter");
}

/**
 * The offline image viewer on the suite's own fixture: a PE on Windows, an
 * ELF on Linux, through the same page and the same commands. The structure
 * tree, the file's sections and a disassembly of the entry point come out of
 * the file alone — no process, no debugger.
 */
test.describe("Static image viewer", () => {
  test("opens the echo fixture and shows its headers, sections and entry code", async ({
    tauriPage: page,
  }) => {
    const file = fixtureExe("echo_c");
    if ((await page.url()).includes("/pe")) await navigateTo(page, "/");
    await navigateTo(page, "/pe?path=" + encodeURIComponent(file));

    const fileName = file.split(/[\\/]/).pop()!;
    await expect(page.getByText(fileName, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    // The header group names the format; the rest of the tree is shared.
    await expect(
      page.getByText(IMAGE_HEADER_GROUP, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Sections", { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId("pe-arch-badge")).toContainText(IS_WINDOWS ? /PE32/ : /ELF/);

    // The backend's view of the same file: sections with a .text, an entry
    // point inside the image, and instructions decoded at it.
    const summary = await invoke(page, "pe_open", { path: file, base: null, pdbPath: null });
    const names = summary.info.sections.map((s: { Name: number[] }) =>
      String.fromCharCode(...s.Name.filter((b: number) => b !== 0)),
    );
    expect(names).toContain(".text");
    const base = BigInt(summary.base);
    const entry = base + BigInt(summary.info.nt_headers.OptionalHeader.AddressOfEntryPoint);
    expect(entry > base).toBe(true);
    const insns = await invoke(page, "pe_disassemble", { path: file, kind: "forward", va: `0x${entry.toString(16)}`, count: 8 });
    expect(insns.length).toBeGreaterThan(3);
    expect(insns.every((i: { mnemonic: string }) => i.mnemonic.length > 0)).toBe(true);

    await page.getByText("Disassembly", { exact: true }).first().click();
    await expect(async () => {
      expect((await assemblyViewport(page))?.rows.some((row) => row.address === entry)).toBe(true);
    }).toPass({ timeout: 10_000, intervals: [50, 100] });

    // Symbols: the fixture's own (PDB next to it on Windows, the ELF's table
    // on Linux) resolve `main`.
    await expect(async () => {
      const hits = await invoke(page, "pe_search_symbols", { path: file, pattern: "main", limit: 20 });
      expect(hits.some((h: { name: string }) => h.name === "main")).toBe(true);
    }).toPass({ timeout: 20_000, intervals: [50, 100, 250] });
  });

  test("interior VA and its predecessor stay visible after Refresh; wheel prepends on disk", async ({ tauriPage: page }) => {
    const file = fixtureExe("hello_c");
    if ((await page.url()).includes("/pe")) await navigateTo(page, "/");
    await navigateTo(page, "/pe?path=" + encodeURIComponent(file));
    await expect(page.getByTestId("pe-arch-badge")).toBeVisible();
    await expect(page.getByText(file.split(/[\\/]/).pop()!, { exact: false }).first()).toBeVisible();
    await pick(page, "pe-addr-mode", "VA");
    await page.getByText("Disassembly", { exact: true }).first().click();

    const symbols: { name: string; va: string }[] = await invoke(page, "pe_search_symbols", {
      path: file, pattern: "hello_c_marker", limit: 20,
    });
    const marker = symbols.find((s) => s.name === "hello_c_marker");
    expect(marker).toBeTruthy();
    const sample: { address: string }[] = await invoke(page, "pe_disassemble", {
      path: file, kind: "forward", va: marker!.va, count: 4,
    });
    expect(sample.length).toBe(4);
    const address = BigInt(sample[2].address);
    const context = { highlight: "selected", predecessor: BigInt(sample[1].address) } as const;
    await gotoVa(page, sample[2].address);
    await expectAssemblyContext(page, address, context);
    await refreshUnderPointer(page);
    await expectAssemblyContext(page, address, context);
    await expectAssemblyWheel(page, -1);
  });

  test("PE unwind alignment preserves a literal overlapping goto", async ({ tauriPage: page }) => {
    test.skip(!IS_WINDOWS, "Requires the MASM overlap fixture");
    const file = fixtureExe("overlap_asm");
    await openPe(page, file);
    await pick(page, "pe-addr-mode", "VA");
    await page.getByText("Disassembly", { exact: true }).first().click();
    const symbols: { name: string; va: string }[] = await invoke(page, "pe_search_symbols", {
      path: file, pattern: "overlap_fn", limit: 20,
    });
    const fn = symbols.find((s) => s.name === "overlap_fn");
    expect(fn).toBeTruthy();
    const address = BigInt(fn!.va);
    const hidden = `0x${(address + 3n).toString(16)}`;
    await gotoVa(page, hidden);
    const selected = page.locator(SELECTED_ROW);
    await expect(selected).toHaveAttribute("data-address", new RegExp(`^${hidden}$`, "i"));
    await expect(selected).toContainText("rdtsc");

    await gotoVa(page, fn!.va);
    await expect(selected).toHaveAttribute("data-address", new RegExp(`^${fn!.va}$`, "i"));
    const mov = `0x${(address + 1n).toString(16)}`;
    await expect(page.locator(`${ASM_ROW}[data-address="${mov}" i]`)).toContainText("movabs");
  });
});
