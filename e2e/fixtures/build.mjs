// Build the E2E debuggee fixtures.
//
// Windows: MSVC (cl.exe / ml64.exe) located via vswhere, with PDBs. Elsewhere:
// `cc -g` (DWARF). Outputs land in e2e/fixtures/bin/; a target is skipped when
// its outputs are newer than the source (fast no-op on repeated e2e runs).
// Invoked from e2e/global-setup.ts and via `npm run e2e:fixtures`.
import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "src");
const BIN = path.join(__dirname, "bin");

const VSWHERE = path.join(
  process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe",
);

// True host CPU, independent of this process's emulation. On Windows ARM64 the
// Node/Playwright toolchain is often x64-emulated, so `process.arch` and
// PROCESSOR_ARCHITECTURE both report "x64"/"AMD64" and PROCESSOR_ARCHITEW6432 is
// unset. PROCESSOR_IDENTIFIER reflects the physical CPU ("ARMv8 (64-bit) ...")
// even under emulation, so it's the reliable signal.
const HOST_IS_ARM64 = /arm/i.test(process.env.PROCESSOR_IDENTIFIER || "");

// The C fixtures (hello_c/watch_c) are debugged as the *target* process, so they
// must match the debugger's architecture — a native ARM64 debugger stepping an
// emulated-x64 target writes ARM64 breakpoints into x64 code, which faults as
// STATUS_ILLEGAL_INSTRUCTION. Build them for the host arch. hello_asm stays x64
// (its .asm is x64 MASM and its test only checks source rendering, which
// tolerates emulation); see buildHelloAsm.
const C_HOST = HOST_IS_ARM64 ? "arm64" : "x64";
// The WOW64 fixture is deliberately the *other* case: a 32-bit x86 image that
// the 64-bit debugger runs through the WOW64 layer (wow64cpu on x64, xtajit on
// ARM64) using the 32-bit register file. Same on both hosts.
const C_WOW64 = "x86";

/** Find the tool directory (cl.exe / ml64.exe / link.exe) for a Host<h>/<t> pair. */
function findToolDir(hostArch, targetArch) {
  const installPath = execFileSync(
    VSWHERE,
    ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { encoding: "utf8" },
  ).trim();
  if (!installPath) throw new Error("vswhere found no VC tools; install the MSVC C++ workload.");

  const versionFile = path.join(installPath, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const version = readFileSync(versionFile, "utf8").trim();
  const toolDir = path.join(installPath, "VC", "Tools", "MSVC", version, "bin", `Host${hostArch}`, targetArch);
  if (!existsSync(path.join(toolDir, "cl.exe"))) throw new Error(`cl.exe not found in ${toolDir}`);
  return { installPath, version, toolDir };
}

/**
 * Windows SDK + VC include/lib env for a given target arch, via vcvarsall.bat.
 * `arch` is a vcvarsall argument: "x64", "arm64", or a cross form like
 * "amd64_arm64" when the host and target differ.
 */
function toolEnv(installPath, arch) {
  // Delegate to vcvars to assemble INCLUDE/LIB/PATH, then capture the environment.
  // execSync wraps the command in `cmd /d /s /c "..."`, which keeps the quoted
  // batch path intact (execFileSync mangles it).
  const vcvars = path.join(installPath, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  const dump = execSync(`"${vcvars}" ${arch} >nul 2>&1 && set`, { encoding: "utf8", windowsHide: true });
  const env = {};
  for (const line of dump.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * A ready-to-use toolchain: the Host<h>/<t> bin dir plus its vcvars environment.
 * `vcvarsArch` selects native vs cross tools — on an x64 host targeting arm64
 * this is "amd64_arm64"; when host and target match it's just the target.
 * Memoized per target arch: the vswhere + vcvarsall spawns cost seconds, so
 * they run at most once per arch and only when something actually compiles.
 */
const toolchains = new Map();
function toolchain(targetArch) {
  if (!toolchains.has(targetArch)) {
    const hostArch = HOST_IS_ARM64 ? "arm64" : "x64";
    const { installPath, toolDir } = findToolDir(hostArch, targetArch);
    const vcvarsArch = hostArch === targetArch ? targetArch : `${hostArch === "x64" ? "amd64" : hostArch}_${targetArch}`;
    const env = { ...process.env, ...toolEnv(installPath, vcvarsArch) };
    toolchains.set(targetArch, { toolDir, env });
  }
  return toolchains.get(targetArch);
}

/** Run an MSVC tool from the (lazily resolved) toolchain for `targetArch`. */
function runTool(targetArch, exe, args) {
  const { toolDir, env } = toolchain(targetArch);
  execFileSync(path.join(toolDir, exe), args, { cwd: BIN, env, stdio: "inherit" });
}

function isStale(outputs, inputs) {
  for (const o of outputs) if (!existsSync(o)) return true;
  const newestInput = Math.max(...inputs.map((i) => statSync(i).mtimeMs));
  const oldestOutput = Math.min(...outputs.map((o) => statSync(o).mtimeMs));
  return newestInput > oldestOutput;
}

// Every output records which arch it was built for, so a bin/ left over from an
// x64 checkout is rebuilt when the suite later runs on an ARM64 host (mtime
// staleness alone wouldn't catch an arch change with unchanged sources).
function archStale(outputs, inputs, stampPath, wantArch) {
  if (isStale(outputs, inputs)) return true;
  let have = "";
  try { have = readFileSync(stampPath, "utf8").trim(); } catch { /* no stamp */ }
  return have !== wantArch;
}

/**
 * Unix build: every C fixture with `cc`, no PIE (the breakpoint/step specs
 * read addresses off symbols either way, but a fixed image base keeps the
 * disassembly addresses stable between runs) and frame pointers for the
 * call-stack specs. hello_asm/overlap_asm are MASM and have no Unix build —
 * their specs are Windows-only.
 */
function mainUnix() {
  mkdirSync(BIN, { recursive: true });
  const cc = process.env.CC || "cc";
  // signal_c is Unix-only (POSIX signals); the rest also build with MSVC.
  for (const name of ["hello_c", "watch_c", "crash_c", "echo_c", "sleeper_c", "signal_c"]) {
    const src = path.join(SRC, `${name}.c`);
    const exe = path.join(BIN, name);
    if (!isStale([exe], [src, path.join(SRC, "portable.h")])) {
      console.log(`[fixtures] ${name} up to date`);
      continue;
    }
    console.log(`[fixtures] compiling ${name}`);
    execFileSync(
      cc,
      ["-g", "-gdwarf-5", "-O0", "-fno-omit-frame-pointer", "-no-pie", "-pthread", "-o", exe, src],
      { stdio: "inherit" },
    );
  }
  console.log("[fixtures] done:", readdirSync(BIN).filter((f) => !f.includes(".")).join(", "));
}

function main() {
  if (process.platform !== "win32") return mainUnix();
  if (!existsSync(VSWHERE)) throw new Error(`vswhere not found at ${VSWHERE}`);
  mkdirSync(BIN, { recursive: true });

  // C fixtures build for the host arch so the debugger drives a native target.
  // `outName` lets one source build twice (hello_c → hello_c32 for WOW64).
  const compileC = (name, arch = C_HOST, outName = name) => {
    const src = path.join(SRC, `${name}.c`);
    const exe = path.join(BIN, `${outName}.exe`);
    const pdb = path.join(BIN, `${outName}.pdb`);
    const obj = path.join(BIN, `${outName}.obj`);
    const stamp = path.join(BIN, `${outName}.arch`);
    if (archStale([exe, pdb], [src], stamp, arch)) {
      console.log(`[fixtures] compiling ${outName}.exe (${arch})`);
      runTool(arch, "cl.exe", ["/nologo", "/Od", "/Zi", `/Fe:${exe}`, `/Fd:${pdb}`, `/Fo:${obj}`, src, "/link", "/DEBUG"]);
      writeFileSync(stamp, arch);
    } else {
      console.log(`[fixtures] ${outName}.exe up to date (${arch})`);
    }
  };

  compileC("hello_c");
  compileC("watch_c");
  compileC("crash_c");
  compileC("echo_c");
  compileC("sleeper_c");
  // 32-bit build of the same program for the WOW64 spec.
  compileC("hello_c", C_WOW64, "hello_c32");

  // --- MASM fixtures (x64 only) ---
  // The .asm sources are x64 MASM (ml64). On an ARM64 host these build x64
  // images that run emulated; their tests either only assert the source view
  // renders (hello_asm) or never run/step the target at all (overlap_asm), so
  // neither exercises the breakpoint/step path that emulation breaks. Keeping
  // them x64 avoids maintaining a parallel armasm64 source. Being arch-pinned,
  // they need no `.arch` stamp — plain mtime staleness is enough.
  const assemble = (name) => {
    const src = path.join(SRC, `${name}.asm`);
    const obj = path.join(BIN, `${name}.obj`);
    const exe = path.join(BIN, `${name}.exe`);
    const pdb = path.join(BIN, `${name}.pdb`);
    if (!isStale([exe, pdb], [src])) {
      console.log(`[fixtures] ${name}.exe up to date`);
      return;
    }
    console.log(`[fixtures] assembling ${name}.exe (x64)`);
    runTool("x64", "ml64.exe", ["/nologo", "/Zi", "/c", `/Fo${obj}`, src]);
    runTool("x64", "link.exe", [
      "/nologo", "/DEBUG", "/SUBSYSTEM:CONSOLE", "/ENTRY:main",
      `/PDB:${pdb}`, `/OUT:${exe}`, obj, "kernel32.lib",
    ]);
  };

  assemble("hello_asm");
  // Overlapping code (an instruction hidden in another's immediate) for the
  // mid-instruction disassembly spec.
  assemble("overlap_asm");

  console.log("[fixtures] done:", readdirSync(BIN).filter((f) => f.endsWith(".exe")).join(", "));
}

main();
