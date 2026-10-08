import { test, expect } from "../helpers/test-fixtures";
import { findSessionById, invoke } from "../helpers/session-helpers";
import { IS_WINDOWS } from "../helpers/launch-commands";

/**
 * The Linux platform end to end, with no fixture involved: Playwright's
 * Chromium → the __TAURI_INTERNALS__ shim → the WebSocket bridge → a real
 * Tauri command → the embedded LocalServer → the ptrace backend → the
 * `session-updated` event → React. A system binary is launched, pauses at its
 * entry point (the Linux InitialBreakpoint), and runs to a clean exit.
 */
test.describe("Linux platform", () => {
  test.skip(IS_WINDOWS, "exercises the ptrace backend");

  test("launches a system binary, pauses at the entry point and runs to exit 0", async ({ tauriPage: page }) => {
    const sessionId: string = await invoke(page, "create_debug_session", {
      name: "linux platform",
      serverUrl: "",
      launchCommand: "/bin/true",
      workingDirectory: null,
      isLocalRun: true,
      attachPid: null,
      nonInvasive: null,
    });
    await invoke(page, "start_debug_session", { sessionId });

    // Default settings stop on every event; walk them until the initial
    // breakpoint, which must come after the loader has mapped the libraries.
    let seenLibc = false;
    for (let i = 0; i < 50; i++) {
      let session: any;
      await expect(async () => {
        session = await findSessionById(page, sessionId);
        expect(session?.status).toBe("Paused");
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
      const event = session.current_event;
      if (event?.event_type === "DllLoaded" && /libc\.so/.test(event.details ?? "")) seenLibc = true;
      if (event?.event_type === "InitialBreakpoint") break;
      const before = JSON.stringify(event);
      await invoke(page, "step_debug_session", { sessionId });
      await expect(async () => {
        const s = await findSessionById(page, sessionId);
        expect(s?.status !== "Paused" || JSON.stringify(s.current_event) !== before).toBe(true);
      }).toPass({ timeout: 10_000, intervals: [50, 100] });
    }
    const paused = await findSessionById(page, sessionId);
    expect(paused.current_event.event_type).toBe("InitialBreakpoint");
    expect(seenLibc, "libc should be reported before the initial breakpoint").toBe(true);

    // The entry point is inside the executable, and the interpreter is a module.
    const modules: { name: string; base_address: string; size: number }[] =
      await invoke(page, "get_session_modules", { sessionId });
    expect(modules.some((m) => /ld-linux/.test(m.name))).toBe(true);
    const pc = BigInt(paused.current_event.address);
    const exe = modules.find((m) => BigInt(m.base_address) <= pc && pc < BigInt(m.base_address) + BigInt(m.size));
    expect(exe?.name, "PC should be inside the main module").toMatch(/true$/);

    // The vdso has no file, yet its symbols load from the image in memory.
    await expect(async () => {
      const statuses: { module_path: string; status: string; symbol_count: number | null }[] =
        await invoke(page, "get_session_symbol_status", { sessionId });
      const vdso = statuses.find((s) => s.module_path === "[vdso]");
      expect(vdso?.status).toBe("loaded");
      expect(vdso?.symbol_count ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000, intervals: [50, 100] });

    // Go: the process exits 0 and the session stops.
    await invoke(page, "step_debug_session", { sessionId });
    await expect(async () => {
      const s = await findSessionById(page, sessionId);
      expect(s?.status).toBe("Stopped");
    }).toPass({ timeout: 15_000, intervals: [50, 100] });
    await invoke(page, "delete_debug_session", { sessionId });
  });
});
