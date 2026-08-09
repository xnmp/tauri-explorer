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

/**
 * Resolve a requested theme id against the themes actually loaded, falling
 * back to the first available one.
 *
 * Applying an unknown id is not a no-op: it sets `data-theme="whatever"` on
 * the document, nothing styles that, and the app repaints into an unstyled
 * palette. That was only reachable at startup until config autoreload (#599)
 * made hand-editing `"theme"` in settings.json a live path, so every entry
 * point resolves through here.
 *
 * An empty list means discovery has not run yet — there is nothing to
 * validate against, so the request is trusted rather than clobbered.
 */
export function resolveThemeId(
  themes: readonly { id: string }[],
  requested: string,
): string {
  if (themes.length === 0) return requested;
  return themes.some((theme) => theme.id === requested) ? requested : themes[0].id;
}
