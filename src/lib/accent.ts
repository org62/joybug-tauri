// User-selectable accent color for the whole app.
//
// The accent drives `--syn-accent` in App.css (links, the quick-emulation
// change column, the jump-target flash). Applied as `data-accent` on <html>;
// the per-option light/dark values live in App.css next to the palette, so
// this module only carries the option list and persistence.
const ACCENT_KEY = "joybug-accent";

export const ACCENT_OPTIONS = [
  // `swatch` is a mid-lightness preview color for the Settings dropdown only —
  // the theme-correct values come from the CSS rules.
  { id: "blue", label: "Blue (default)", swatch: "oklch(0.62 0.16 250)" },
  { id: "teal", label: "Teal", swatch: "oklch(0.64 0.13 200)" },
  { id: "purple", label: "Purple", swatch: "oklch(0.62 0.16 290)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.63 0.16 355)" },
] as const;

export type AccentId = (typeof ACCENT_OPTIONS)[number]["id"];

export function getStoredAccent(): AccentId {
  const raw = localStorage.getItem(ACCENT_KEY);
  return ACCENT_OPTIONS.some((o) => o.id === raw) ? (raw as AccentId) : "blue";
}

/** Persist and apply an accent. Blue clears the attribute (the CSS default). */
export function applyAccent(id: AccentId): void {
  localStorage.setItem(ACCENT_KEY, id);
  if (id === "blue") {
    delete document.documentElement.dataset.accent;
  } else {
    document.documentElement.dataset.accent = id;
  }
}
