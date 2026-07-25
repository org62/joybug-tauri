---
name: e2e
description: Build the Joybug debug binary and run the Playwright E2E suite on Windows (incl. the ARM64 host gotchas — CMake/keystone build break, MSVC env for fixtures, host-arch fixtures, stray-process cleanup, backend trace capture).
---

# Build & run the E2E tests

`npx playwright test --config e2e/playwright.config.ts` is the whole command — but on a fresh checkout it fails for several non-obvious reasons. Work through the prerequisites first. Full suite ≈ 5–6 min (slower on ARM64, see below).

`e2e/global-setup.ts` starts Vite + launches the debug binary with CDP; `global-teardown.ts` stops them. You do NOT start those yourself — you just need the binary built and the env right.

## 1. Prerequisites (do these once per checkout)

**Node deps** — `node_modules` is often incomplete on a fresh checkout (e.g. `prismjs` missing → Vite overlay error `Failed to resolve import "prismjs"`). Fix:
```bash
npm install
```

**Build the Rust debug binary** — global-setup expects `src-tauri/target/debug/joybug-tauri.exe` and does NOT build it. Build inside the MSVC dev environment for your host arch:
```powershell
# from PowerShell; ARM64 host shown (use vcvars64.bat / x64 on an x64 host)
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1" -Arch arm64 -SkipAutomaticLocation
cd C:\temp\joybug-tauri\src-tauri
cargo build
```

### CMake/keystone build break (VS ships CMake ≥ 4.1)
`keystone-engine`'s bundled CMakeLists needs `cmake_minimum_required(<3.5)`, which CMake 4 removed — the build panics in its build script. Also, CMake 3.x doesn't know the "Visual Studio 18 2026" generator. Workaround: put an older CMake on PATH and force the Ninja generator (Ninja ships with VS):
```powershell
pip install cmake==3.31.6   # once
# then, in the build shell, BEFORE cargo build:
$env:PATH = "C:\Users\<you>\AppData\Local\Programs\Python\Python3xx-arm64\Lib\site-packages\cmake\data\bin;" + $env:PATH
$env:CMAKE_GENERATOR = "Ninja"
```
If a prior failed build left a stale cache, delete it first: `rm -rf src-tauri/target/debug/build/keystone-engine-*/out` (error: "generator ... Does not match the generator used previously"). See memory `build-keystone-cmake4`.

The joybug-core submodule builds/tests the same way but needs `LIBCLANG_PATH`; see `external/joybug-core/CLAUDE.md` for its one-liners.

## 2. Run the suite

Run from a shell that has the MSVC env loaded — global-setup builds the MSVC fixtures (`e2e/fixtures/build.mjs`) on first run and needs `cl.exe`/`ml64.exe` on PATH:
```powershell
& "C:\Program Files\...\Launch-VsDevShell.ps1" -Arch arm64 -SkipAutomaticLocation   # or bash: source the vcvars env
cd C:\temp\joybug-tauri
npx playwright test --config e2e/playwright.config.ts
```
Useful flags: a spec substring to scope (`... source-view`), `-g "<title>"` for one test, `--repeat-each=N` to check stability (the repo has **zero tolerance for flaky tests** — treat a retry-pass as a failure and fix the race). `retries: 2` is set in the config, so a failing test runs 3× and inflates wall time.

Background it and tee to a log for long runs; interim output is buffered until the run ends, so poll the log file.

## 3. Fixtures must match the DEBUGGER's architecture

The C fixtures (`hello_c.exe`, `watch_c.exe`) are the debugged **target**. joybug-core is a native debugger — it writes breakpoints/single-steps for its own arch and does NOT correctly debug an emulated cross-arch target. `build.mjs` builds the C fixtures for the host arch (detected via `PROCESSOR_IDENTIFIER`, which survives emulation) and stamps `<name>.arch`. If you ever see breakpoint/step/watchpoint tests hang or the target fault with `STATUS_ILLEGAL_INSTRUCTION`, suspect an arch-mismatched fixture (e.g. a stale x64 `e2e/fixtures/bin/` on ARM64). `hello_asm.exe` stays x64 on purpose. See memory `e2e-fixtures-host-arch`.

## 4. Stray-process cleanup (breaks the NEXT run)

WebView2 keys its browser process by the shared user-data dir, so a leftover `joybug-tauri.exe` makes the next run attach to the stale instance and never open the CDP port. Before a run, or after a killed/crashed run:
```bash
tasklist //FI "IMAGENAME eq joybug-tauri.exe"   # check
```
```powershell
taskkill /IM joybug-tauri.exe /T /F 2>$null; taskkill /IM node.exe /F 2>$null
```
Symptom of leftovers: a run where every test after ~#15 fails instantly (~350ms each) — the app died and Playwright spawns a fresh worker per test/retry against nothing.

## 5. Debugging a failing test — capture backend trace

The debug binary logs to stdout with a `RUST_LOG` env filter, but global-setup only forwards `ERROR`/`panic` lines. To capture full backend trace, temporarily tee the spawned binary's stdout+stderr in `global-setup.ts` (guard it behind an env var so it's easy to revert), set `RUST_LOG` (e.g. `joybug_core::windows_platform=trace,joybug_core::protocol_io=trace`), run the one failing test, then grep the log. Revert the global-setup edit afterward. This is how you see the actual Step/Breakpoint/exception sequence the UI can't show you.

## 6. ARM64 host performance note

On Windows ARM64 the Node/Playwright toolchain is usually x64-emulated (`node -e process.arch` → `x64`), so every `page.evaluate`/CDP round-trip runs emulated — passing tests average ~2× slower than on x64. The bigger wall-time lever is eliminating failures (each burns ~13–19s × 3 retries). Not an app perf bug. See memory `e2e-x64-emulated-node-slow`.
