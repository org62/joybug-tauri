---
name: verify
description: Launch the Joybug Tauri app and drive it over CDP to verify a change end-to-end (real debug session, real UI interaction, screenshots).
---

# Verify Joybug UI changes at runtime

Build/launch recipe (mirrors `e2e/global-setup.ts`; frontend-only changes don't need a rebuild — Vite serves `src/` live):

1. Rust changed? `cd src-tauri && cargo build` first. Debug binary: `src-tauri/target/debug/joybug-tauri.exe`.
2. Start Vite: `npm run dev` (wait for `http://localhost:1420`).
3. Launch the binary with env `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and an isolated `JOYBUG_DATA_DIR` (temp dir), then wait for `http://localhost:9222/json/version`.
4. Connect with `playwright-core` (already a dep via @playwright/test): `chromium.connectOverCDP("http://localhost:9222")`, take `contexts()[0].pages()[0]`, wait for `#root` to have children.
5. Kill both processes when done: `taskkill /pid <pid> /T /F` (vite is a shell spawn — kill the tree). Check `tasklist | findstr joybug` for strays; a stray joybug-tauri.exe breaks the next CDP launch (WebView2 keys the browser process by user-data dir).

Driving the app:

- `window.__TAURI_INTERNALS__.invoke(cmd, args)` works from `page.evaluate` — session CRUD (`get_debug_sessions`, `stop_debug_session`, `delete_debug_session`, `get_session_modules`, …). Clean up stale sessions before starting (see `e2e/helpers/test-fixtures.ts` `cleanupAllSessions`).
- Create a session via the UI: `/debugger` → "Create Process" → fill "Session Name" + "Launch Command" (`cmd.exe /c echo x`) → "Create & Start" → wait URL `/session/:id` → poll `get_debug_session` for `status === "Paused"`.
- Dock tabs are clicked by exact title text ("Memory", "Disassembly", …). Panel roots are `.absolute.inset-0`; scroll viewports are `[data-slot="scroll-area-viewport"]`.
- Toasts are sonner: `[data-sonner-toast]`.
- Useful anchors: memory address input placeholder starts with `rsp`, address column spans have class `w-36`.
- Real memory boundaries for tests: `rsp` sits near top-of-stack (initial 4KB read is usually already partial); a module base from `get_session_modules` (`base_address` hex string) has unmapped memory below it.

Gotchas:

- `page.mouse.wheel` needs the pointer moved over the viewport first.
- Poll UI state with tight intervals; never fixed sleeps for state transitions (backend responds <50ms).
- Screenshots via `page.screenshot` work over CDP.
