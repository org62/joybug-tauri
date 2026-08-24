import { Page, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { navigateTo } from "./test-fixtures";
import { HEX_ADDRESS, hexPanelFor } from "./selectors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Module entry as returned by the `get_session_modules` command. */
export interface ModuleData {
  name: string;
  base_address: string;
  size: number;
  path: string;
}

/** Absolute path to a built source-debugging fixture exe (see e2e/fixtures/build.mjs). */
export function fixtureExe(name: "hello_c" | "hello_asm" | "watch_c"): string {
  return path.resolve(__dirname, "..", "fixtures", "bin", `${name}.exe`);
}

/** Invoke a Tauri command from the page context. */
export async function invoke(
  page: Page,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return page.evaluate(
    ({ cmd, args }) => (window as any).__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
}

/**
 * Architecture of the *debuggee*, read from the paused session's context. The
 * runner's own architecture is irrelevant — on Windows ARM64 the Node process
 * may be x64-emulated while the debuggee is native ARM64, so process.arch (or
 * sniffing rendered text) is not a reliable proxy. Throws rather than silently
 * defaulting when the session has no paused context.
 */
export async function debuggeeArch(page: Page, sessionId: string): Promise<"X64" | "Arm64"> {
  const s = await invoke(page, "get_debug_session", { sessionId });
  const arch = s?.current_event?.context?.arch;
  if (arch !== "X64" && arch !== "Arm64") {
    throw new Error(`Cannot determine debuggee arch (got ${arch}); is the session paused?`);
  }
  return arch;
}

/**
 * Name of the program-counter register for the *debuggee's* architecture:
 * "rip" on x64, "pc" on ARM64. Use this to build PC-relative goto expressions
 * (e.g. `${await pcRegister(page, id)}+0x2000`) that resolve on either target.
 */
export async function pcRegister(page: Page, sessionId: string): Promise<"rip" | "pc"> {
  return (await debuggeeArch(page, sessionId)) === "Arm64" ? "pc" : "rip";
}

/**
 * Name of the stack-pointer register for the *debuggee's* architecture:
 * "rsp" on x64, "sp" on ARM64. Use this in goto expressions that must resolve
 * on either target.
 */
export async function spRegister(page: Page, sessionId: string): Promise<"rsp" | "sp"> {
  return (await debuggeeArch(page, sessionId)) === "Arm64" ? "sp" : "rsp";
}

/**
 * Program-counter value ("0x..") out of a context object already in hand — the
 * `arch`-tagged union carries `rip` on x64 and `pc` on ARM64. Returns undefined
 * when there is no context (or it is neither arch), so callers can assert on it.
 */
export function contextPc(context: any): string | undefined {
  if (!context) return undefined;
  return context.arch === "Arm64" ? context.pc : context.rip;
}

/**
 * Stack-pointer value ("0x..") out of a context object already in hand — `sp`
 * on ARM64, `rsp` on x64. Undefined when there is no context, so callers can
 * assert on it.
 */
export function contextSp(context: any): string | undefined {
  if (!context) return undefined;
  return context.arch === "Arm64" ? context.sp : context.rsp;
}

/** Module base ("0x..") for the first module whose path/name contains `substr`. */
export async function moduleBase(
  page: Page,
  sessionId: string,
  substr: string,
): Promise<string | undefined> {
  const mods: ModuleData[] = (await invoke(page, "get_session_modules", { sessionId })) || [];
  const sub = substr.toLowerCase();
  return mods.find((m) => m.path.toLowerCase().includes(sub) || m.name.toLowerCase().includes(sub))
    ?.base_address;
}

/** Optional launch fields of the create-session dialog, beyond name/command. */
export interface CreateSessionOptions {
  /** Contents of the "Environment Variables" textarea (KEY=value lines). */
  environment?: string;
}

async function fillOptionalSessionFields(page: Page, opts: CreateSessionOptions) {
  if (opts.environment !== undefined) {
    await page.getByLabel(/Environment Variables/i).fill(opts.environment);
  }
}

/**
 * Create and start a debug session via the UI dialog.
 * Uses `cmd.exe /c "echo hello world"` as the debug target.
 *
 * NOTE: this deliberately drives the real dialog rather than invoking the
 * backend create/start commands directly. A backend fast-path was tried and
 * measurably faster, but removing the dialog's natural pacing made the full
 * suite deeply flaky: ~20 specs then create+start sessions back-to-back with no
 * UI settle time, and the disassembly/symbol-heavy tests (disassembly,
 * navigation-history, pc-follow, input-history, patches) cascaded into repeated
 * page-crash retries. The dialog path is the stable one — keep it.
 *
 * Steps:
 * 1. Navigate to /debugger
 * 2. Click "Create Process"
 * 3. Fill session name
 * 4. Click "Create & Start"
 * 5. Wait for navigation to /session/:id
 *
 * Returns the session ID extracted from the URL.
 */
export async function createAndStartSession(
  page: Page,
  name = "E2E Test Session",
  launchCommand = "cmd.exe /c echo e2e_test",
  opts: CreateSessionOptions = {},
): Promise<string> {
  await navigateTo(page, "/debugger");

  // Click "Create Process" button (header trigger; .first() avoids the
  // empty-state button that shares the label when no sessions exist)
  await page.getByRole("button", { name: /Create Process/i }).first().click();

  // Fill session name
  await page.getByLabel("Session Name").fill(name);

  // Use a unique launch command to avoid loading persisted breakpoints
  // from previous manual debugging sessions
  await page.getByLabel("Launch Command").fill(launchCommand);

  await fillOptionalSessionFields(page, opts);

  // Click "Create & Start"
  await page.getByRole("button", { name: "Create & Start" }).click();

  // Wait for navigation to session page
  await page.waitForURL(/\/session\//, { timeout: 10_000 });

  // Extract session ID from URL
  const url = page.url();
  const match = url.match(/\/session\/(.+)$/);
  if (!match) {
    throw new Error(`Expected URL to contain /session/:id, got: ${url}`);
  }

  return match[1];
}

/**
 * Create a session (without starting it) via the UI dialog.
 * Returns the session ID.
 */
export async function createSession(
  page: Page,
  name = "E2E Test Session",
  opts: CreateSessionOptions = {},
): Promise<string> {
  // Click "Create Process" button (header trigger)
  await page.getByRole("button", { name: /Create Process/i }).first().click();

  // Fill session name
  await page.getByLabel("Session Name").fill(name);

  await fillOptionalSessionFields(page, opts);

  // Click "Create Session" (not "Create & Start")
  await page.getByRole("button", { name: "Create Session", exact: true }).click();

  // Wait for dialog to close and session card to appear
  await expect(page.getByText(name)).toBeVisible({ timeout: 5_000 });

  const session = await findSessionByName(page, name);
  if (!session) {
    throw new Error(`Could not find session with name: ${name}`);
  }

  return session.id;
}

/** The session the backend stored under `name`, or undefined. */
export async function findSessionByName(page: Page, name: string): Promise<any> {
  const sessions = await invoke(page, "get_debug_sessions");
  return sessions.find((s: any) => s.name === name);
}

/**
 * Open the command palette and run a command by its exact label. Matches the
 * label span, not the option's accessible name: the latter also contains the
 * shortcut ("Go to Symbols Ctrl+S"), and a plain substring match would make
 * "Memory" ambiguous with "Memory Search"/"Memory Regions".
 */
export async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const search = page.getByPlaceholder("Type a command or search...");
  await search.waitFor({ state: "visible" });
  await search.fill(label);
  await page
    .getByRole("option")
    .filter({ has: page.locator(`span:text-is("${label}")`) })
    .first()
    .click();
}

/**
 * Open a dock window via the command palette's "Go to X", activating it if it's
 * already open. Most windows are closed in the default layout, so any test that
 * needs one must ask for it first. Prefer this over clicking the Windows menu:
 * it doesn't care which submenu the window lives in.
 */
export async function goToWindow(page: Page, title: string): Promise<void> {
  await runPaletteCommand(page, `Go to ${title}`);
  // Exact-text match (same ambiguity as above): "Memory" must not be satisfied
  // by an open "Memory Search"/"Memory Regions" tab.
  await expect(page.locator(".dock-tab", { hasText: new RegExp(`^${title}$`) }).first()).toBeVisible();
}

/**
 * Close a dock window opened by `goToWindow`. The suite never reloads the page,
 * so a tab left open stays open for every later spec — and a heavy view (one
 * that re-fetches on each pause) then keeps paying that cost in tests that
 * never asked for it. Any spec that opens a window should close it again.
 */
export async function closeWindow(page: Page, title: string): Promise<void> {
  const tab = page.locator(".dock-tab", { hasText: new RegExp(`^${title}$`) }).first();
  await tab.hover();
  await tab.locator(".dock-tab-close-btn").click();
  await expect(tab).toHaveCount(0);
}

/**
 * Toggle a window's checkbox item inside the Windows menu's `group` submenu,
 * then close the menu. Owns the whole open → submenu → click sequence and
 * restarts it from scratch if the menu collapses mid-flight: under heavy UI
 * churn (e.g. a disassembly refresh right after a memory write) Radix's
 * hover-grace timers can fire late and close the submenu underneath the
 * pointer, which a bare item click can never recover from.
 *
 * Only for tests that are *about* the Windows menu — to merely open a window,
 * use `goToWindow`, which goes through the palette and can't hit this race.
 */
export async function clickWindowsMenuItem(page: Page, group: string, item: string): Promise<void> {
  await expect(async () => {
    // Clean slate each attempt: Escape closes any half-open menu, so the
    // trigger click below always opens (never toggles closed). Every click is
    // bounded so a stuck attempt fails fast into the next one instead of
    // hanging until the test timeout (actionTimeout is unset = no limit).
    await page.keyboard.press("Escape");
    // Scoped to <main>: the app header's active-session pill is a button whose
    // accessible name contains the session name, and Playwright matches names
    // by substring — a session called "Windows Toggle" would otherwise make
    // this ambiguous with the dock's own Windows menu.
    await page.getByRole("main").getByRole("button", { name: "Windows" }).click({ timeout: 2_000 });
    await page.getByRole("menuitem", { name: group }).click({ timeout: 2_000 });
    await page.getByRole("menuitemcheckbox", { name: item }).click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000, intervals: [100, 250, 500] });
  // Checkbox items keep the menu open for multi-toggling; dismiss it.
  await page.keyboard.press("Escape");
}

/**
 * Clean up a specific session by stopping and deleting it.
 */
export async function cleanupSession(
  page: Page,
  sessionId: string,
): Promise<void> {
  await page.evaluate(async (id: string) => {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;

    try {
      await invoke("stop_debug_session", { sessionId: id });
    } catch {
      // May already be stopped
    }

    // Poll until stopped instead of hardcoded sleep
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const s = await invoke("get_debug_session", { sessionId: id });
        if (s.status === "Stopped") break;
      } catch {
        break; // Session may not exist
      }
      await new Promise((r) => setTimeout(r, 50 + attempt * 50));
    }

    try {
      await invoke("delete_debug_session", { sessionId: id });
    } catch {
      // May already be deleted
    }
  }, sessionId);
}

/**
 * Undo a spec's dock-layout changes. The suite never reloads the page, so a tab
 * left open stays open for every later spec — and a heavy view then keeps
 * re-fetching in tests that never asked for it. Prefer `closeWindow` when a
 * single tab was opened; use this when the layout itself moved (a tab dragged
 * into a new panel, a panel resized) or when several tabs were opened.
 */
export async function resetDockLayout(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Windows" }).click();
  await page.getByRole("menuitem", { name: "Reset Layout" }).click();
  await page.keyboard.press("Escape");
}

/**
 * Open the Memory tab, navigate it to `addressExpr` (anything the goto box
 * accepts: `rsp`, `ntdll!NtClose`, a literal address) and return the hex panel
 * locator once it has rows.
 *
 * The empty-state panel has to be located by its copy because it renders before
 * the hex panel's own testid exists; scoping to the *visible* one matters
 * because rc-dock keeps hidden panels mounted and the disassembly view has an
 * identical address input.
 */
export async function openMemoryHexPanel(page: Page, addressExpr: string) {
  await goToWindow(page, "Memory");

  const emptyPanel = page
    .locator(".absolute.inset-0", { hasText: "No memory loaded" })
    .filter({ visible: true })
    .last();
  const gotoInput = emptyPanel.getByPlaceholder(/^Address/);
  await gotoInput.waitFor({ state: "visible", timeout: 10_000 });
  await gotoInput.fill(addressExpr);
  await gotoInput.press("Enter");

  const hex = page.locator(hexPanelFor("memory"));
  await expect(hex).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    expect(await hex.locator(HEX_ADDRESS).count()).toBeGreaterThan(4);
  }).toPass({ timeout: 15_000, intervals: [50, 100] });
  return hex;
}
