/**
 * The per-OS half of the E2E suite: what to launch, which modules and symbols
 * every process is guaranteed to have, and where the system lives. Specs read
 * these instead of spelling out `cmd.exe` / `ntdll` so one spec file covers
 * Windows (cmd.exe, ntdll with PDB symbols) and Linux (the `echo_c` fixture,
 * glibc with its export table).
 */
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const IS_WINDOWS = process.platform === "win32";

/**
 * The app's data directory (persisted breakpoints, patches, bookmarks, ...).
 * Global setup points the app at an isolated one and exports it; the fallback
 * is what `joybug_data_dir()` (src-tauri/src/data_dir.rs) resolves on its own.
 */
export function dataDir(): string {
  if (process.env.JOYBUG_E2E_DATA_DIR) return process.env.JOYBUG_E2E_DATA_DIR;
  if (IS_WINDOWS) {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || "", "JoybugTauri");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "joybug-tauri");
}

/** Absolute path to a built debuggee fixture (see e2e/fixtures/build.mjs).
 *  `hello_c32` is the 32-bit (WOW64) build of hello_c; `overlap_asm` carries
 *  hand-encoded overlapping code. The MASM and WOW64 fixtures only exist on
 *  Windows, `signal_c` (POSIX signals) only off it. */
export function fixtureExe(
  name: "hello_c" | "hello_asm" | "overlap_asm" | "watch_c" | "crash_c" | "hello_c32" | "echo_c" | "sleeper_c" | "signal_c",
): string {
  return path.resolve(__dirname, "..", "fixtures", "bin", `${name}${IS_WINDOWS ? ".exe" : ""}`);
}

/** A target that prints `text` and exits 0 — the default session command. */
export function echoCmd(text: string): string {
  return IS_WINDOWS ? `cmd.exe /c echo ${text}` : `${fixtureExe("echo_c")} ${text}`;
}

/** A target that exits with `code`. */
export function exitCmd(code: number): string {
  return IS_WINDOWS ? `cmd.exe /c "exit /b ${code}"` : `/bin/sh -c "exit ${code}"`;
}

/** A target that exits with the value of the environment variable `name`
 *  (0 when unset) — proves the session's environment reached the process. */
export function exitEnvCmd(name: string): string {
  return IS_WINDOWS ? `cmd.exe /c "exit /b %${name}%"` : `/bin/sh -c "exit \${${name}:-0}"`;
}

/** An existing directory to use as a session's working directory. */
export const SYSTEM_DIR = IS_WINDOWS ? "C:\\Windows" : "/tmp";

/** The offline image viewer's name (`imageTerms` in the app): the format it
 *  is primarily for on each OS. */
export const IMAGE_VIEWER_TITLE = IS_WINDOWS ? "PE Viewer" : "ELF Viewer";
/** The top-level header group of the image viewer's structure tree. */
export const IMAGE_HEADER_GROUP = IS_WINDOWS ? "NT Headers" : "ELF Header";

/** Substring of a module that is loaded in every process by the time of the
 *  initial breakpoint (ntdll / the ELF interpreter). */
export const SYSTEM_MODULE = IS_WINDOWS ? "ntdll" : "ld-linux";

/** Regex matching that module's file name in a label. */
export const SYSTEM_MODULE_FILE = IS_WINDOWS ? /ntdll\.dll/i : /ld-linux/i;

/** The module the initial breakpoint lands in: ntdll's LdrpDoDebuggerBreak on
 *  Windows, the executable's entry point on Linux. */
export const INITIAL_BP_MODULE = IS_WINDOWS ? "ntdll" : "echo_c";

/** A `module!symbol` that resolves in every process launched by `echoCmd`,
 *  and a regex for the symbol's name as a label shows it. The Linux one has
 *  no `__`-alias at the same address, so a label at it names exactly it. */
export const SYSTEM_SYMBOL = IS_WINDOWS ? "ntdll!NtClose" : "libc!getppid";
export const SYSTEM_SYMBOL_NAME = IS_WINDOWS ? /NtClose/ : /getppid/;

/** A module with plenty of embedded strings for the Strings view to scan, and
 *  a word it is sure to contain. */
export const STRINGS_MODULE = IS_WINDOWS ? "cmd.exe" : "libc.so";
export const STRINGS_NEEDLE = IS_WINDOWS ? "microsoft" : "glibc";

/** The module whose symbols the Symbols-table spec searches: thousands of
 *  names from a PDB (ntdll) or an export table (libc). */
export const SYMBOL_MODULE = IS_WINDOWS ? "ntdll" : "libc";

/** Search terms for the Symbols table, with the name each must surface. */
export const SYMBOL_SEARCH = IS_WINDOWS
  ? {
      /** Two tokens, typed in the wrong order. */
      twoTokens: { query: "UnicodeString RtlInit", hit: "RtlInitUnicodeString" },
      /** One token matches the module name, the other the symbol. */
      moduleToken: { query: "ntdll LdrLoadDl", hit: "LdrLoadDll" },
      /** Enough hits (> 3) for a sort order to be meaningful. */
      many: "NtCreate",
      /** Matches the module name, so every one of its symbols (> 1000). */
      bulk: "nt",
      /** A single term with a known hit, for the history checks. */
      single: { query: "LdrLoadDl", hit: "LdrLoadDll" },
      /** Resolves to a small, stable set of function symbols. */
      narrow: "RtlInitUnicodeString",
    }
  : {
      twoTokens: { query: "action sig", hit: "sigaction" },
      moduleToken: { query: "libc pthread_creat", hit: "pthread_create" },
      many: "pthread_",
      bulk: "libc",
      single: { query: "pthread_creat", hit: "pthread_create" },
      narrow: "getppid",
    };

/** A module with thousands of functions in its unwind table (PE `.pdata` /
 *  ELF `.eh_frame`) whose code runs during startup, for the coverage spec.
 *  Substring of the module name as the module list shows it. */
export const COVERAGE_MODULE = IS_WINDOWS ? "ntdll.dll" : "libc.so";

/** Image name of the process `spawnTarget()` starts, as the process list and
 *  the re-attach-by-name resolver see it. */
export const ATTACH_TARGET_IMAGE = IS_WINDOWS ? "ping.exe" : "sleeper_c";
