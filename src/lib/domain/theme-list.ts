/**
 * Pure helpers for the discovered-theme list.
 * Issue: #585
 */

/**
 * Collapse duplicate theme ids, keeping the LAST occurrence.
 *
 * Stylesheet scan order is built-ins first, then injected user themes, and
 * the CSS cascade means the later rule is the one that actually paints — so
 * a user theme reusing a built-in id must ALSO win the list entry, acting as
 * an override. Without this, duplicate ids reach ThemePicker's keyed each
 * and crash it mid-mount (each_key_duplicate), which used to soft-lock all
 * hotkeys via the stuck dialog open-flag.
 */
export function dedupeThemesById<T extends { id: string }>(themes: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const theme of themes) {
    byId.set(theme.id, theme);
  }
  return [...byId.values()];
}
