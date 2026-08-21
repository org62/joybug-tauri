import { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../helpers/test-fixtures";
import { cleanupSession, invoke, goToWindow } from "../helpers/session-helpers";
import { spawnTarget, isAlive, killQuietly } from "../helpers/process-helpers";
import {
  installEventCapture,
  waitForCapturedEvent,
} from "../helpers/event-helpers";
import {
  waitForPaused,
  waitForStatus,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";

/**
 * Create + start a non-invasive session against `pid` directly through the
 * backend, navigate to it, and wait until it reaches Open (no debug loop,
 * no pause). Returns the session id.
 */
async function createOpenSession(page: Page, pid: number): Promise<string> {
  const sessionId: string = await invoke(page, "create_debug_session", {
    name: `Open ${pid}`,
    serverUrl: "",
    launchCommand: "ping.exe",
    workingDirectory: null,
    isLocalRun: true,
    attachPid: pid,
    nonInvasive: true,
  });
  await invoke(page, "start_debug_session", { sessionId });

  await navigateTo(page, `/session/${sessionId}`);
  await waitForStatus(page, sessionId, "Open", 15_000);
  return sessionId;
}

interface SectionHeader {
  VirtualSize: number;
  VirtualAddress: number;
  SizeOfRawData: number;
  Characteristics: number;
}

const IMAGE_SCN_MEM_EXECUTE = 0x2000_0000;
/** A run this long of one repeated byte is alignment padding, never real code. */
const PAD_RUN = 16;
/**
 * Distance the chosen byte keeps from either end of the section's initialized
 * data. Restore diffs a +/-64-byte window that has to resolve inside a single
 * section, so a byte too near a boundary is silently un-restorable.
 */
const PAD_MARGIN = 0x100;

/**
 * Pick a byte inside a module's executable section that is safe to modify while
 * the target keeps running: one in the middle of an inter-function alignment run
 * (`int3` padding on x64), which is never executed.
 *
 * The search is bounded by the section header rather than by the mapped region:
 * the scan only diffs code that is backed by on-disk bytes, so the range has to
 * stop at `min(SizeOfRawData, VirtualSize)` — past that lies the zero-filled
 * tail, which the scan ignores and which would look like a padding run.
 */
async function findPaddingByte(
  page: Page,
  sessionId: string,
): Promise<{ address: bigint; value: number }> {
  const modules: { name: string; base_address: string }[] = await invoke(
    page,
    "get_session_modules",
    { sessionId },
  );
  const main = modules.find((m) => m.name.toLowerCase().endsWith("ping.exe"));
  expect(main, "target's own image should be enumerated").toBeTruthy();
  const base = BigInt(main!.base_address);

  await installEventCapture(page, ["module-extra-info-updated"]);
  await invoke(page, "request_module_extra_info", {
    sessionId,
    moduleBase: main!.base_address,
  });
  const info = await waitForCapturedEvent(
    page,
    "module-extra-info-updated",
    (p) => p.session_id === sessionId && !!p.info?.sections?.length,
    15_000,
  );

  for (const s of info.info.sections as SectionHeader[]) {
    if (!(s.Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
    const size = Math.min(s.SizeOfRawData, s.VirtualSize, 0x100000);
    if (size <= PAD_MARGIN * 2) continue;
    const bytes: number[] | null = await invoke(page, "read_memory_sync", {
      sessionId,
      address: `0x${(base + BigInt(s.VirtualAddress)).toString(16)}`,
      size,
    });
    if (!bytes?.length) continue;

    const limit = Math.min(bytes.length, size) - PAD_MARGIN;
    let runStart = PAD_MARGIN;
    for (let i = PAD_MARGIN + 1; i < limit; i++) {
      if (bytes[i] !== bytes[runStart]) {
        runStart = i;
        continue;
      }
      if (i - runStart + 1 >= PAD_RUN) {
        const idx = runStart + PAD_RUN / 2;
        return {
          address: base + BigInt(s.VirtualAddress) + BigInt(idx),
          value: bytes[idx],
        };
      }
    }
  }
  throw new Error("no alignment padding found in the target's executable sections");
}

/** Backend hex formatting for an image-patch row address ("0x7FF8ABCD1234"). */
const rowAddress = (address: bigint) => `0x${address.toString(16).toUpperCase()}`;

test.describe("Non-invasive mode", () => {
  test("open a process non-invasively: reaches Open, never attaches, enumerates modules/threads", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      expect(pid).toBeGreaterThan(0);

      sessionId = await createOpenSession(page, pid);

      // The backend recorded the target PID.
      const session = await invoke(page, "get_debug_session", { sessionId });
      expect(session?.attach_pid).toBe(pid);

      // Module/thread enumeration works with no debugger attach (Toolhelp
      // fallback). A non-invasive Open session has no debug loop to populate
      // the cached lists, so each call goes to the server over OOB; right
      // after OpenProcess the Toolhelp snapshot can momentarily come back
      // empty, so poll until the enumeration settles rather than reading once.
      const expectNonEmptyList = async (cmd: string) => {
        await expect(async () => {
          const items = await invoke(page, cmd, { sessionId });
          expect(Array.isArray(items)).toBe(true);
          expect(items.length).toBeGreaterThan(0);
        }).toPass({ timeout: 10_000, intervals: [50, 100, 250] });
      };
      await expectNonEmptyList("get_session_modules");
      await expectNonEmptyList("get_session_threads");

      // A memory scan must run over the OOB scan connection against the
      // never-attached process. Starting one should resolve without error.
      await invoke(page, "request_scan_memory_start", {
        sessionId,
        valueType: "U32",
        compareType: "UnknownInitialValue",
        value: null,
        value2: null,
        alignment: 4,
        floatTolerance: null,
        writableOnly: true,
      });

      // The whole point of non-invasive: the target was never attached/suspended
      // and keeps running the entire time.
      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
    }
  });

  test("stopping a non-invasive session leaves the target running", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      sessionId = await createOpenSession(page, pid);

      // Stop the session — a non-invasive stop must NOT terminate the target.
      await invoke(page, "stop_debug_session", { sessionId });

      await waitForStatus(page, sessionId!, "Stopped", 15_000);

      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
    }
  });

  test("Image Patches scans and restores without ever attaching", async ({
    tauriPage: page,
  }) => {
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      sessionId = await createOpenSession(page, pid);

      // An Open session has no debug loop to populate the cached module list, so
      // the scan has to enumerate over OOB — the whole point of this test.
      const { address, value } = await findPaddingByte(page, sessionId);

      // Open the window and let its mount-time auto-scan settle before writing:
      // an earlier test may have left the tab in the dock layout (which survives
      // in memory between tests), so that first scan can already have run. The
      // explicit rescan below is the one this test measures.
      await goToWindow(page, "Image Patches");
      const rescan = page.locator('button[title="Rescan all modules"]');
      await expect(rescan).toBeEnabled({ timeout: 20_000 });

      await invoke(page, "request_memory_write", {
        sessionId,
        address: Number(address),
        data: [value ^ 0xff],
      });
      await rescan.click();

      const row = page.locator('[data-testid="image-patch-row"]', {
        hasText: rowAddress(address),
      });
      await expect(row).toHaveCount(1, { timeout: 20_000 });

      await row.hover();
      await row.getByRole("button", { name: "Restore original bytes" }).click();
      await expect(
        page.locator('[data-testid="image-patch-row"]', { hasText: rowAddress(address) }),
      ).toHaveCount(0, { timeout: 15_000 });

      // Never attached, never suspended.
      expect(isAlive(pid)).toBe(true);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
    }
  });

  test("attaching from an Open session reaches Paused (enables full debugging)", async ({
    tauriPage: page,
  }) => {
    await configureMinimalStopSettings(page);
    const target = spawnTarget();
    const pid = target.pid!;
    let sessionId: string | undefined;

    try {
      sessionId = await createOpenSession(page, pid);

      // Promote the non-invasive session to a full attached debug session.
      await invoke(page, "attach_open_session", { sessionId });

      // Attaching injects a breakpoint, so the session pauses and becomes invasive.
      await waitForPaused(page, sessionId);

      const s = await invoke(page, "get_debug_session", { sessionId });
      expect(s.non_invasive).toBe(false);
      expect(s.attach_pid).toBe(pid);
    } finally {
      if (sessionId) await cleanupSession(page, sessionId);
      killQuietly(pid);
      await restoreDefaultSettings(page);
    }
  });
});
