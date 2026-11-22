import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IS_WINDOWS } from "../helpers/launch-commands";
import {
  cleanupSession,
  createSession,
  fixtureExe,
  goToWindow,
  invoke,
  moduleBase,
  rowAddress,
} from "../helpers/session-helpers";
import { expect, navigateTo, test, type Locator, type Page } from "../helpers/test-fixtures";
import {
  configureMinimalStopSettings,
  continueSession,
  restoreDefaultSettings,
  setArmedBreakpoint,
  waitForPauseOn,
  waitForStatus,
  waitForSymbolVa,
} from "../helpers/wait-helpers";

const LIBRARY = IS_WINDOWS ? "deferred_c.dll" : "deferred_c.so";
const DEBUG_EXT = IS_WINDOWS ? ".pdb" : ".debug";
const FIXTURE_DIR = path.dirname(fixtureExe("hello_c"));
const BUILT_LIBRARY = path.join(FIXTURE_DIR, LIBRARY);
const BUILT_DEBUG = path.join(FIXTURE_DIR, `deferred_c${DEBUG_EXT}`);
const EXPORTED = "deferred_exported";
const PRIVATE = "deferred_private";
const REMOVED = "deferred_private_removed";
const SIMILAR = "deferred_privat";
const OTHER_MODULE_SYMBOL = "hello_c_marker";
const POLL = { timeout: 15_000, intervals: [50, 100, 250] };

type Target = { kind: "symbol"; name: string } | { kind: "rva"; hex: string };
type Gate = "load" | "loaded" | "call" | "unloaded";
interface Fixture {
  library: string;
  launchCommand: string;
  release(phase: "load" | "call", pass: number): void;
  wait(phase: "loaded" | "unloaded", pass: number): Promise<void>;
  reset(): void;
  debugFile(): string;
}

interface SavedRow {
  id: string;
  enabled: boolean;
  is_active: boolean;
  address: number;
  module_name: string;
  module_target: Target | null;
  binding_error?: string;
}

const session = (page: Page, sessionId: string): Promise<{ status: string; breakpoints: SavedRow[] }> =>
  invoke(page, "get_debug_session", { sessionId });
const rows = (page: Page) => page.getByTestId("breakpoint-row");
const addModuleButton = (page: Page) => page.getByTestId("breakpoints-add-module");
const statusBadge = (page: Page, status: string) => page.locator(`[data-session-status="${status}"]`);
const dot = (row: Locator, title: string) => row.locator(`button[title="${title}"]`);
const namedRow = (page: Page, module: string, name: string) =>
  rows(page).filter({ has: page.getByText(`${module}!${name}`, { exact: true }) });

function namedState(breakpoints: SavedRow[], name: string) {
  return breakpoints.find((bp) => bp.module_target?.kind === "symbol" && bp.module_target.name === name);
}

function deferredFixture(dir: string): Fixture {
  const library = path.join(dir, LIBRARY);
  copyFileSync(BUILT_LIBRARY, library);
  const gate = (phase: Gate, pass: number) => path.join(dir, `${phase}-${pass}`);
  return {
    library,
    launchCommand: `"${fixtureExe("hello_c")}" --deferred-breakpoints "${dir}" "${library}"`,
    release: (phase: "load" | "call", pass: number) => writeFileSync(gate(phase, pass), ""),
    wait: async (phase: "loaded" | "unloaded", pass: number) => {
      const marker = gate(phase, pass);
      await expect.poll(() => existsSync(marker), POLL).toBe(true);
    },
    reset() {
      for (const pass of [1, 2]) {
        for (const phase of ["load", "loaded", "call", "unloaded"] as const) {
          rmSync(gate(phase, pass), { force: true });
        }
      }
    },
    debugFile() {
      // The matching file is intentionally unavailable to automatic discovery.
      // Stage it under an unrelated name only when asking for a manual load.
      const file = path.join(dir, `manual-symbols${DEBUG_EXT}`);
      copyFileSync(BUILT_DEBUG, file);
      return file;
    },
  };
}

async function withFixture(
  page: Page,
  run: (fixture: Fixture, openStopped: () => Promise<string>) => Promise<void>,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "joybug-deferred-"));
  let sessionId: string | undefined;
  try {
    const fixture = deferredFixture(dir);
    const openStopped = async () => {
      if (sessionId) await cleanupSession(page, sessionId);
      await navigateTo(page, "/debugger");
      sessionId = await createSession(page, "Deferred breakpoints", { launchCommand: fixture.launchCommand });
      await navigateTo(page, `/session/${sessionId}`);
      await goToWindow(page, "Breakpoints");
      await expect(statusBadge(page, "Stopped")).toBeVisible();
      return sessionId;
    };
    await run(fixture, openStopped);
  } finally {
    try {
      if (sessionId) {
        // Navigation unmounts a potentially open dialog before cleanup, without
        // attempting dock clicks through a modal overlay.
        await navigateTo(page, "/debugger");
        await cleanupSession(page, sessionId);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function addModuleBreakpoint(page: Page, module: string, target: Target, checkInvalidRva = false) {
  await addModuleButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Add module breakpoint" });
  await dialog.getByLabel("Module", { exact: true }).fill(module);
  const add = dialog.getByRole("button", { name: "Add", exact: true });
  if (target.kind === "symbol") {
    await dialog.getByLabel("Symbol", { exact: true }).fill(target.name);
    await add.click();
  } else {
    await dialog.getByRole("combobox", { name: "Target type" }).click();
    await page.getByRole("option", { name: "Hex offset (RVA)", exact: true }).click();
    const offset = dialog.getByLabel("Hex offset (RVA)", { exact: true });
    if (checkInvalidRva) {
      await offset.fill("0x10000000000000000");
      await add.click();
      await expect(dialog.getByRole("alert")).toHaveText(/hexadecimal RVA/i);
      await expect(offset).toHaveValue("0x10000000000000000");
    }
    await offset.fill(target.hex);
    await offset.press("Enter");
  }
  await expect(dialog).toBeHidden();
}

async function offlineRva(page: Page, name: string): Promise<bigint> {
  const useDebug = name !== EXPORTED;
  const file = useDebug && !IS_WINDOWS ? BUILT_DEBUG : BUILT_LIBRARY;
  await invoke(page, "pe_open", { path: file, base: null, pdbPath: useDebug && IS_WINDOWS ? BUILT_DEBUG : null });
  try {
    const hits: { name: string; rva: number }[] = await invoke(page, "pe_search_symbols", {
      path: file, pattern: name, limit: 20,
    });
    const rvas = new Set(hits.filter((hit) => hit.name === name).map((hit) => hit.rva));
    expect(rvas.size, `unique on-disk RVA of ${name}`).toBe(1);
    return BigInt([...rvas][0]);
  } finally {
    await invoke(page, "pe_close", { path: file });
  }
}

async function expectPending(row: Locator) {
  await expect(row.getByText("Pending", { exact: true })).toBeVisible();
  await expect(row.getByText("Unresolved", { exact: true })).toBeVisible();
  await expect(row.locator('[title="0x0"]')).toHaveCount(0);
  await expect(row.getByText("0x0", { exact: true })).toHaveCount(0);
}

async function start(page: Page, sessionId: string) {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const initial = await waitForPauseOn(page, sessionId, "InitialBreakpoint");
  await expect(statusBadge(page, "Paused")).toBeVisible();
  expect(await moduleBase(page, sessionId, LIBRARY)).toBeUndefined();
  return initial;
}

async function waitForUnload(page: Page, sessionId: string, fixture: Fixture, pass: number) {
  await fixture.wait("unloaded", pass);
  await expect(async () => {
    expect((await session(page, sessionId)).status).toBe("Running");
    expect(await moduleBase(page, sessionId, LIBRARY)).toBeUndefined();
  }).toPass(POLL);
}

async function expectArmed(
  page: Page,
  sessionId: string,
  id: string,
  row: Locator,
  address: bigint,
  status: "Paused" | "Running",
) {
  const visibleAddress = new RegExp(`^${rowAddress(address)}$`, "i");
  await expect(async () => {
    const snapshot = await session(page, sessionId);
    const bp = snapshot.breakpoints.find((b) => b.id === id);
    expect(snapshot.status).toBe(status);
    expect(bp?.is_active).toBe(true);
    expect(BigInt(bp!.address)).toBe(address);
    expect(await statusBadge(page, status).isVisible()).toBe(true);
    expect(await dot(row, "Enabled (active)").isVisible()).toBe(true);
    expect(await row.getByText(visibleAddress).isVisible()).toBe(true);
    expect((await session(page, sessionId)).status).toBe(status);
  }).toPass(POLL);
}

async function exerciseRva(
  page: Page, sessionId: string, fixture: Fixture, rva: bigint, id: string, row: Locator, pass: number,
) {
  fixture.release("load", pass);
  await fixture.wait("loaded", pass);
  const base = await moduleBase(page, sessionId, LIBRARY);
  expect(base).toBeTruthy();
  const address = BigInt(base!) + rva;
  // The export cannot execute until we release the call gate. Observing the
  // live dot while Running detects a missed publication that a hit would hide.
  await expectArmed(page, sessionId, id, row, address, "Running");
  fixture.release("call", pass);
  expect(BigInt((await waitForPauseOn(page, sessionId, "Breakpoint")).address)).toBe(address);
  await continueSession(page, sessionId);
  await waitForUnload(page, sessionId, fixture, pass);
  await expectPending(row);
  const bp = (await session(page, sessionId)).breakpoints.find((b) => b.id === id);
  expect(bp).toMatchObject({ address: 0, is_active: false, enabled: true });
}

test.describe("Deferred module breakpoints", () => {
  test.beforeEach(async ({ tauriPage: page }) => {
    await configureMinimalStopSettings(page, { symbol_offline: true });
  });
  test.afterEach(async ({ tauriPage: page }) => {
    await restoreDefaultSettings(page);
  });

  test("persists one RVA request and publishes live bind/unbind across reload and restart", async ({ tauriPage: page }) => {
    test.setTimeout(120_000);
    const rva = await offlineRva(page, EXPORTED);
    expect(rva > 0n).toBe(true);
    const target = { kind: "rva", hex: `0x${rva.toString(16)}` } as const;
    await withFixture(page, async (fixture, openStopped) => {
      const original = await openStopped();
      const panel = page.locator(".absolute.inset-0", { has: addModuleButton(page) }).filter({ visible: true }).last();
      await expect(panel.getByPlaceholder(/^Address/)).toBeDisabled();
      await expect(panel.getByTestId("breakpoints-add-list")).toBeDisabled();
      await expect(addModuleButton(page)).toBeEnabled();
      await addModuleBreakpoint(page, LIBRARY, target, true);
      await addModuleBreakpoint(page, LIBRARY, target);
      expect((await session(page, original)).breakpoints).toHaveLength(1);

      const fresh = await openStopped();
      expect(fresh).not.toBe(original);
      const saved = (await session(page, fresh)).breakpoints;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ module_name: LIBRARY, module_target: target, address: 0, enabled: true, is_active: false });
      const row = rows(page).filter({ has: page.getByText(`${LIBRARY}+${target.hex}`, { exact: true }) });
      await expect(rows(page)).toHaveCount(1);
      await expectPending(row);

      const initial = await start(page, fresh);
      await continueSession(page, fresh);
      await exerciseRva(page, fresh, fixture, rva, saved[0].id, row, 1);
      await exerciseRva(page, fresh, fixture, rva, saved[0].id, row, 2);

      await invoke(page, "restart_debug_session", { sessionId: fresh });
      const restarted = await waitForPauseOn(page, fresh, "InitialBreakpoint");
      expect(restarted.process_id).not.toBe(initial.process_id);
      // Old gates are removed only once the old process is gone and the new
      // one is at its initial stop, so neither can consume the wrong pass.
      fixture.reset();
      await expectPending(row);
      await continueSession(page, fresh);
      await exerciseRva(page, fresh, fixture, rva, saved[0].id, row, 1);
    });
  });

  test("pauses on the named module load, then binds only exact, retained names when debug info arrives", async ({ tauriPage: page }) => {
    test.setTimeout(120_000);
    const rva = await offlineRva(page, PRIVATE);
    await withFixture(page, async (fixture, openStopped) => {
      const sessionId = await openStopped();
      for (const name of [PRIVATE, REMOVED, SIMILAR, OTHER_MODULE_SYMBOL]) {
        await addModuleBreakpoint(page, fixture.library, { kind: "symbol", name });
      }
      const row = namedRow(page, fixture.library, PRIVATE);
      const removed = namedRow(page, fixture.library, REMOVED);
      await expectPending(row);
      await expectPending(removed);
      await start(page, sessionId);
      // This exact name is already present in a different live image. A
      // global fallback would accept it even though the requested one lacks it.
      await waitForSymbolVa(page, sessionId, "hello_c", OTHER_MODULE_SYMBOL);
      await continueSession(page, sessionId);
      await waitForStatus(page, sessionId, "Running");
      fixture.release("load", 1);
      const load = await waitForPauseOn(page, sessionId, "DllLoaded");
      expect(load.details).toContain(LIBRARY);
      await expect(statusBadge(page, "Paused")).toBeVisible();
      await expect(page.getByRole("button", { name: "Go", exact: true })).toBeEnabled();
      await expectPending(row);
      const pending = namedState((await session(page, sessionId)).breakpoints, PRIVATE)!;
      await expect(async () => {
        const current = namedState((await session(page, sessionId)).breakpoints, PRIVATE);
        expect(current?.binding_error).toBeTruthy();
        expect(await row.getByText(current!.binding_error!, { exact: true }).isVisible()).toBe(true);
      }).toPass(POLL);
      const base = await moduleBase(page, sessionId, LIBRARY);
      expect(base).toBeTruthy();

      // Remove a real private function while still unresolved. The later symbol
      // arrival would make it armable, and the fixture calls it before PRIVATE.
      await removed.hover();
      await removed.locator('button[title="Remove breakpoint"]').click();
      await expect(removed).toHaveCount(0);
      const manual = await invoke(page, "load_module_pdb", {
        sessionId, moduleBase: base, pdbPath: fixture.debugFile(), force: false,
      });
      expect(manual.loaded).toBe(true);
      const address = BigInt(base!) + rva;
      await expectArmed(page, sessionId, pending.id, row, address, "Paused");
      expect((await waitForPauseOn(page, sessionId, "DllLoaded")).details).toBe(load.details);
      expect(namedState((await session(page, sessionId)).breakpoints, REMOVED)).toBeUndefined();
      for (const name of [SIMILAR, OTHER_MODULE_SYMBOL]) {
        const missingRow = namedRow(page, fixture.library, name);
        await expectPending(missingRow);
        const bp = namedState((await session(page, sessionId)).breakpoints, name)!;
        expect(bp).toMatchObject({ enabled: true, is_active: false, address: 0 });
        expect(bp.binding_error).toMatch(/not found|missing|does not exist|no exact/i);
        await expect(missingRow.getByText(bp.binding_error!, { exact: true })).toBeVisible();
      }

      await continueSession(page, sessionId);
      await fixture.wait("loaded", 1);
      fixture.release("call", 1);
      expect(BigInt((await waitForPauseOn(page, sessionId, "Breakpoint")).address)).toBe(address);
      await continueSession(page, sessionId);
      await waitForUnload(page, sessionId, fixture, 1);
      expect(namedState((await session(page, sessionId)).breakpoints, REMOVED)).toBeUndefined();
      await expect(removed).toHaveCount(0);
    });
  });

  test("a disabled named request stays disabled offline and neither pauses the load nor traps", async ({ tauriPage: page }) => {
    test.setTimeout(90_000);
    await withFixture(page, async (fixture, openStopped) => {
      const sessionId = await openStopped();
      // An export would bind even without the private debug file if enabled.
      const target = { kind: "symbol", name: EXPORTED } as const;
      await addModuleBreakpoint(page, LIBRARY, target);
      const row = namedRow(page, LIBRARY, EXPORTED);
      await expectPending(row);
      await dot(row, "Enabled (pending)").click();
      await expect(dot(row, "Disabled")).toBeVisible();
      await addModuleBreakpoint(page, LIBRARY, target);
      const saved = (await session(page, sessionId)).breakpoints;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ enabled: false, is_active: false });
      await start(page, sessionId);
      await continueSession(page, sessionId);
      fixture.release("load", 1);
      await fixture.wait("loaded", 1);
      await waitForStatus(page, sessionId, "Running");
      const live = (await session(page, sessionId)).breakpoints;
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ id: saved[0].id, enabled: false, is_active: false });
      await expect(dot(row, "Disabled")).toBeVisible();
      await expect(row.getByText("Pending", { exact: true })).toHaveCount(0);
      fixture.release("call", 1);
      await waitForUnload(page, sessionId, fixture, 1);
    });
  });

  test("publishes the saved ntdll breakpoint while ping is still running after restart", async ({ tauriPage: page }) => {
    test.skip(!IS_WINDOWS, "Windows loader reproduction");
    test.setTimeout(70_000);
    const sessionId = await createSession(page, "Saved ntdll breakpoint", { launchCommand: "ping.exe -n 10 127.0.0.1" });
    try {
      await navigateTo(page, `/session/${sessionId}`);
      await goToWindow(page, "Breakpoints");
      await start(page, sessionId);
      const symbol = await waitForSymbolVa(page, sessionId, "ntdll", "RtlExitUserProcess");
      const rva = BigInt(symbol) - BigInt((await moduleBase(page, sessionId, "ntdll.dll"))!);
      await setArmedBreakpoint(page, sessionId, symbol);
      const [saved] = (await session(page, sessionId)).breakpoints;

      await configureMinimalStopSettings(page, {
        symbol_offline: true, stop_on_process_create: true, stop_on_initial_breakpoint: false,
      });
      await invoke(page, "restart_debug_session", { sessionId });
      await waitForPauseOn(page, sessionId, "ProcessCreated");
      const row = rows(page).first();
      await expectPending(row);
      await continueSession(page, sessionId);
      let base: string | undefined;
      await expect(async () => {
        base = await moduleBase(page, sessionId, "ntdll.dll");
        expect(base).toBeTruthy();
      }).toPass(POLL);
      const address = BigInt(base!) + rva;
      await expectArmed(page, sessionId, saved.id, row, address, "Running");
      expect(BigInt((await waitForPauseOn(page, sessionId, "Breakpoint")).address)).toBe(address);
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
