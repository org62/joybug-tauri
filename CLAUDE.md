# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Joybug UI — a Tauri v2 desktop debugger for Windows. Rust backend manages debug sessions via the joybug2 library; React/TypeScript frontend renders the debugging UI.

## Build & Dev Commands

```bash
npm run tauri dev      # Dev mode (starts Vite dev server + Tauri)
npm run tauri build    # Production build + installer
cd src-tauri && cargo build   # Rust-only build (useful for checking compilation)
```

No tests exist in the Tauri layer. The joybug2 external crate has integration tests (`external/joybug2/tests/`) that require Windows with debugging privileges.

## Project Structure

- `src-tauri/src/` — Rust backend
  - `session.rs` — Debug session event loop, `UICommand` enum, `handle_ui_commands()`
  - `commands.rs` — Tauri command handlers (30+)
  - `lib.rs` — App setup, command registration, global state
  - `state.rs` — `SessionStateUI`, serializable types
  - `events.rs` — joybug2 context → serializable conversion
  - `breakpoint_store.rs` — Breakpoint persistence
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
2. Command handler in `commands.rs` sends a `UICommand` variant through an mpsc channel
3. Session loop in `session.rs` (`handle_ui_commands`) receives and processes it
4. **Stepping commands** (Go, StepIn, StepOver, StepOut) return from the handler to resume execution
5. **Non-stepping commands** (Disassembly, ReadMemory, Emulate, etc.) process inline and emit a Tauri event back, staying paused
6. Frontend hooks listen for events (e.g., `session-updated`, `disassembly-updated`, `memory-read-result`) and update component state

### Frontend Patterns

- **Context wrappers**: Thin `Context*View.tsx` components pull session data from `SessionContext` and pass it to feature components. Add new ones following this pattern.
- **Docking**: rc-dock library. Tab definitions live in `src/lib/dockingConfigs.tsx` (initial layout + tab factory). Dynamic content and keyboard shortcuts in `SessionDocked.tsx`. Menu entries in `SessionHeader.tsx`.
- **Scrollable areas**: Always use `<ScrollArea>` from `@/components/ui/scroll-area`. Never use plain `overflow-y-auto` divs.
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
1. Add tab definition and initial placement in `src/lib/dockingConfigs.tsx`
2. Add dynamic content rendering in `SessionDocked.tsx`
3. Add menu entry in `SessionHeader.tsx` (Windows menu)
4. Add keyboard shortcut in `SessionDocked.tsx` if needed

### Adding a New UICommand
1. Add variant to `UICommand` enum in `session.rs`
2. Handle it in `handle_ui_commands()` in `session.rs`
3. Add Tauri command wrapper in `commands.rs`
4. Register the command in `lib.rs`
5. Call from frontend via `invoke()`

### Path Aliases
TypeScript uses `@/` → `./src/` (configured in tsconfig.json and vite.config.ts).
