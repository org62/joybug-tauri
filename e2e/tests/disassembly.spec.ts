import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession } from "../helpers/session-helpers";
import {
  waitForPaused,
  waitForStopped,
  configureMinimalStopSettings,
  restoreDefaultSettings,
  continueSession,
} from "../helpers/wait-helpers";

test.describe("Disassembly View", () => {
  test("shows real x86 mnemonics when paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Mnemonics");
      await waitForPaused(page, sessionId);

      // Wait for disassembly to load — look for common x86-64 mnemonics
      // At InitialBreakpoint in ntdll, we expect instructions like mov, push, sub, call, etc.
      const mnemonics = ["mov", "push", "sub", "call", "int", "lea", "xor", "nop", "ret", "jmp", "cmp", "test"];

      // Wait until at least one mnemonic appears in the disassembly
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        const found = mnemonics.some((m) => text.includes(m));
        expect(found).toBe(true);
      }).toPass({ timeout: 15_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("shows function name containing ntdll in disassembly header", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Ntdll");
      await waitForPaused(page, sessionId);

      // At InitialBreakpoint, RIP is in ntdll — disassembly header should mention ntdll
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).toContain("ntdll");
      }).toPass({ timeout: 15_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });

  test("disassembly clears when session resumes and stops", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Disasm Clear");
      await waitForPaused(page, sessionId);

      // Verify disassembly is showing instructions
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        const hasAsm = ["mov", "push", "sub", "call", "int", "lea"].some(
          (m) => text.includes(m),
        );
        expect(hasAsm).toBe(true);
      }).toPass({ timeout: 15_000 });

      // Continue — process exits, session stops
      await continueSession(page, sessionId);
      await waitForStopped(page, sessionId);

      // Disassembly should be cleared — ntdll function name should be gone
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).not.toMatch(/ntdll.*!/);
      }).toPass({ timeout: 5_000 });

      // Regression: the refresh button must not be stuck spinning after stop
      // (the PC-follow effect used to re-request disassembly against the dead
      // session and the backend swallowed it without an event, so isLoading
      // never cleared).
      const refreshButtons = page.getByRole("button", { name: "Refresh" });
      await expect(refreshButtons.first()).toBeVisible({ timeout: 5_000 });
      await expect(refreshButtons.locator(".animate-spin")).toHaveCount(0, { timeout: 5_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
