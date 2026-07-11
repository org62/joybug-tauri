// Build the source-debugging E2E fixtures with MSVC (cl.exe / ml64.exe).
//
// Locates the toolchain via vswhere, then compiles hello_c.c and hello_asm.asm
// with debug info into e2e/fixtures/bin/. Skips a target when its outputs are
// newer than the source (fast no-op on repeated e2e runs). Invoked from
// e2e/global-setup.ts and via `npm run e2e:fixtures`.
import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync } from "fs";
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

/** Find the Hostx64/x64 tool directory that holds cl.exe / ml64.exe / link.exe. */
function findToolDir() {
  const installPath = execFileSync(
    VSWHERE,
    ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { encoding: "utf8" },
  ).trim();
  if (!installPath) throw new Error("vswhere found no VC x64 tools; install the MSVC C++ workload.");

  const versionFile = path.join(installPath, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const version = readFileSync(versionFile, "utf8").trim();
  const toolDir = path.join(installPath, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64");
  if (!existsSync(path.join(toolDir, "cl.exe"))) throw new Error(`cl.exe not found in ${toolDir}`);
  return { installPath, version, toolDir };
}

/** Windows SDK + VC include/lib env so cl/ml64/link find headers and import libs. */
function toolEnv(installPath) {
  // Delegate to vcvars to assemble INCLUDE/LIB/PATH, then capture the environment.
  // execSync wraps the command in `cmd /d /s /c "..."`, which keeps the quoted
  // batch path intact (execFileSync mangles it).
  const vcvars = path.join(installPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const dump = execSync(`"${vcvars}" >nul 2>&1 && set`, { encoding: "utf8", windowsHide: true });
  const env = {};
  for (const line of dump.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function isStale(outputs, inputs) {
  for (const o of outputs) if (!existsSync(o)) return true;
  const newestInput = Math.max(...inputs.map((i) => statSync(i).mtimeMs));
  const oldestOutput = Math.min(...outputs.map((o) => statSync(o).mtimeMs));
  return newestInput > oldestOutput;
}

function main() {
  if (!existsSync(VSWHERE)) throw new Error(`vswhere not found at ${VSWHERE}`);
  mkdirSync(BIN, { recursive: true });
  const { installPath, toolDir } = findToolDir();
  const env = { ...process.env, ...toolEnv(installPath) };
  const run = (exe, args) =>
    execFileSync(path.join(toolDir, exe), args, { cwd: BIN, env, stdio: "inherit" });

  // --- hello_c.exe ---
  const cSrc = path.join(SRC, "hello_c.c");
  const cExe = path.join(BIN, "hello_c.exe");
  const cPdb = path.join(BIN, "hello_c.pdb");
  if (isStale([cExe, cPdb], [cSrc])) {
    console.log("[fixtures] compiling hello_c.exe");
    run("cl.exe", ["/nologo", "/Od", "/Zi", `/Fe:${cExe}`, `/Fd:${cPdb}`, `/Fo:${BIN}\\`, cSrc, "/link", "/DEBUG"]);
  } else {
    console.log("[fixtures] hello_c.exe up to date");
  }

  // --- hello_asm.exe ---
  const aSrc = path.join(SRC, "hello_asm.asm");
  const aObj = path.join(BIN, "hello_asm.obj");
  const aExe = path.join(BIN, "hello_asm.exe");
  const aPdb = path.join(BIN, "hello_asm.pdb");
  if (isStale([aExe, aPdb], [aSrc])) {
    console.log("[fixtures] assembling hello_asm.exe");
    run("ml64.exe", ["/nologo", "/Zi", "/c", `/Fo${aObj}`, aSrc]);
    run("link.exe", [
      "/nologo", "/DEBUG", "/SUBSYSTEM:CONSOLE", "/ENTRY:main",
      `/PDB:${aPdb}`, `/OUT:${aExe}`, aObj, "kernel32.lib",
    ]);
  } else {
    console.log("[fixtures] hello_asm.exe up to date");
  }

  console.log("[fixtures] done:", readdirSync(BIN).filter((f) => f.endsWith(".exe")).join(", "));
}

main();
