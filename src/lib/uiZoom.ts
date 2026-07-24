// UI scale / zoom for the whole app.
//
// Uses the WebView's native page zoom (viewport-aware, unlike CSS `zoom`, which
// would break the app's 100vh layout). The chosen factor is persisted in
// localStorage and re-applied on startup. Native page zoom scales layout px and
// rem text together, so fixed-height virtualized rows (Source/Assembly/Hex)
// stay consistent — no row overlap, which enlarging the *base font* (OS text
// scaling) would cause.
import { getCurrentWebview } from "@tauri-apps/api/webview";

const ZOOM_KEY = "joybug-ui-zoom";
/** window CustomEvent<number> fired whenever the zoom changes (any source —
 * hotkey or Settings), so UI showing the current factor can stay in sync. */
export const ZOOM_CHANGED_EVENT = "joybug-ui-zoom-changed";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
/** Preset factors offered in Settings (also the snap points for +/-). */
export const ZOOM_STEPS = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function getStoredZoom(): number {
  const raw = localStorage.getItem(ZOOM_KEY);
  const z = raw ? parseFloat(raw) : 1;
  return Number.isFinite(z) ? clampZoom(z) : 1;
}

/** Persist and apply a zoom factor to the webview. */
export async function applyZoom(z: number): Promise<number> {
  const zoom = clampZoom(z);
  localStorage.setItem(ZOOM_KEY, String(zoom));
  window.dispatchEvent(new CustomEvent<number>(ZOOM_CHANGED_EVENT, { detail: zoom }));
  try {
    await getCurrentWebview().setZoom(zoom);
  } catch (e) {
    // Non-Tauri context (e.g. plain browser dev) or missing permission.
    console.warn("setZoom failed:", e);
  }
  return zoom;
}

/** Step to the next/previous preset (dir -1/+1), or reset to 100% (dir 0).
 * Stays on the preset steps so the value always matches the Settings dropdown. */
export async function nudgeZoom(dir: -1 | 0 | 1): Promise<number> {
  if (dir === 0) return applyZoom(1);
  const cur = getStoredZoom();
  if (dir > 0) {
    const next = ZOOM_STEPS.find((s) => s > cur + 1e-6);
    return applyZoom(next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  }
  const below = ZOOM_STEPS.filter((s) => s < cur - 1e-6);
  return applyZoom(below.length ? below[below.length - 1] : ZOOM_STEPS[0]);
}
