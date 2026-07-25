import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Mirrors `UpdateInfo` in `src-tauri/src/commands/updates.rs`. */
export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  download_url: string | null;
  published_at: string | null;
  notes: string | null;
  /** Unstamped local build — every release looks newer, so say so instead. */
  is_dev_build: boolean;
}

/** Mirrors `WelcomeState` in `src-tauri/src/commands/updates.rs`. */
export interface WelcomeState {
  should_show: boolean;
  version: string;
}

/** The two repos behind the app: this UI, and the debugger core it embeds. */
export const GITHUB_UI_URL = "https://github.com/org62/joybug-tauri";
export const GITHUB_CORE_URL = "https://github.com/org62/joybug-core";
export const GITHUB_ISSUES_URL = `${GITHUB_UI_URL}/issues`;

/**
 * Hand a URL to the OS browser. Always go through the opener plugin — a raw
 * `window.open` renders as an unstyled popup outside the WebView2 theme.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.error("Failed to open URL:", url, e);
  }
}

export const checkForUpdates = (): Promise<UpdateInfo> =>
  invoke<UpdateInfo>("check_for_updates");

export const startupUpdateCheck = (): Promise<UpdateInfo | null> =>
  invoke<UpdateInfo | null>("startup_update_check");

export const skipUpdateVersion = (version: string): Promise<void> =>
  invoke("skip_update_version", { version });

export const getWelcomeState = (): Promise<WelcomeState> =>
  invoke<WelcomeState>("get_welcome_state");

export const dismissWelcome = (): Promise<void> => invoke("dismiss_welcome");
