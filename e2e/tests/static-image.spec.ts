import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { fixtureExe, invoke } from "../helpers/session-helpers";
import { IS_WINDOWS, IMAGE_HEADER_GROUP } from "../helpers/launch-commands";

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
    const insns = await invoke(page, "pe_disassemble", { path: file, va: Number(entry), count: 8 });
    expect(insns.length).toBeGreaterThan(3);
    expect(insns.every((i: { mnemonic: string }) => i.mnemonic.length > 0)).toBe(true);

    // Symbols: the fixture's own (PDB next to it on Windows, the ELF's table
    // on Linux) resolve `main`.
    await expect(async () => {
      const hits = await invoke(page, "pe_search_symbols", { path: file, pattern: "main", limit: 20 });
      expect(hits.some((h: { name: string }) => h.name === "main")).toBe(true);
    }).toPass({ timeout: 20_000, intervals: [50, 100, 250] });
  });
});
