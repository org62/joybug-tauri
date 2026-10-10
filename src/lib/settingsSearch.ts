/** A row of a settings section, as the Settings page search sees it. */
export interface SettingItem {
  key: string;
  label: string;
  keywords: string[];
}

/**
 * Whether a settings row matches the Settings page search box: by its label,
 * its keywords, or the names of the section it sits in (so "general" shows
 * the whole General block). An empty query matches everything.
 */
export function matchesSettingItem(query: string, sectionNames: string[], item: Pick<SettingItem, "label" | "keywords">): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.label.toLowerCase().includes(q) ||
    sectionNames.some((name) => name.includes(q)) ||
    item.keywords.some((kw) => kw.includes(q))
  );
}
