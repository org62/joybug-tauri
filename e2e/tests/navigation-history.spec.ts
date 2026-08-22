import { Page } from "@playwright/test";
import { test, expect, navigateTo, gotoFreshPe, APP_ORIGIN } from "../helpers/test-fixtures";
import {
  createAndStartSession,
  cleanupSession,
  goToWindow,
  runPaletteCommand,
  pcRegister,
} from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForDisassemblyLoaded,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  stepAndWaitForNewPc,
} from "../helpers/wait-helpers";
import { ASM_PANEL, ASM_ROW } from "../helpers/selectors";

// Unified back/forward navigation history: one app-wide chronological stack
// covering page changes, dock tab switches and disassembly address
// navigation. Back always undoes the most recent user navigation action,
// whichever kind it was.

/** Start from an empty trail (the fixture resets it too, but reaching the
 *  session page — /debugger → /session/:id — is itself history). */
async function resetNavHistory(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("joybug:reset-nav-history")));
}

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
      await resetNavHistory(page);

      // The initial PC-follow load is not a user navigation — history empty.
      await expect(backButton(page)).toBeDisabled();
      await expect(forwardButton(page)).toBeDisabled();

      // Back with empty history must be a harmless no-op (not get stuck or
      // navigate the page away).
      await page.keyboard.press("Alt+ArrowLeft");
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      const original = await firstRowText(page);

      // Navigate somewhere else within ntdll (different function).
      await gotoAddress(page, `${await pcRegister(page, sessionId)}+0x2000`);
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
      await resetNavHistory(page);

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
      await resetNavHistory(page);

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
      await resetNavHistory(page);
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
      await addrInput.fill(`${await pcRegister(page, sessionId)}+0x2000`);
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

  test("back crosses pages: session disassembly → previous page → forward again", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "NavHist Pages");
      await waitForPaused(page, sessionId);
      await waitForDisassemblyLoaded(page, ASM_PANEL);

      // Visit Logs, then come back to the session — both are history.
      await navigateTo(page, "/logs");
      await expect(page.getByRole("heading", { name: "Application Logs" })).toBeVisible();
      await resetNavHistory(page);
      await navigateTo(page, `/session/${sessionId}`);
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      const original = await firstRowText(page);

      await gotoAddress(page, `${await pcRegister(page, sessionId)}+0x2000`);
      await expectFirstRow(page, original, { not: true });
      const jumped = await firstRowText(page);

      // Back #1: undo the goto (most recent action) — still on the session page.
      await page.keyboard.press("Alt+ArrowLeft");
      await expectFirstRow(page, original);
      await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`));

      // Back #2: the page change before it — Logs, not older disassembly history.
      await page.keyboard.press("Alt+ArrowLeft");
      await expect(page).toHaveURL(/\/logs$/);
      await expect(page.getByRole("heading", { name: "Application Logs" })).toBeVisible();

      // Back #3: history exhausted — stays put.
      await pressMouseBack(page);
      await expect(page).toHaveURL(/\/logs$/);

      // Forward: back into the session, disassembly at the pre-goto address,
      // then forward again re-applies the goto.
      await page.keyboard.press("Alt+ArrowRight");
      await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`));
      await waitForDisassemblyLoaded(page, ASM_PANEL);
      await expectFirstRow(page, original);
      await page.keyboard.press("Alt+ArrowRight");
      await expectFirstRow(page, jumped);

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("PE reader: back leaves the page; a fresh history is a no-op", async ({
    tauriPage: page,
  }) => {
    const NTDLL = "C:\\Windows\\System32\\ntdll.dll";

    // No history at all: back must not navigate anywhere (nor get stuck).
    await gotoFreshPe(page);
    await resetNavHistory(page);
    await pressMouseBack(page);
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page).toHaveURL(`${APP_ORIGIN}/pe`);

    // Logs → PE (deep link, which the reader rewrites to /pe — a REPLACE that
    // must not count as a move) → back returns to Logs.
    await navigateTo(page, "/logs");
    await expect(page.getByRole("heading", { name: "Application Logs" })).toBeVisible();
    await navigateTo(page, "/pe?path=" + encodeURIComponent(NTDLL));
    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(`${APP_ORIGIN}/pe`);

    await pressMouseBack(page);
    await expect(page).toHaveURL(/\/logs$/);
    await expect(page.getByRole("heading", { name: "Application Logs" })).toBeVisible();

    // Forward returns to the reader with the file still open.
    await page.keyboard.press("Alt+ArrowRight");
    await expect(page).toHaveURL(`${APP_ORIGIN}/pe`);
    await expect(page.getByText("DOS Header", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });
});
