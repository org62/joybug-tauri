import { writeFileSync, copyFileSync, readFileSync } from "fs";
import { IS_WINDOWS, dataDir } from "../helpers/launch-commands";
import path from "path";
import { test, expect } from "../helpers/test-fixtures";
import { createAndStartSession, cleanupSession, fixtureExe, invoke, moduleBase } from "../helpers/session-helpers";
import {
  waitForPaused,
  configureMinimalStopSettings,
  restoreDefaultSettings,
} from "../helpers/wait-helpers";
import type { Page } from "../helpers/test-fixtures";

const DATA_DIR = dataDir();
const OVERRIDES_FILE = path.join(DATA_DIR, "symbol_overrides.json");
// A copy of hello_c's debug file at a path the loader would never auto-discover,
// so a symbol status showing THIS path proves our manual/persisted load won — not
// the next-to-exe auto-load. The PDB on Windows; on Linux the debug info lives
// in the ELF itself, so a copy of the executable is the debug file.
const PDB_COPY = path.join(DATA_DIR, IS_WINDOWS ? "manual_sym_copy.pdb" : "manual_sym_copy.debug");
const PDB_SRC = IS_WINDOWS ? fixtureExe("hello_c").replace(/\.exe$/i, ".pdb") : fixtureExe("hello_c");
const MODULE_FILE = IS_WINDOWS ? "hello_c.exe" : "hello_c";
// Distinct arg → distinct launch_command → isolated override-store key.
const LAUNCH = `${fixtureExe("hello_c")} sympersist`;

interface SymbolStatus {
  module_path: string;
  base_address: string;
  status: string;
  symbol_count: number | null;
  pdb_path: string | null;
}

async function getStatuses(page: Page, sessionId: string): Promise<SymbolStatus[]> {
  return invoke(page, "get_session_symbol_status", { sessionId });
}

/** Poll until hello_c's symbol status reports the given pdb path (substring). */
async function waitForHelloCPdb(page: Page, sessionId: string, pdbSubstr: string, timeout = 20_000): Promise<void> {
  await expect(async () => {
    const statuses = await getStatuses(page, sessionId);
    const hc = statuses.find((s) => s.module_path.toLowerCase().includes("hello_c"));
    expect(hc?.status).toBe("loaded");
    expect((hc?.pdb_path ?? "").toLowerCase()).toContain(pdbSubstr.toLowerCase());
  }).toPass({ timeout, intervals: [200, 500] });
}

test.describe("Manual PDB persistence", () => {
  test.beforeEach(() => {
    // Isolate from other runs / prior state.
    try { writeFileSync(OVERRIDES_FILE, "{}", "utf-8"); } catch { /* dir may not exist yet */ }
    copyFileSync(PDB_SRC, PDB_COPY);
  });

  test("a manually-loaded PDB persists and is auto-applied to a fresh session on the same target", async ({
    tauriPage: page,
  }) => {
    test.setTimeout(90_000);
    await configureMinimalStopSettings(page);

    try {
      // --- Session 1: manually load the PDB copy ---
      const session1 = await createAndStartSession(page, "Sym Persist 1", LAUNCH);
      await waitForPaused(page, session1);

      let base: string | undefined;
      await expect(async () => {
        base = await moduleBase(page, session1, "hello_c");
        expect(base).toBeTruthy();
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      const result = await invoke(page, "load_module_pdb", {
        sessionId: session1,
        moduleBase: base,
        pdbPath: PDB_COPY,
        force: true,
      });
      expect(result.loaded).toBe(true);

      // The manual load is now active for hello_c.
      await waitForHelloCPdb(page, session1, "manual_sym_copy");

      // It was persisted to the override store under this launch command.
      await expect(async () => {
        const map = JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8"));
        const entries = map[LAUNCH];
        expect(Array.isArray(entries)).toBe(true);
        const hc = entries.find((o: any) => o.module_name.toLowerCase() === MODULE_FILE);
        expect(hc).toBeTruthy();
        expect(hc.pdb_path.toLowerCase()).toContain("manual_sym_copy");
        expect(hc.force).toBe(true);
      }).toPass({ timeout: 5_000 });

      await cleanupSession(page, session1);

      // --- Session 2: a brand-new session on the same target picks it up ---
      const session2 = await createAndStartSession(page, "Sym Persist 2", LAUNCH);
      await waitForPaused(page, session2);

      await expect(async () => {
        const b = await moduleBase(page, session2, "hello_c");
        expect(b).toBeTruthy();
      }).toPass({ timeout: 10_000, intervals: [100, 250] });

      // The persisted manual PDB (custom path) was re-applied automatically,
      // without any user action in this fresh session.
      await waitForHelloCPdb(page, session2, "manual_sym_copy");

      await cleanupSession(page, session2);
    } finally {
      await restoreDefaultSettings(page);
    }
  });
});
