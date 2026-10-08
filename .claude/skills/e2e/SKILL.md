---
name: e2e
description: Build the Joybug debug binary and run the WebdriverIO + tauri-driver E2E suite (Windows and Linux; incl. the ARM64 host gotchas — CMake/keystone build break, MSVC env for fixtures, host-arch fixtures, stray-process cleanup, backend log capture).
---

# Build & run the E2E tests

`npm run test:e2e` is the whole command (`xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` on a display-less Linux host — the harness sizes the window to 1600×1000) — but on a fresh checkout it fails for several non-obvious reasons. Work through the prerequisites first. Full suite ≈ 5 min.

The suite drives the app's **real webview** over WebDriver: `e2e/wdio.conf.ts` builds the fixtures, starts Vite (debug mode) and hands `@wdio/tauri-service` the binary; the service launches `tauri-driver`, which fronts the OS driver (WebKitWebDriver on Linux, msedgedriver for WebView2 on Windows) and starts **one app process per spec file**. You do NOT start anything yourself — you need the binary built and the drivers installed. Specs are written in Playwright's vocabulary (`page.getByRole`, `expect(...).toBeVisible()`, `toPass`) through the façade in `e2e/helpers/pw.ts` / `expect.ts` / `test.ts` — see "E2E harness" in CLAUDE.md.

## 1. Prerequisites (do these once per checkout)

**Node deps** — `node_modules` is often incomplete on a fresh checkout (e.g. `prismjs` missing → Vite overlay error `Failed to resolve import "prismjs"`). Fix:
```bash
npm install
```

**tauri-driver** — the cargo-installed WebDriver front for Tauri apps, on PATH (`~/.cargo/bin`):
```bash
cargo install tauri-driver --locked
```

**Native WebDriver**
- Linux: `sudo apt install webkitgtk-webdriver` (Ubuntu ≥ 26.04; `webkit2gtk-driver` on 24.04). Verify: `which WebKitWebDriver`.
- Windows: nothing to install — the Tauri service downloads the msedgedriver matching the installed WebView2 runtime on first run (`autoDownloadEdgeDriver`). If a run hangs while creating the session, that match failed: see the service's `docs/edge-webdriver-windows.md` in `node_modules/@wdio/tauri-service`.

**Build the Rust debug binary** — `wdio.conf.ts` expects `src-tauri/target/debug/joybug-tauri[.exe]` and does NOT build it. On Windows build inside the MSVC dev environment for your host arch:
```powershell
# from PowerShell; ARM64 host shown (use vcvars64.bat / x64 on an x64 host)
& "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\Launch-VsDevShell.ps1" -Arch arm64 -SkipAutomaticLocation
cd C:\temp\joybug-tauri\src-tauri
cargo build
```
On Linux `cd src-tauri && cargo build` is enough once the toolchain from CLAUDE.md ("Linux") is installed.

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

On Windows, run from a shell that has the MSVC env loaded — `onPrepare` builds the MSVC fixtures (`e2e/fixtures/build.mjs`) on first run and needs `cl.exe`/`ml64.exe` on PATH:
```powershell
& "C:\Program Files\...\Launch-VsDevShell.ps1" -Arch arm64 -SkipAutomaticLocation   # or bash: source the vcvars env
cd C:\temp\joybug-tauri
npm run test:e2e
```
Useful forms:
- one spec: `npx wdio run e2e/wdio.conf.ts --spec e2e/tests/<name>.spec.ts`
- one test: add `--mochaOpts.grep "<title substring>"`
- stability check: `npm run test:e2e:repeat -- --spec e2e/tests/<name>.spec.ts` (runs it 3×; the repo has **zero tolerance for flaky tests** — a retry-pass is a failure to fix at its cause). Retries are off in the config and must stay off.
- release binary (what CI runs on Windows): `JOYBUG_E2E_RELEASE=1 npm run test:e2e` after `npm run tauri build`.

Results: `e2e/results/` — JUnit XML, and per failed test a screenshot plus a DOM snapshot (`dom/<spec>__<title>.html`, first line is the URL). Background it and tee to a log for long runs.

## 3. Fixtures must match the DEBUGGER's architecture

The C fixtures (`hello_c.exe`, `watch_c.exe`) are the debugged **target**. joybug-core is a native debugger — it writes breakpoints/single-steps for its own arch and does NOT correctly debug an emulated cross-arch target. `build.mjs` builds the C fixtures for the host arch (detected via `PROCESSOR_IDENTIFIER`, which survives emulation) and stamps `<name>.arch`. If you ever see breakpoint/step/watchpoint tests hang or the target fault with `STATUS_ILLEGAL_INSTRUCTION`, suspect an arch-mismatched fixture (e.g. a stale x64 `e2e/fixtures/bin/` on ARM64). `hello_asm.exe` stays x64 on purpose. See memory `e2e-fixtures-host-arch`.

## 4. Stray-process cleanup (breaks the NEXT run)

The driver launches and kills one app per spec file, so leftovers are rare — but a killed run (Ctrl+C mid-suite, a crashed driver) can leave `joybug-tauri`, `tauri-driver`, the native driver or Vite behind. On Windows WebView2 keys its browser process by the shared user-data dir, so a stale `joybug-tauri.exe` makes the next session attach to it and hang. Before a run, or after a killed one:
```powershell
taskkill /IM joybug-tauri.exe /T /F 2>$null; taskkill /IM tauri-driver.exe /F 2>$null; taskkill /IM msedgedriver.exe /F 2>$null; taskkill /IM node.exe /F 2>$null
```
```bash
pkill -x joybug-tauri; pkill -x tauri-driver; pkill -x WebKitWebDriver   # Linux (mind a running `npm run tauri dev`)
```
Symptom of leftovers: `Failed to create a session` on the first spec, or a port-in-use error for 4444/4445.

## 5. Debugging a failing test — capture backend logs

The debug binary logs to stdout with a `RUST_LOG` env filter. The Tauri service can forward it: set `captureBackendLogs: true` in `TAURI_SERVICE_OPTIONS` (`e2e/wdio.conf.ts`) and run with `--logLevel info`; the app's stdout/stderr then appears in the WDIO log under `e2e/results/logs/`. Set `RUST_LOG` (e.g. `joybug_core::linux_platform=trace,joybug_core::protocol_io=trace`) in `APP_ENV` for the run, run the one failing test, then grep the log. Revert afterwards. This is how you see the actual Step/Breakpoint/exception sequence the UI can't show you.

## 6. Driver behaviour worth knowing

- **Linux display:** the app is started with `GDK_BACKEND=x11` (in `APP_ENV`); without it GTK picks Wayland whenever `WAYLAND_DISPLAY` is set and the window appears on the developer's desktop instead of the xvfb display.
- **Linux frame clock:** the app must run with `WEBKIT_DISABLE_DMABUF_RENDERER=1` (set in `APP_ENV`); without it `requestAnimationFrame` stalls in the automation webview and every paint-dependent WebDriver command (clicks on focusable elements, pointer actions, screenshots) hangs or takes seconds.
- **Service hooks:** `e2e/helpers/tauri-service.ts` disables the service's per-command "window focus recovery", which probes for a `tauri-plugin-wdio` this app does not ship and costs ~5 s per element lookup. Do not use `@wdio/tauri-service` directly in `services`.
- **Mouse back button:** WebKitWebDriver drops pointer buttons other than left/middle/right, so the X-button path stays a synthetic `MouseEvent({ button: 3 })` in `navigation-history.spec.ts`.
- **Native file drop / dialogs:** not drivable by WebDriver on either OS; those tests use the app's `joybug:test-file-drop` seam.

## 7. ARM64 host performance note

On Windows ARM64 the Node toolchain is usually x64-emulated (`node -e process.arch` → `x64`), so every WebDriver round-trip runs emulated — passing tests average ~2× slower than on x64. The bigger wall-time lever is eliminating failures. Not an app perf bug. See memory `e2e-x64-emulated-node-slow`.
