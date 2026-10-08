import { readFileSync, existsSync, rmSync } from "fs";
import path from "path";
import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, invoke } from "../helpers/session-helpers";
import { waitForPaused, configureMinimalStopSettings, restoreDefaultSettings } from "../helpers/wait-helpers";
import { IS_WINDOWS, dataDir } from "../helpers/launch-commands";

const DATA_DIR = dataDir();

/** What the dump is on this OS: a dbghelp minidump, or an ELF core file. */
const DUMP = IS_WINDOWS
  ? { ext: "dmp", magic: Buffer.from("MDMP", "ascii"), written: "Minidump written", menu: [/Create Full Memory Dump/, /Create Minidump/] }
  : { ext: "core", magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), written: "Core dump written", menu: [/Create Full Core Dump/, /Create Core Dump/] };

test.describe("Minidump", () => {
  // dbghelp can't dump a process that is still at CREATE_PROCESS_DEBUG_EVENT
  // (the loader hasn't populated the PEB yet → ERROR_PARTIAL_COPY), so the
  // dump tests pause at the initial breakpoint instead of the first event.
  test.beforeEach(async ({ tauriPage: page }) => { await configureMinimalStopSettings(page); });
  test.afterEach(async ({ tauriPage: page }) => { await restoreDefaultSettings(page); });

  // The native Save dialog can't be driven from Playwright, so the file-writing
  // path is exercised through the backend command the dialog handler invokes;
  // the header menu is checked in the same session for enablement.
  // The dump file name is unique per run: the toast is the barrier that says
  // dbghelp finished writing, so a name shared with an earlier run would let a
  // still-visible stale toast satisfy the wait and the file be read half-written.
  test("write_minidump produces a valid dump file and reports it", async ({ tauriPage: page }, testInfo) => {
    const dumpPath = path.join(DATA_DIR, `e2e-minidump-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.${DUMP.ext}`);
    rmSync(dumpPath, { force: true });

    const sessionId = await createAndStartSession(page, "Minidump Test");
    try {
      await waitForPaused(page, sessionId);

      // Both flavours are offered and enabled while paused.
      await page.getByRole("button", { name: "Stop options" }).click();
      for (const name of DUMP.menu) {
        const item = page.getByRole("menuitem", { name });
        await expect(item).toBeVisible();
        await expect(item).not.toHaveAttribute("data-disabled", "");
      }
      await page.keyboard.press("Escape");

      await invoke(page, "write_minidump", { sessionId, path: dumpPath, fullMemory: false });

      // The session loop toasts once dbghelp has finished writing.
      await expect(page.getByText(`${DUMP.written}: ${dumpPath}`, { exact: false })).toBeVisible({ timeout: 15_000 });

      const dump = readFileSync(dumpPath);
      expect(dump.length).toBeGreaterThan(0x1000);
      expect(dump.subarray(0, 4).equals(DUMP.magic)).toBe(true);
      if (!IS_WINDOWS) {
        // ELF64, little endian, e_type ET_CORE (4), e_machine EM_X86_64 (62).
        expect(dump[4]).toBe(2);
        expect(dump.readUInt16LE(16)).toBe(4);
        expect(dump.readUInt16LE(18)).toBe(62);
      }

      // The target is still paused and usable afterwards.
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session.status).toBe("Paused");
    } finally {
      await cleanupSession(page, sessionId);
      rmSync(dumpPath, { force: true });
    }
  });

  test("unwritable path reports an error toast", async ({ tauriPage: page }, testInfo) => {
    const badPath = path.join(DATA_DIR, "no-such-dir", `x-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.${DUMP.ext}`);
    const sessionId = await createAndStartSession(page, "Minidump Error Test");
    try {
      await waitForPaused(page, sessionId);
      await invoke(page, "write_minidump", { sessionId, path: badPath, fullMemory: false });
      await expect(page.getByText(badPath, { exact: false })).toBeVisible({ timeout: 15_000 });
      expect(existsSync(badPath)).toBe(false);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
