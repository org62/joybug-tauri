// Build the source-debugging E2E fixtures with MSVC (cl.exe / ml64.exe).
//
// Locates the toolchain via vswhere, then compiles hello_c.c and hello_asm.asm
// with debug info into e2e/fixtures/bin/. Skips a target when its outputs are
// newer than the source (fast no-op on repeated e2e runs). Invoked from
// e2e/global-setup.ts and via `npm run e2e:fixtures`.
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

function main() {
  if (!existsSync(VSWHERE)) throw new Error(`vswhere not found at ${VSWHERE}`);
  mkdirSync(BIN, { recursive: true });

  // C fixtures build for the host arch so the debugger drives a native target.
  const compileC = (name) => {
    const src = path.join(SRC, `${name}.c`);
    const exe = path.join(BIN, `${name}.exe`);
    const pdb = path.join(BIN, `${name}.pdb`);
    const stamp = path.join(BIN, `${name}.arch`);
    if (archStale([exe, pdb], [src], stamp, C_HOST)) {
      console.log(`[fixtures] compiling ${name}.exe (${C_HOST})`);
      runTool(C_HOST, "cl.exe", ["/nologo", "/Od", "/Zi", `/Fe:${exe}`, `/Fd:${pdb}`, `/Fo:${BIN}\\`, src, "/link", "/DEBUG"]);
      writeFileSync(stamp, C_HOST);
    } else {
      console.log(`[fixtures] ${name}.exe up to date (${C_HOST})`);
    }
  };

  compileC("hello_c");
  compileC("watch_c");

  // --- hello_asm.exe (x64 only) ---
  // The .asm is x64 MASM (ml64). On an ARM64 host this builds an x64 image that
  // runs emulated; its test only asserts the source view renders, which does not
  // exercise the breakpoint/step path that emulation breaks. Keeping it x64
  // avoids maintaining a parallel armasm64 source.
  const aSrc = path.join(SRC, "hello_asm.asm");
  const aObj = path.join(BIN, "hello_asm.obj");
  const aExe = path.join(BIN, "hello_asm.exe");
  const aPdb = path.join(BIN, "hello_asm.pdb");
  if (isStale([aExe, aPdb], [aSrc])) {
    console.log("[fixtures] assembling hello_asm.exe (x64)");
    runTool("x64", "ml64.exe", ["/nologo", "/Zi", "/c", `/Fo${aObj}`, aSrc]);
    runTool("x64", "link.exe", [
      "/nologo", "/DEBUG", "/SUBSYSTEM:CONSOLE", "/ENTRY:main",
      `/PDB:${aPdb}`, `/OUT:${aExe}`, aObj, "kernel32.lib",
    ]);
  } else {
    console.log("[fixtures] hello_asm.exe up to date");
  }

  console.log("[fixtures] done:", readdirSync(BIN).filter((f) => f.endsWith(".exe")).join(", "));
}

main();
