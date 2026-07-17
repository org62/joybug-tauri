# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Joybug UI — a Tauri v2 desktop debugger for Windows. Rust backend manages debug sessions via the joybug2 library; React/TypeScript frontend renders the debugging UI.

## Build & Dev Commands

```bash
npm run tauri dev      # Dev mode (starts Vite dev server + Tauri)
npm run tauri build    # Production build + installer
cd src-tauri && cargo build   # Rust-only build (useful for checking compilation)
npx playwright test --config e2e/playwright.config.ts   # E2E tests (requires dev server + Tauri running)
```

### E2E Tests

Run `npx playwright test --config e2e/playwright.config.ts` after every major code change (new features, refactors, bug fixes that touch frontend or backend). The full suite (31 tests) runs in ~1.2 minutes. Keep it fast:
- Never add hardcoded sleeps (`waitForTimeout`). Poll for the expected state instead using `toPass()` with tight intervals.
- Use fast polling intervals (start at 50-100ms, not 250-500ms) — backend responses are typically <50ms.
- When waiting for state transitions, compare state snapshots (e.g. event identity) rather than trying to catch brief intermediate states like "Running".

The joybug2 external crate has integration tests (`external/joybug2/tests/`) that require Windows with debugging privileges.

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
  - `lib.rs` — App setup, command registration, global state
  - `state.rs` — `SessionStateUI`, serializable types
  - `events.rs` — joybug2 context → serializable conversion
  - `breakpoint_store.rs` — Breakpoint persistence
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
- `external/joybug2/` — Git submodule, the debugger core library

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
- **Text selection**: data (addresses, hex, registers, symbols) is selectable by default. `select-none` only on chrome (`PanelToolbar`/`PanelFooter` already have it, drag handles, tab headers). Components that manage their own selection (HexView byte-selection, AssemblyView instruction rows) keep it — don't force selection there.
- **Session cleanup**: Every hook/component MUST reset state when the session ends or resumes. Pattern:
  ```ts
  useEffect(() => {
    if (!sessionId || !isPaused) { /* clear all state */ }
  }, [sessionId, isPaused]);
  ```
- **Debounced status**: `useDebugSession` provides `displayStatus` (debounced) to prevent UI flicker during rapid stepping.
- **Navigation**: Cross-component navigation (jump to disassembly address, jump to memory) uses callback props through `SessionContext` (`onNavigateToDisassembly`, `onNavigateToMemory`).

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

### Adding a New Dock Tab
1. Build the view as `<DockPanel><PanelToolbar/><PanelBody/></DockPanel>` (from `@/components/ui/panel`); use `size="xs"` controls and `<ContextMenu>` for right-click menus (see UI layout primitives above)
2. Add a row to `SESSION_TAB_DEFS` in `src/lib/sessionTabs.tsx` (id, title, category, home panel, icon, palette keywords, optional keybinding action). The Windows menu, command palette, and panel chords all derive from this table.
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
