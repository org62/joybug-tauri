import { Page } from "@playwright/test";
import { test, expect } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  runPaletteCommand,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  stepAndWaitForNewPc,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW } from "../helpers/selectors";

// Unified back/forward navigation history: one chronological stack covering
// both disassembly address navigation and dock tab switches. Back always
// undoes the most recent user navigation action, whichever kind it was.

async function firstRowText(page: Page): Promise<string> {
  return page.locator(ASM_ROW).first().innerText();
}

/** Poll until the first visible instruction row matches (or stops matching)
 *  the given text — how these tests observe a completed address navigation. */
async function expectFirstRow(
  page: Page,
  text: string,
  opts: { not?: boolean } = {},
): Promise<void> {
  await expect(async () => {
    if (opts.not) expect(await firstRowText(page)).not.toBe(text);
    else expect(await firstRowText(page)).toBe(text);
  }).toPass({ timeout: 10_000, intervals: [100, 250] });
}

/** Synthetic mouse back button (XButton1) press. */
async function pressMouseBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { button: 3, bubbles: true }),
    );
  });
}

/** Navigate the disassembly view via its goto box. */
async function gotoAddress(page: Page, expression: string): Promise<void> {
  const input = page.locator(`${ASM_PANEL} input`).first();
  await input.fill(expression);
  await input.press("Enter");
}

function backButton(page: Page) {
  return page.locator(`${ASM_PANEL} button[title^="Go back"]`);
}

function forwardButton(page: Page) {
  return page.locator(`${ASM_PANEL} button[title^="Go forward"]`);
}

test.describe("Unified navigation history", () => {
  test("back/forward walks disassembly address history", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "NavHist Disasm");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // The initial PC-follow load is not a user navigation — history empty.
      await expect(backButton(page)).toBeDisabled();
      await expect(forwardButton(page)).toBeDisabled();

      // Back with empty history must be a harmless no-op (not get stuck or
      // navigate the page away).
      await page.keyboard.press("Alt+ArrowLeft");
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const original = await firstRowText(page);

      // Navigate somewhere else within ntdll (different function).
      await gotoAddress(page, "rip+0x2000");
      await expectFirstRow(page, original, { not: true });
      const jumped = await firstRowText(page);
      await expect(backButton(page)).toBeEnabled();

      // Back restores the departed address.
      await backButton(page).click();
      await expectFirstRow(page, original);
      await expect(backButton(page)).toBeDisabled();
      await expect(forwardButton(page)).toBeEnabled();

      // Forward re-applies the undone navigation.
      await forwardButton(page).click();
      await expectFirstRow(page, jumped);
      await expect(forwardButton(page)).toBeDisabled();
      await expect(backButton(page)).toBeEnabled();

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("back returns to the previously active window after a tab switch", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "NavHist Tabs");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Switch away from Disassembly (Source shares its panel).
      await goToWindow(page, "Source");
      await expect(page.locator(ASM_PANEL)).toBeHidden();

      // Back → Disassembly is active again.
      await page.keyboard.press("Alt+ArrowLeft");
      await expect(page.locator(ASM_PANEL)).toBeVisible();

      // Forward → Source is active again.
      await page.keyboard.press("Alt+ArrowRight");
      await expect(page.locator(ASM_PANEL)).toBeHidden();

      // Mouse back button (XButton1) walks the same unified history.
      await pressMouseBack(page);
      await expect(page.locator(ASM_PANEL)).toBeVisible();

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("stepping records history: back retraces the step trail", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "NavHist Steps");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Fresh session: initial PC load is not a user action — history empty.
      await expect(backButton(page)).toBeDisabled();

      // Step-in 4 times; each PC move should append one history entry.
      const STEPS = 4;
      for (let i = 0; i < STEPS; i++) {
        await stepAndWaitForNewPc(page, sessionId, "step_in_debug_session");
      }

      // The step trail is in history: exactly STEPS back presses available.
      await expect(backButton(page)).toBeEnabled();
      let backs = 0;
      for (let i = 0; i < STEPS + 3; i++) {
        if (await backButton(page).isDisabled()) break;
        await backButton(page).click();
        backs++;
      }
      expect(backs).toBe(STEPS);
      await expect(forwardButton(page)).toBeEnabled();

      // Exhausted history: another mouse-back must be a no-op — never a
      // fall-through to native page navigation that leaves the session.
      await pressMouseBack(page);
      await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`));
      await expect(page.locator(ASM_PANEL)).toBeVisible();

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("cross-window jump into disassembly backs out to the source window, then to the prior address", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "NavHist Jump");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      const original = await firstRowText(page);

      // Leave Disassembly for Source (records the departed disasm location).
      await goToWindow(page, "Source");
      await expect(page.locator(ASM_PANEL)).toBeHidden();

      // Jump from there into Disassembly at a different address via the
      // command palette's "Go to Address (Disassembly)".
      await runPaletteCommand(page, "Go to Address (Disassembly)");
      const addrInput = page.getByPlaceholder(
        "Enter address or symbol (e.g. 0x00007FF...)",
      );
      await addrInput.waitFor({ state: "visible" });
      await addrInput.fill("rip+0x2000");
      await addrInput.press("Enter");

      await expect(page.locator(ASM_PANEL)).toBeVisible();
      await expectFirstRow(page, original, { not: true });

      // Back #1: undo the jump — return to the Source window, NOT to a
      // previous disassembly address (the original bug).
      await page.keyboard.press("Alt+ArrowLeft");
      await expect(page.locator(ASM_PANEL)).toBeHidden();

      // Back #2: undo the earlier tab switch — Disassembly at its original address.
      await page.keyboard.press("Alt+ArrowLeft");
      await expect(page.locator(ASM_PANEL)).toBeVisible();
      await expectFirstRow(page, original);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
