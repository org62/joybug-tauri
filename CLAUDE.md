# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Joybug UI — a Tauri v2 desktop debugger for Windows. Rust backend manages debug sessions via the joybug-core library; React/TypeScript frontend renders the debugging UI.

## Build & Dev Commands

```bash
npm run tauri dev      # Dev mode (starts Vite dev server + Tauri)
npm run tauri build    # Production build + installer
cd src-tauri && cargo build   # Rust-only build (useful for checking compilation)
npm run test:e2e       # E2E tests (WebdriverIO + tauri-driver on the real webview; builds the debug binary first)
```

### E2E Tests

Run `npm run test:e2e` after every major code change (new features, refactors, bug fixes that touch frontend or backend); on a host without a display, `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` (the harness sizes the window to 1600×1000, so the screen must be larger). The suite is WebdriverIO (Mocha) driving the app's **real webview** through `tauri-driver` — WebKitGTK on Linux, WebView2 on Windows — one app process per spec file; see "E2E harness" below. Keep it fast:
- Never add hardcoded sleeps (`waitForTimeout`). Poll for the expected state instead using `toPass()` with tight intervals.
- Use fast polling intervals (start at 50-100ms, not 250-500ms) — backend responses are typically <50ms.
- When waiting for state transitions, compare state snapshots (e.g. event identity) rather than trying to catch brief intermediate states like "Running".

**Zero tolerance for flaky tests.** A test that passes only on retry is a bug, not noise — treat a flaky result exactly like a failure. When a flake appears, investigate and fix it immediately (reproduce with `npm run test:e2e:repeat -- --spec e2e/tests/<name>.spec.ts`, find the actual race, fix the root cause); never re-run to make it "go away", and never turn on Mocha `retries`/`specFileRetries` (both are 0 in `e2e/wdio.conf.ts`). Every fix must target a concrete cause — an unsynchronized wait, a command sent before the session is ready, cross-test state left behind (persisted patches/breakpoints, an open PE file), a too-tight timeout on a cold-start path — not a blanket timeout bump. After fixing, re-run the affected spec with `test:e2e:repeat` to prove it's stable.

**E2E harness** (`e2e/`). `wdio.conf.ts` is the whole configuration: it builds the debuggee
fixtures, starts Vite (debug) and the data dir in `onPrepare`, and hands `@wdio/tauri-service`
the binary (`JOYBUG_E2E_RELEASE=1` → the built release binary, no Vite). The service spawns
`tauri-driver` in front of the OS WebDriver (WebKitWebDriver / msedgedriver, the latter
downloaded to match the installed WebView2); `helpers/tauri-service.ts` switches off the
service's per-command plugin probing, which would otherwise cost ~5 s per element lookup. The
specs are written in **Playwright's vocabulary** and did not change in the port: `helpers/pw.ts`
is a `Page`/`Locator` façade over WebDriver (lazy locator chains resolved in the page, including
`getByRole` with accessible names and hidden-element exclusion, real clicks/keys/pointer actions),
`helpers/expect.ts` adds the retrying web-first matchers plus `toPass`/`expect.poll`, and
`helpers/test.ts` provides `test`/`test.describe`/`test.skip`/`test.setTimeout` on Mocha with
the per-test resets of `helpers/lifecycle.ts` (sessions, settings, persisted stores,
localStorage, nav history) around every test. Specs import all of it from
`helpers/test-fixtures`. The app's environment for a run is `APP_ENV` in `helpers/app.ts`
(isolated data dir, `JOYBUG_NO_WELCOME`, `JOYBUG_NO_UPDATE_CHECK`, `DEBUGINFOD_URLS=""`, and
`WEBKIT_DISABLE_DMABUF_RENDERER=1` — without it the automation webview's frame clock stalls and
every paint-dependent WebDriver command hangs). Failures leave a screenshot and a DOM snapshot
under `e2e/results/`. Prerequisites: the debug binary (`cd src-tauri && cargo build`),
`cargo install tauri-driver --locked`, and on Linux the `webkitgtk-webdriver` package
(`webkit2gtk-driver` before Ubuntu 26.04).

The joybug-core external crate has integration tests (`external/joybug-core/tests/`) that require Windows with debugging privileges.

## Project Structure

- `src-tauri/src/` — Rust backend
  - `session/` — Debug session module
    - `types.rs` — `UICommand` enum, event payload types
    - `runner.rs` — Debug session event loop (`run_debug_session`)
    - `dispatch.rs` — `handle_ui_commands()` command dispatcher
    - `disassembly.rs`, `memory.rs`, `emulation.rs`, `registers.rs`, `symbols.rs`, `breakpoints.rs`, `callstack.rs` — Per-domain processing
  - `commands/` — Tauri command handlers (40+)
    - `mod.rs` — `send_paused_command()` shared helper
    - `session_lifecycle.rs` — Session CRUD (create, start, stop, delete)
    - `stepping.rs` — Go, StepIn, StepOver, StepOut
    - `disassembly.rs`, `memory.rs`, `breakpoints.rs`, `emulation.rs`, `symbols.rs`, `logging.rs`, `settings.rs`, `window_state.rs` — Per-domain commands
    - `pe_file.rs` — Offline image viewer commands over `joybug_core::static_image::StaticFile` (a `PeImage` or `ElfImage`, opened by magic: open/hex/disasm/symbols/strings, plus `pe_xrefs_to` and `pe_emulate` for xrefs and process-less emulation; header field edits are PE-only)
    - `updates.rs` — GitHub-releases update check + first-run welcome state
  - `lib.rs` — App setup, command registration, global state
  - `state.rs` — `SessionStateUI`, serializable types
  - `events.rs` — joybug-core context → serializable conversion
  - `breakpoint_store.rs` — Breakpoint persistence
  - `app_state_store.rs` — `app_state.json`: welcome-seen version, skipped update, last update check
  - `error.rs` — Error types
  - `settings.rs` — Debug settings
  - `ui_logger.rs` — UI logging utilities
- `src/` — React/TypeScript frontend
  - `pages/` — Route pages (`SessionDocked.tsx` is the main debugging view)
  - `components/session/` — Context wrapper components (`Context*View.tsx`)
  - `components/ui/` — shadcn/ui primitives (New York style, Lucide icons)
  - `hooks/` — Custom hooks (`useDebugSession`, `useAssemblyView`, `useBreakpoints`, etc.)
  - `lib/` — Utilities (`dockingConfigs.tsx` for dock layout, `hexUtils.ts`, `sessionHelpers.ts`)
  - `contexts/SessionContext.ts` — Session data context type definitions
- `external/joybug-core/` — Git submodule, the debugger core library

## Architecture

### Command Flow (Frontend → Backend → Frontend)

1. Frontend calls `invoke("command_name", { args })` (Tauri IPC)
2. Command handler in `commands/` calls `send_paused_command()` to send a `UICommand` variant through an mpsc channel
3. Session loop in `session/runner.rs` receives it; `handle_ui_commands()` in `session/dispatch.rs` processes it
4. **Stepping commands** (Go, StepIn, StepOver, StepOut) return from the handler to resume execution
5. **Non-stepping commands** (Disassembly, ReadMemory, Emulate, etc.) call domain-specific `process_*()` functions in `session/`, emit a Tauri event, and stay paused
6. Frontend hooks listen for events (e.g., `session-updated`, `disassembly-updated`, `memory-read-result`) and update component state

### Frontend Patterns

- **Context wrappers**: Thin `Context*View.tsx` components pull session data from `SessionContext` and pass it to feature components. Add new ones following this pattern.
- **Docking**: rc-dock library. Tab definitions live in `src/lib/dockingConfigs.tsx` (initial layout + tab factory). Dynamic content and keyboard shortcuts in `SessionDocked.tsx`. Menu entries in `SessionHeader.tsx`.
- **UI layout primitives (use these — do not hand-roll)**: Shared primitives encode the layout/scroll/selection contracts so views can't drift. ESLint (`npm run lint`) enforces the key rules.
  - **Dock tab views** (`@/components/ui/panel`): every rc-dock tab component is `<DockPanel><PanelToolbar/><PanelBody/></DockPanel>`. `DockPanel` is the root (`absolute inset-0 flex flex-col overflow-hidden` — NOT `h-full`; a plain `h-full` root collapses and makes the whole panel scroll). `PanelToolbar`/`PanelFooter` are fixed `shrink-0` chrome bars (carry `select-none`); multi-row form headers use `<PanelToolbar stack>` (column layout, same padding) — never hand-roll a `p-2 border-b` header div. `PanelBody` is the scroll region (`ScrollArea` with `flex-1 min-h-0`; forwards `viewportRef`/`onScroll`/`orientation`). Exception: if the scroll region's child is a `<VirtualizedList>` (it owns its own ScrollArea), use a plain `<div className="flex-1 min-h-0">` instead of `PanelBody` to avoid nested scrollbars. Reference: `AssemblyView.tsx`, `ModuleInfoView.tsx`.
  - **Routed pages** (`@/components/ui/page`): wrap page content in `<Page>` (it supplies the scroll container that App's clipping `<main>` requires). Use `<Page scroll={false}>` for pages that self-manage height, `container={false}` to skip the default `container mx-auto px-4 py-8` inner.
  - **Scrollable areas**: use `<PanelBody>`/`<ScrollArea>`/`<Page>`. NEVER a raw `overflow-y-auto`/`overflow-auto`/`overflow-scroll` div (lint error). `overflow-hidden` is fine.
- **Controls**: dense panel toolbars use `size="xs"` on `Button` (28px, 14px icons), `size="icon-xs"` for icon-only, `inputSize="xs"` on `Input`, `size="xs"` on `SelectTrigger`, `size="xs"` on `Switch`/`Badge`. In-row inline editing (rename fields inside compact list rows) uses `inputSize="inline"` (20px). Checkboxes use `<Checkbox>` (`@/components/ui/checkbox`). The top debug control bar (`SessionHeader`) uses `size="sm"` (32px); dialogs and routed pages use default sizes. NEVER a raw `<button>`, `<input>`, `<select>`, or `<textarea>` in a view — use the `@/components/ui` primitives (lint error). Don't hand-roll control sizing with `h-*`/`px-*` classes — use the size variants. `src/components/ui/**` is exempt from these lint rules.
- **Context menus** (`@/components/ui/context-menu`): right-click menus use `<ContextMenu x y onClose>` + `<ContextMenuItem>`/`<ContextMenuSeparator>`. `useContextMenu()` supplies `{ contextMenu, openContextMenu, closeContextMenu }` (position/state); the primitive handles outside-click/Escape and auto-closes on item click.
- **Dialogs, confirmations & windows**: NEVER use the platform's native `window.confirm`/`window.alert`/`window.prompt` or `window.open` — they render as unstyled OS dialogs that break the app's look, sit outside the WebView2 theme, and (being synchronous) don't compose with the async command flow. Use the framework primitives instead: `@/components/ui/dialog` (Radix) for modal dialogs and confirmations, `sonner`/toast (`@/components/ui/sonner`, and the `crate::ui_logger::toast_*` helpers on the Rust side) for transient notifications, and rc-dock tabs / routed pages for new surfaces. This applies to any "non-UI-intended" platform feature — if the app has a styled primitive for it, use that, never the raw browser/OS affordance.
- **Text selection**: data (addresses, hex, registers, symbols) is selectable by default. `select-none` only on chrome (`PanelToolbar`/`PanelFooter` already have it, drag handles, tab headers). Components that manage their own selection (HexView byte-selection, AssemblyView instruction rows) keep it — don't force selection there.
- **Session state policy** (full table in `src/lib/sessionHelpers.ts`): gate on exactly one of `isPaused` (stepping, register edits, patch bytes), `canUseMemoryOps` (any OOB op — a process exists: Paused/Running/Open), or `sessionId` (persisted config: breakpoints/patches/bookmarks stay visible and metadata-editable while Stopped via state-only backend paths). Never the raw `session.status` string. Live views clear when the process goes away; a running target is still a process. Pattern:
  ```ts
  useEffect(() => {
    if (!sessionId || !canUseMemoryOps) { /* clear all state */ }
  }, [sessionId, canUseMemoryOps]);
  ```
  Any control whose handler invokes the backend against the process is `disabled` on that predicate; the Stopped transition is a normal UI state (`ProcessUnavailableState` from `@/components/ui/empty-state`), never a red error box or a toast. Command handlers report failures through `reportSessionError()` (`lib/sessionHelpers.ts`), which drops the benign "process went away" rejections — never a hand-written `catch` + `toastError`. On the Rust side the three routes of a persisted-config command (paused channel / state-only while Stopped / OOB) are chosen once by `paused_or_offline_or_oob()` in `commands/mod.rs`.
- **Debounced status**: `useDebugSession` provides `displayStatus` (debounced) to prevent UI flicker during rapid stepping.
- **Navigation**: Cross-component navigation (jump to disassembly address, jump to memory) uses callback props through `SessionContext` (`onNavigateToDisassembly`, `onNavigateToMemory`).
- **Back/forward history**: one app-wide store, `appNavHistory` (`src/lib/navHistory.ts`), records every user navigation — route changes (App's location effect), dock tab switches (`useNavHistoryDock`), disassembly jumps/steps (`useAssemblyView`). Mouse X-buttons and Alt+Left/Right are handled once in `App.tsx` and always consumed (native WebView2 history is never the fallback). A dock host registers with a `scope` (session id / PE path); tab/address parts only restore into their own scope — call `invalidateScope()` when that content goes away. E2E resets it per test via the `joybug:reset-nav-history` window event.

### Key Tauri Events

| Event | Source | Listener |
|-------|--------|----------|
| `session-updated` | session loop | `useDebugSession` |
| `disassembly-updated` / `function-disassembly-updated` | Disassembly command | `useAssemblyView` |
| `memory-read-result` / `memory-write-result` | Memory commands | `useHexEditor` |
| `breakpoints-updated` | Breakpoint commands | `useBreakpoints` |
| `emulation-result` | Emulate command | `useQuickEmulation` |

## Conventions

### Git
- Never stage files (`git add`) unless explicitly asked to do so.

### Branching & Releases

Both repos are trunk-based: one long-lived branch, **`main`**, plus short-lived feature branches that PR into it. Released versions are identified by tags, not by a branch.

A change spanning both repos: land the core side on core `main` first, then in the parent move the gitlink to that commit (`git -C external/joybug-core checkout main && git -C external/joybug-core pull`) and PR the parent side. Because the parent pins core by SHA, core `main` moving ahead never affects a released build.

**Cutting a release** — tag `main`, that's all:
```bash
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
```
A tag containing `-` (e.g. `v0.2.0-rc.1`) ships as a prerelease.

**Versioning:** the git tag is the only source of truth. Every version field in the repo (`tauri.conf.json`, `Cargo.toml`, `package.json`, both lockfiles) reads `0.0.0` and stays that way — release CI stamps the real version into `tauri.conf.json` before building, so nothing has to be committed at release time. A local build reporting `0.0.0` is correct: it isn't a release. Never hardcode a version in the UI; `About.tsx` reads it at runtime via `getVersion()` from `@tauri-apps/api/app`.

**Update check & first-run dialog.** The app is a portable `.exe` (`bundle.active: false`), so
Tauri's updater plugin doesn't apply — `commands/updates.rs` queries the GitHub releases API
directly. The startup check is throttled to once per 24h (`last_update_check` in
`app_state.json`), is opt-out via `auto_update_check` in Settings, and self-suppresses on a
`0.0.0` local build. The welcome dialog re-shows on every version bump.
Both honour hard env kill switches — `JOYBUG_NO_UPDATE_CHECK` and `JOYBUG_NO_WELCOME`, set by
`e2e/global-setup.ts`. **Do not remove them**: the suite attaches to an already-mounted app, so a
startup modal or network call can't be suppressed by a test fixture.

**One-click install.** The exe replaces itself in place (a running image can be renamed on
Windows) — see the module doc of `commands/self_update.rs` for the swap and its invariants.
`UpdateInfo.self_update` decides at check time whether that is possible; when it isn't, the
dialog falls back to opening the release page.

Release artifacts are deliberately **version-free** (`Joybug-UI-x64.exe`) so
`releases/latest/download/<name>` stays a stable permalink for that download link. The `.sha256`
sidecars are only written for tagged releases, and the one-click install requires one.

**CI** (`.github/workflows/`):
- `_build.yml` — reusable build + E2E (ARM64 + X64 self-hosted). Not triggered directly. Artifacts are always named `Joybug-UI-<arch>.exe`; when given a `version` it also stamps `tauri.conf.json` and writes SHA256 sidecars.
- `ci.yml` — push on `main` + PRs into `main`. Feature branches are absent from `push` so a PR builds once, not twice.
- `release.yml` — `v*` tags: build + E2E on both arches, then publish a GitHub Release with the binaries.

### Adding a New Dock Tab
1. Build the view as `<DockPanel><PanelToolbar/><PanelBody/></DockPanel>` (from `@/components/ui/panel`); use `size="xs"` controls and `<ContextMenu>` for right-click menus (see UI layout primitives above)
2. Add a row to `SESSION_TAB_DEFS` in `src/lib/sessionTabs.tsx` (id, title, category, home panel, icon, palette keywords, optional keybinding action). The Windows menu, command palette, and panel chords all derive from this table. Wide views (hex dumps, tables, disassembly) set `minWidth: WIDE` so they never open into a narrow side column — placement skips panels narrower than that and falls back to the widest one.
3. Add the content element to `dynamicTabContent` in `SessionDocked.tsx` — it's typed against the registry, so forgetting this is a compile error
4. If the tab gets a chord, add the `panel.*` action in `src/lib/keybindings.ts`
5. Optionally register the view's primary input with `usePanelFocus("<tab id>")` so "Go to X" focuses it
6. Run `npm run lint` — the guardrails reject raw `overflow-*` scroll classes and raw `<button>` in views

### Adding a New UICommand
1. Add variant to `UICommand` enum in `session/types.rs`
2. Handle it in `handle_ui_commands()` in `session/dispatch.rs` (add processing logic in a domain-specific `session/*.rs` file if needed)
3. Add Tauri command handler in the appropriate `commands/*.rs` file (use `send_paused_command()` helper)
4. Register the command in `lib.rs`
5. Call from frontend via `invoke()`

### Path Aliases
TypeScript uses `@/` → `./src/` (configured in tsconfig.json and vite.config.ts).

## Linux

The app and core **build, run and debug on Linux**. `joybug_core::PlatformImpl` is
`linux_platform::LinuxPlatform` on Linux (a ptrace backend; `stub_platform::StubPlatform` on
other Unixes refuses live-process requests). Windows-only subsystems — ETW, Windows Sandbox, the
JIT (AeDebug) debugger, PEB normalization, inline hooks, `env_block`, the
`winsandbox` crate — are `cfg(windows)`; the Tauri side keeps the **same command names and state
types** on every OS via `src-tauri/src/{etw,sandbox}_unsupported.rs` and
`commands/etw_trace_unsupported.rs`, and the frontend gates their surfaces on
`get_platform_info` (`commands/platform.rs` → `usePlatform()` / `PlatformProvider` in `App.tsx`,
which holds routes until the answer is in). Per-OS launch defaults and file filters, the
run-mode tabs, the ETW Events tab (`requires` in `sessionTabs.tsx`), the JIT, PEB and
Sandbox settings all read from it — never `navigator`/`process` sniffing. The Handles tab and
the dump menu exist on both OSes with per-OS content: on Linux the tab lists file descriptors
(number, `open(2)` flags via `lib/fdFlags.ts`, path or socket endpoints), TCP sockets and
capabilities, "Close" runs `close()` on a stopped thread, and the dump commands write an ELF
core file (`dumpMenuLabels()` in `sessionHelpers.ts`).
`region_annotations.rs` skips the NT structures (KUSER/PEB/TEB) off Windows.

**Core layout.** OS-neutral debugger bookkeeping lives in `external/joybug-core/src/debugger_core/`
(`DebugBook`: modules, breakpoints, stepping, coverage, watchpoints, hardware breakpoints, the
breakpoint/single-step event ladder, disassembly helpers) over the `ProcessOps` trait; symbols
in `src/symbols/` behind `SymbolBackend` (`PdbBackend` / `ElfBackend`). `windows_platform` and
`linux_platform` are thin OS layers over those. Linux specifics: one tracer thread owns every
ptrace call (`tracer.rs`: PTRACE_SEIZE, all-stop emulation, held/deferred threads, TF emulated
with PTRACE_SINGLESTEP); memory via `/proc/pid/mem`; registers fill the same x64 `CONTEXT`;
modules via an internal int3 on the interpreter's `_dl_debug_state` + an entry-point hook that
raises the one `InitialBreakpoint` (at `AT_ENTRY`, after the libraries are mapped); signals map
to NTSTATUS codes (`signals.rs`, SIGSEGV access kind recovered from the faulting instruction);
`MemoryRegionInfo` uses the Win32 constants; call stacks from `.eh_frame` CFI; symbols from
`.symtab`/`.dynsym` with `module_stem` cutting `.so` tails (`libc.so.6` → `libc!write`), the vdso
parsed from memory; a stripped module's separate debug file found like gdb does
(`elf/debug_file.rs`: `/usr/lib/debug/.build-id`, `.gnu_debuglink`, then a debuginfod download
into `~/.cache/debuginfod_client` from `DEBUGINFOD_URLS` unless symbols are offline — the Linux
counterpart of the PDB symbol server; E2E sets `DEBUGINFOD_URLS=""`); DWARF line tables; function tables from `.eh_frame` FDEs (what `.pdata` is
on Windows); `ModuleExtraInfo` synthesized from ELF headers (`elf_info.rs`: sections with
IMAGE_SCN flags, dynsym exports, GOT slots as imports, `e_entry`), which also feeds the
on-disk image diff (`pe_image.rs` takes ELF files) and so the Image Patches window; coverage
targets through the shared `debugger_core/coverage_targets.rs`; non-invasive Open sessions from
`/proc` alone. Thread suspend/resume = held threads; "kill thread" points the thread at a
`syscall` with `exit` in its registers; `allocate_memory` injects an `mmap` the same way
(`tracer.step_thread`). Resuming on an armed breakpoint steps over it first. An `execve` in the
target re-reads the image (`reinit_after_exec`: unloads reported, new modules and hooks, the new
entry point is a plain `Breakpoint`). DWARF types (`dwarf_types.rs`) feed the Types view; a
shared object's `DT_INIT` is its "module entry" for the auto breakpoints, and `/lib`, `/usr/lib`
are the "system" scope; a user-supplied ELF debug file loads through the same "Load PDB"
path (build-id checked). The offline viewer opens ELF files on every OS: `static_elf::ElfImage`
builds a `static_image::StaticImage` from `joybug_core::elf` the way `static_pe::PeImage` does
from PE headers; the viewer's `pe_*` commands hold a `StaticFile` (`Pe` | `Elf`) and Lua has
`elf.open` beside `pe.open`. The PE-shaped `ModuleExtraInfo` an ELF module reports (`elf_info.rs`) is for
the consumers that read it (region badges, module-entry breakpoints, address mapping); the
viewer itself shows the module's real headers from its `elf: ElfInfo` (`ElfStructureTree.tsx`,
over the scaffolding in `structureTree.tsx` that the PE tree shares). Platform-facing names —
"PE Viewer" / "DLL" / "PDB" vs "ELF Viewer" / "shared object" / "debug file" — come from
`lib/imageTerms.ts` (`imageTerms(usePlatform().os)`); the one tab whose title depends on it
goes through `tabTitle()` in `sessionTabs.tsx`. Header *edits* stay PE-only. Not on Linux:
i386 targets.

**Signals.** Fault signals always stop, as their NTSTATUS. Any other signal reaches the target
unseen unless an exception rule exists for its code (`0x4C530000 | signo`, see
`joybug_core::posix_signals` / `lib/exceptionNames.ts`; Settings offers the signals by name on
Linux). `session/runner.rs` sends the rule-derived set with `set_reported_signals` before the
launch and again from `on_event` when the rules change; from there the rule's stop/pass/handled
works as for any exception — Go drops the signal, Go (Pass Exception) delivers it. Passing a
signal nobody handles stops once more as a second-chance exception before it kills the target.
Child processes (`fork`, `posix_spawn`) are debuggable in core (`debug_children`, Lua
`dbg:launch(cmd, true)`); the app, as on Windows, never asks for it.

Toolchain (Ubuntu): `libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential cmake pkg-config clang
libclang-dev xvfb`, plus rustup and node. Debug build: `cd src-tauri && cargo build`. Attaching
to a process you did not spawn needs Yama's consent (`kernel.yama.ptrace_scope=1` is the default):
the target calls `prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY)`, or run with `CAP_SYS_PTRACE`.

**E2E on Linux.** The same suite runs against the app's real WebKitGTK webview through
`tauri-driver` + `WebKitWebDriver` (see "E2E harness" above); nothing in the app is test-specific
beyond the env kill switches and `JOYBUG_DATA_DIR`. The window needs a display: on a headless
host run `xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e`. The app is started with `GDK_BACKEND=x11` so it lands on that display even on a Wayland desktop. Webview-native behaviour that WebDriver cannot drive
(OS file drops, native dialogs) keeps its test seams (`joybug:test-file-drop`).

**One spec, both OSes.** Specs never spell out `cmd.exe`, `ntdll` or `C:\Windows`; they take the
target and its well-known modules/symbols from `e2e/helpers/launch-commands.ts` (`echoCmd`,
`exitCmd`, `SYSTEM_MODULE`, `SYSTEM_SYMBOL`, `SYMBOL_SEARCH`, `COVERAGE_MODULE`, ...). On Windows
the default target is still `cmd.exe` with ntdll's PDB; on Linux it is the `echo_c` fixture
built with `cc -g` (a system binary is stripped), so `echo_c!main`, DWARF lines, libc and
ld-linux are all there. The debuggee fixtures (`e2e/fixtures/src/*.c`, via `portable.h`) build
with MSVC on Windows and `cc` elsewhere (`build.mjs`, run by global-setup); `hello_c` also starts
a parked worker thread for the thread specs, and `sleeper_c` (which opts in to being traced) is
what `spawnTarget()` starts for attach specs off Windows. Two helpers absorb the one real
difference — the Linux initial breakpoint is the entry point, a function head with no caller:
`runToNestedFunction()` (runs to `main`) before a Step Out, `pauseMidFunction()` before an
assertion that needs the PC away from a function head. Both are no-ops on Windows. A test that is
inherently about NT (PEB/TEB, PE files, MASM fixtures) skips itself
with `test.skip(!IS_WINDOWS, ...)`. Specs that are Windows-only by nature are listed in
`WINDOWS_ONLY_SPECS` in `e2e/wdio.conf.ts` and excluded on Linux; everything else runs on both
OSes (a spec leaves that list only after passing `test:e2e:repeat` on Linux). Those are (PE reader/viewer, WOW64,
drag-drop of system PEs, PDB persistence, the ntdll-types spec). `signals.spec.ts` is the
reverse: Linux-only by nature (the `signal_c` fixture), it skips itself on Windows.
