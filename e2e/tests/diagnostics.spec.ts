import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke } from "../helpers/session-helpers";
import { waitForPaused, waitForDisassemblyLoaded, configureMinimalStopSettings, waitForModuleSymbols } from "../helpers/wait-helpers";
import { installEventCapture, getCapturedEvents, listFunction, FN_DISASM_EVENT, type FunctionListing } from "../helpers/event-helpers";
import { ASM_PANEL, ASM_LABEL_ROW } from "../helpers/selectors";
import { INITIAL_BP_MODULE, SYMBOL_MODULE, SYSTEM_SYMBOL, SYSTEM_SYMBOL_NAME } from "../helpers/launch-commands";

/**
 * The diagnostic disassembly switches (Settings -> Diagnostics): the same
 * listing without symbols, and as a plain linear decode. They exist so a user
 * with a slow disassembly view can tell which part of a listing is slow.
 */

/**
 * The address of exactly `module!symbol`. The module matters: another module
 * that imports the function has a same-named thunk of its own (a bare `jmp`
 * with no unwind entry, so no function bounds and no function name), and
 * which of the two a name-only search returns first depends on which symbol
 * file happened to finish loading.
 */
async function symbolVa(page: any, sessionId: string, qualified: string): Promise<number> {
  const name = qualified.split("!")[1];
  let va = "";
  await expect(async () => {
    await invoke(page, "search_session_symbols", { sessionId, pattern: name, limit: 50 });
    const hit = (await getCapturedEvents(page, "symbols-updated"))
      .flatMap((e: { symbols?: { display_name?: string; va?: string }[] }) => e.symbols ?? [])
      .find((s) => s.display_name?.toLowerCase() === qualified.toLowerCase() && s.va);
    expect(hit, `${qualified} should resolve`).toBeTruthy();
    va = hit!.va!;
  }).toPass({ timeout: 30_000, intervals: [50, 100, 250] });
  return Number(BigInt(va));
}

test.describe("Disassembly diagnostics", () => {
  test("skip symbolization and naive disassembly change the listing and switch back", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    await installEventCapture(page, [FN_DISASM_EVENT, "symbols-updated"]);
    const sessionId = await createAndStartSession(page, "Disasm Diagnostics");
    try {
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      await waitForModuleSymbols(page, sessionId, SYMBOL_MODULE);
      const symbolModule = SYSTEM_SYMBOL.split("!")[0];
      const va = await symbolVa(page, sessionId, SYSTEM_SYMBOL);
      const labelled = (listing: FunctionListing) => listing.instructions.filter((i) => i.symbols.length > 0);

      // The default: the function is named and its head row carries the label.
      // Several names can share the address (NtClose/ZwClose): the function
      // takes one of them, the row lists them all.
      const full = await listFunction(page, sessionId, va);
      expect(full.function_name ?? "").toMatch(new RegExp(`^${symbolModule}!`, "i"));
      expect(labelled(full).some((i) => i.symbols.some((s) => SYSTEM_SYMBOL_NAME.test(s)))).toBe(true);
      // ... and the view shows label rows for the function the target stopped in.
      const moduleLabel = new RegExp(`${INITIAL_BP_MODULE}!`, "i");
      await expect(async () => {
        const labels = await page.locator(ASM_LABEL_ROW).allInnerTexts();
        expect(labels.some((t) => moduleLabel.test(t))).toBe(true);
      }).toPass({ timeout: 15_000, intervals: [100, 200] });

      // Without symbols: the same instructions and bounds, nothing named.
      await configureMinimalStopSettings(page, { diag_skip_symbolization: true });
      const plain = await listFunction(page, sessionId, va);
      expect(plain.function_name).toBeNull();
      expect(labelled(plain)).toHaveLength(0);
      expect(plain.function_start).toBe(full.function_start);
      expect(plain.function_end).toBe(full.function_end);
      expect(plain.instructions.map((i) => i.address)).toEqual(full.instructions.map((i) => i.address));
      // The open view reloaded on its own and lost its labels.
      await expect(page.locator(ASM_LABEL_ROW)).toHaveCount(0, { timeout: 10_000 });

      // Naive: a linear decode from the address, no function at all.
      await configureMinimalStopSettings(page, { diag_naive_disassembly: true });
      const naive = await listFunction(page, sessionId, va, { maxInstructions: 20 });
      expect(naive.function_start).toBeNull();
      expect(naive.function_end).toBeNull();
      expect(naive.function_name).toBeNull();
      expect(naive.instructions).toHaveLength(20);
      expect(BigInt(naive.instructions[0].address)).toBe(BigInt(va));
      expect(labelled(naive)).toHaveLength(0);
      // The view still shows a listing.
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Back to the default: names return, in the request and in the view.
      await configureMinimalStopSettings(page);
      const again = await listFunction(page, sessionId, va);
      expect(again.function_name).toBe(full.function_name);
      expect(labelled(again).length).toBe(labelled(full).length);
      await expect(async () => {
        const labels = await page.locator(ASM_LABEL_ROW).allInnerTexts();
        expect(labels.some((t) => moduleLabel.test(t))).toBe(true);
      }).toPass({ timeout: 15_000, intervals: [100, 200] });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("the switches live in Settings and persist", async ({ tauriPage: page }) => {
    await navigateTo(page, "/settings?tab=diagnostics");
    await expect(page.getByTestId("settings-diagnostics")).toBeVisible({ timeout: 5_000 });

    const telemetry = page.getByRole("switch", { name: "Send anonymous performance data" });
    await expect(telemetry).toHaveAttribute("data-state", "unchecked");
    const naive = page.getByRole("switch", { name: "Naive disassembly (linear decode only)" });
    await expect(naive).toHaveAttribute("data-state", "unchecked");

    await naive.click();
    await expect(naive).toHaveAttribute("data-state", "checked");
    await expect(async () => {
      expect((await invoke(page, "get_debug_settings")).diag_naive_disassembly).toBe(true);
    }).toPass({ intervals: [50, 100], timeout: 5_000 });

    // A second writer on the same page must not undo it: every settings
    // section holds the settings, and each writes the whole object.
    await navigateTo(page, "/settings?tab=all");
    await expect(page.getByRole("switch", { name: "Naive disassembly (linear decode only)" })).toHaveAttribute("data-state", "checked");
    await page.getByRole("switch", { name: "Automatically check for updates" }).click();
    await page.getByTestId("setting-telemetry-file").click();
    await expect(async () => {
      const s = await invoke(page, "get_debug_settings");
      expect(s.auto_update_check).toBe(false);
      expect(s.telemetry_record_to_file).toBe(true);
      expect(s.diag_naive_disassembly).toBe(true);
    }).toPass({ intervals: [50, 100], timeout: 5_000 });

    // The status line says what is going on.
    await expect(page.getByTestId("telemetry-status")).toContainText("Recording to", { timeout: 10_000 });
  });
});
