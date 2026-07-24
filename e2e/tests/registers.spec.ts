import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, debuggeeArch } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

test.describe("Registers View", () => {
  test("shows real register names and hex values when paused", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);

    try {
      const sessionId = await createAndStartSession(page, "Registers Test");
      await waitForPaused(page, sessionId);

      // Register names depend on the *debuggee* architecture, not the test
      // runner's. (On Windows ARM64 the Node process may be x64-emulated while
      // the debuggee is native ARM64, so process.arch is not a reliable proxy.)
      // Detect from the rendered registers using collision-safe tokens: "rax"
      // and "rsp" only appear on x86-64; "cpsr" only appears on ARM64. Avoid
      // x-registers ("x0".."x28") — they're substrings of hex addresses (0x0..).
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        const hasX64 = text.includes("rax") && text.includes("rsp");
        const hasArm64 = text.includes("cpsr");
        // At InitialBreakpoint we should see a real register set for whichever
        // architecture the debuggee is.
        expect(hasX64 || hasArm64).toBe(true);
      }).toPass({ timeout: 15_000 });

      // Check for hex values (0x...)
      await expect(async () => {
        const text = await page.evaluate(() => document.body.innerText);
        expect(text).toMatch(/0x[0-9a-fA-F]{8,16}/);
      }).toPass({ timeout: 5_000 });

      // Vector registers are hidden by default; toggling reveals them. The set
      // is architecture-specific: XMM (SSE) on x64, NEON (V0-V31) on ARM64.
      const isArm64 = (await debuggeeArch(page, sessionId)) === "Arm64";
      const toggleLabel = isArm64 ? "NEON" : "XMM";
      const firstVecReg = isArm64 ? "v0" : "xmm0";
      const vecToggle = page.getByRole("button", { name: toggleLabel, exact: true });
      await expect(vecToggle).toBeVisible();
      await vecToggle.click();
      await expect(async () => {
        const text = await page.evaluate(() =>
          document.body.innerText.toLowerCase(),
        );
        expect(text).toContain(firstVecReg);
      }).toPass({ timeout: 5_000 });

      await cleanupSession(page, sessionId);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
