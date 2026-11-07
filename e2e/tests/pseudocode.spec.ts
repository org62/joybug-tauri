import { test, expect, navigateTo } from "../helpers/test-fixtures";
import type { Page } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, closeWindow, fixtureExe, goToWindow, invoke } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForModuleSymbols,
  waitForSymbolVa,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
  setArmedBreakpoint,
  stepAndWaitForNewPc,
} from "../helpers/wait-helpers";
import { FN_DISASM_EVENT, installEventCapture, listFunction } from "../helpers/event-helpers";
import {
  ASM_PANEL,
  SELECTED_ROW,
  PSEUDOCODE_PANEL,
  PSEUDOCODE_ROW,
  PSEUDOCODE_FUNCTION,
  PSEUDOCODE_CODE_ROW,
  PSEUDOCODE_PC_ROW,
  PSEUDOCODE_NAV_ROW,
} from "../helpers/selectors";

const POLL = { timeout: 15_000, intervals: [50, 100, 250] };

/** The dock tab with exactly this title. */
const dockTab = (page: Page, title: string) => page.locator(".dock-tab", { hasText: new RegExp(`^${title}$`) }).first();

/** Whether a (hex) address lies in `[start, end)`. */
const within = (start: string, end: string) => (address: string | null) =>
  address !== null && BigInt(address) >= BigInt(start) && BigInt(address) < BigInt(end);

/** The line number of the single row matching `selector`. */
async function lineOf(page: Page, selector: string): Promise<number> {
  const row = page.locator(selector);
  await expect(row).toHaveCount(1, POLL);
  return Number(await row.getAttribute("data-line"));
}

test.describe("Pseudocode", () => {
  test("decompiles the paused function and stays in sync with the disassembly", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    // A launch command of its own: breakpoints persist per command.
    const sessionId = await createAndStartSession(page, "Pseudocode", `${fixtureExe("hello_c")} pseudocode`);
    let opened = false;
    try {
      await waitForPaused(page, sessionId);
      await waitForModuleSymbols(page, sessionId, "hello_c", { minSymbolCount: 1, timeout: 20_000 });

      // Run to hello_c_marker: a function of the fixture that calls compute().
      const marker = await waitForSymbolVa(page, sessionId, "hello_c", "hello_c_marker");
      await setArmedBreakpoint(page, sessionId, marker);
      await continueSession(page, sessionId);
      await waitForPaused(page, sessionId);
      await installEventCapture(page, [FN_DISASM_EVENT]);
      const bounds = await listFunction(page, sessionId, Number(BigInt(marker)));
      const inFunction = within(bounds.function_start!, bounds.function_end!);

      // The view opens on the function the PC is in, named from our symbols,
      // as highlighted C, with the PC on the signature (we stopped at its head).
      await goToWindow(page, "Pseudocode");
      opened = true;
      await expect(page.locator(PSEUDOCODE_FUNCTION)).toHaveText("hello_c_marker", POLL);
      const text = (await page.locator(PSEUDOCODE_ROW).allTextContents()).join("\n");
      expect(text).toContain("hello_c_marker(");
      expect(text).toContain("compute(");
      expect(await page.locator(`${PSEUDOCODE_PANEL} .tok-keyword`).count()).toBeGreaterThan(0);
      expect(await lineOf(page, PSEUDOCODE_PC_ROW)).toBe(1);

      // Stepping inside the function moves the PC line; the function stays.
      await expect(async () => {
        await stepAndWaitForNewPc(page, sessionId, "step_over_debug_session");
        expect(await lineOf(page, PSEUDOCODE_PC_ROW)).toBeGreaterThan(1);
      }).toPass({ timeout: 30_000, intervals: [50] });
      await expect(page.locator(PSEUDOCODE_FUNCTION)).toHaveText("hello_c_marker");

      // A line's gutter sets a breakpoint on its first instruction.
      const codeRow = page.locator(PSEUDOCODE_CODE_ROW).first();
      const codeLine = Number(await codeRow.getAttribute("data-line"));
      await codeRow.getByTestId("pseudocode-row-gutter").click();
      await expect(page.locator(`${PSEUDOCODE_ROW}[data-line="${codeLine}"]`)).toHaveAttribute("data-breakpoint", "true", POLL);
      const session = await invoke(page, "get_debug_session", { sessionId });
      const lineBreakpoints = (session.breakpoints as { address: string }[]).filter((b) => inFunction(b.address) && BigInt(b.address) !== BigInt(marker));
      expect(lineBreakpoints).toHaveLength(1);
      await codeRow.getByTestId("pseudocode-row-gutter").click();
      await expect(page.locator(`${PSEUDOCODE_ROW}[data-line="${codeLine}"]`)).not.toHaveAttribute("data-breakpoint", POLL);

      // A line leads to its instruction: the Disassembly tab takes over with a
      // row of this function selected.
      await codeRow.dblclick();
      await expect(dockTab(page, "Disassembly")).toHaveClass(/dock-tab-active/, POLL);
      await expect(async () => {
        expect(inFunction(await page.locator(SELECTED_ROW).first().getAttribute("data-address"))).toBe(true);
      }).toPass(POLL);

      // And an instruction leads to its line: clicking that row marks the
      // line as the navigation target, without taking the tab.
      await page.locator(SELECTED_ROW).first().click();
      await expect(dockTab(page, "Disassembly")).toHaveClass(/dock-tab-active/);
      await dockTab(page, "Pseudocode").click();
      expect(await lineOf(page, PSEUDOCODE_NAV_ROW)).toBe(codeLine);

      // A navigation with an unchanged PC must not suppress the very next
      // real PC update. Follow PC removes the navigation tint on that step.
      await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      await expect(page.locator(PSEUDOCODE_NAV_ROW)).toHaveCount(0, POLL);
      await expect(page.locator(PSEUDOCODE_PC_ROW)).toHaveCount(1, POLL);

      // Stepping into compute() switches the view to that function.
      await expect(async () => {
        await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
        await expect(page.locator(PSEUDOCODE_FUNCTION)).toHaveText("compute", { timeout: 2_000 });
      }).toPass({ timeout: 60_000, intervals: [50] });
      expect((await page.locator(PSEUDOCODE_ROW).allTextContents()).join("\n")).toContain("compute(");
      await expect(page.locator(PSEUDOCODE_PC_ROW)).toHaveCount(1, POLL);

      // The pseudocode comes from the module's file. Once the function's code
      // in memory is no longer what the file holds, the view says so.
      const differs = page.getByTestId("pseudocode-memory-differs");
      await expect(differs).toHaveCount(0);
      const pc = (await invoke(page, "get_debug_session", { sessionId })).current_event.address as number;
      const listing = await listFunction(page, sessionId, pc);
      const last = listing.instructions[listing.instructions.length - 1];
      await invoke(page, "request_memory_write", {
        sessionId,
        address: Number(BigInt(last.address)),
        data: [parseInt(last.bytes.split(" ")[0], 16) ^ 0xff],
      });
      await expect(async () => {
        await page.getByRole("button", { name: "Decompile again" }).click();
        await expect(differs).toBeVisible({ timeout: 1_000 });
      }).toPass(POLL);
      await expect(page.locator(PSEUDOCODE_FUNCTION)).toHaveText("compute");

      // No process, no pseudocode: the shared stopped state, not an error.
      await invoke(page, "stop_debug_session", { sessionId });
      await expect(page.locator(PSEUDOCODE_PANEL).getByText("Pseudocode unavailable")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(PSEUDOCODE_ROW)).toHaveCount(0);
    } finally {
      if (opened) await closeWindow(page, "Pseudocode");
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });

  test("decompiles a file in the image viewer, with no process", async ({ tauriPage: page }) => {
    const file = fixtureExe("hello_c");
    if ((await page.url()).includes("/pe")) await navigateTo(page, "/");
    await navigateTo(page, "/pe?path=" + encodeURIComponent(file));

    // The tab opens on the file's entry point.
    await dockTab(page, "Pseudocode").click();
    await expect(page.locator(PSEUDOCODE_CODE_ROW).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(PSEUDOCODE_FUNCTION)).not.toHaveText("No function");
    // A file has no PC to follow and nothing to break on.
    await expect(page.locator(PSEUDOCODE_PANEL).getByText("Follow PC")).toHaveCount(0);
    await expect(page.getByTestId("pseudocode-row-gutter")).toHaveCount(0);

    // What the view shows is what the backend decompiles at the entry point.
    const summary = await invoke(page, "pe_open", { path: file, base: null, pdbPath: null });
    const entry = BigInt(summary.base) + BigInt(summary.info.nt_headers.OptionalHeader.AddressOfEntryPoint);
    const outcome = await invoke(page, "pe_decompile", {
      path: file,
      va: `0x${entry.toString(16)}`,
      client: { id: "image-viewer-contract", sequence: 1 },
    });
    expect(outcome.status).toBe("ok");
    await expect(page.locator(PSEUDOCODE_FUNCTION)).toHaveText(outcome.name);
    const inFunction = within(outcome.start, outcome.end);

    // Line → instruction, and back.
    const codeRow = page.locator(PSEUDOCODE_CODE_ROW).first();
    const codeLine = Number(await codeRow.getAttribute("data-line"));
    await codeRow.dblclick();
    await expect(dockTab(page, "Disassembly")).toHaveClass(/dock-tab-active/, POLL);
    const selected = page.locator(SELECTED_ROW).first();
    await expect(async () => {
      expect(inFunction(await selected.getAttribute("data-address"))).toBe(true);
    }).toPass(POLL);
    await selected.click();
    await dockTab(page, "Pseudocode").click();
    expect(await lineOf(page, PSEUDOCODE_NAV_ROW)).toBe(codeLine);

    // Reopening the same file at a new base is a new image, not a symbol
    // refresh. A line must now navigate to its rebased instruction.
    const delta = 0x10000000n;
    const rebased = `0x${(BigInt(summary.base) + delta).toString(16)}`;
    await navigateTo(page, `/pe?path=${encodeURIComponent(file)}&base=${rebased}`);
    // Wait for dispatch; the rebased-address assertion waits for the new image.
    await page.waitForURL(/\/pe$/, { timeout: 10_000 });
    await dockTab(page, "Pseudocode").click();
    await expect(page.locator(PSEUDOCODE_NAV_ROW)).toHaveCount(0, POLL);
    await expect(page.locator(PSEUDOCODE_CODE_ROW).first()).toBeVisible(POLL);
    await page.locator(PSEUDOCODE_CODE_ROW).first().dblclick();
    const inRebasedFunction = within(
      `0x${(BigInt(outcome.start) + delta).toString(16)}`,
      `0x${(BigInt(outcome.end) + delta).toString(16)}`,
    );
    await expect(async () => {
      expect(inRebasedFunction(await page.locator(SELECTED_ROW).first().getAttribute("data-address"))).toBe(true);
    }).toPass(POLL);
  });

  test("does not consume a session's pending instruction in the image viewer", async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page);
    // Leave no cached image host mounted to consume the pending request before
    // the next file has opened.
    await navigateTo(page, "/pe");
    const closeFile = page.getByRole("button", { name: "Close", exact: true });
    if (await closeFile.count()) await closeFile.click();
    await expect(page.locator(PSEUDOCODE_PANEL)).toHaveCount(0);
    const file = fixtureExe("hello_c");
    const sessionId = await createAndStartSession(page, "Pseudocode scope", `${file} pseudocode-scope`);
    try {
      await waitForPaused(page, sessionId);
      await waitForModuleSymbols(page, sessionId, "hello_c", { minSymbolCount: 1, timeout: 20_000 });
      const compute = await waitForSymbolVa(page, sessionId, "hello_c", "compute");
      await goToWindow(page, "Disassembly");
      const input = page.locator(`${ASM_PANEL} input`).first();
      await input.fill(compute);
      await input.press("Enter");
      await expect(async () => {
        const address = await page.locator(SELECTED_ROW).first().getAttribute("data-address");
        expect(address === null ? null : BigInt(address)).toBe(BigInt(compute));
      }).toPass(POLL);
      // No pseudocode tab is mounted to consume this session-scoped request.
      await expect(page.locator(PSEUDOCODE_PANEL)).toHaveCount(0);
      await page.locator(SELECTED_ROW).first().click();
      await navigateTo(page, `/pe?path=${encodeURIComponent(file)}`);
      await page.waitForURL(/\/pe$/, { timeout: 10_000 });
      await dockTab(page, "Pseudocode").click();
      await expect(page.locator(PSEUDOCODE_CODE_ROW).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(PSEUDOCODE_NAV_ROW)).toHaveCount(0, POLL);
      await expect(page.locator(PSEUDOCODE_FUNCTION)).not.toHaveText("compute");
    } finally {
      await cleanupSession(page, sessionId);
      await restoreDefaultSettings(page);
    }
  });
});
