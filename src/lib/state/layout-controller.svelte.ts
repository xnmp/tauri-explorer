/**
 * Layout theme selection, lazy half (#1306).
 *
 * Reads `<config>/layouts/`, resolves the requested layout (falling back to
 * Default with one notice per failure), loads built-in stylesheets that are
 * not part of the startup bundle, and commits the result through the eager
 * `layoutStore`. Loaded on the first layout application, by the settings UI
 * and by the layout picker.
 *
 * Every application is numbered. A slower earlier one (a listing or a lazy
 * stylesheet still loading) can never overwrite a later request: rapid
 * picker previews, a settings reload and a `layouts/` file change can all
 * be in flight at once.
 */

import {
  BUILTIN_LAYOUT_CATALOG,
  buildLayoutCatalog,
  describeLayoutFallback,
  HAIRLINE_LEDGER_LAYOUT_ID,
  isBuiltinLayoutId,
  isNewLayoutFallback,
  parseLayoutRowHeight,
  resolveLayoutTheme,
  withLayoutFailure,
  type BuiltinLayoutId,
  type LayoutCatalog,
  type LayoutFallback,
  type LayoutThemeInfo,
} from "$lib/domain/layout-theme";
import { listUserLayouts } from "$lib/api/layouts";
import { layoutStore } from "./layout.svelte";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte";

/** Built-in bases outside the startup bundle. Floating Islands is bundled. */
const LAZY_BASE_SHEETS: Partial<Record<BuiltinLayoutId, () => Promise<{ default: string }>>> = {
  [HAIRLINE_LEDGER_LAYOUT_ID]: () => import("$lib/layouts/hairline-ledger.css?inline"),
};

let catalog = $state.raw<LayoutCatalog>(BUILTIN_LAYOUT_CATALOG);
let listed: Promise<LayoutCatalog> | null = null;
let listing = 0;
let fallback = $state.raw<LayoutFallback | null>(null);
let generation = 0;
/** Last layout applied to this window: the saved choice or a picker preview. */
let lastRequested: string | null = null;

/** Read the layouts folder once until the next change notification. Only the
 *  newest listing publishes, and a failed one is not cached. */
function loadCatalog(): Promise<LayoutCatalog> {
  if (listed) return listed;
  const ticket = ++listing;
  const pending = listUserLayouts().then((result) => {
    if (!result.ok) {
      // Keep the last known catalog; the next request lists again.
      console.error("Failed to list user layouts:", result.error);
      if (listed === pending) listed = null;
      return catalog;
    }
    const next = buildLayoutCatalog(result.data);
    if (ticket === listing) catalog = next;
    return next;
  });
  listed = pending;
  return pending;
}

async function stylesheetsFor(theme: LayoutThemeInfo, from: LayoutCatalog): Promise<string[]> {
  const base = LAZY_BASE_SHEETS[theme.base];
  const sheets = base ? [(await base()).default] : [];
  const user = from.userCss.get(theme.id);
  return user === undefined ? sheets : [...sheets, user];
}

/** Details row height the applied sheets ask for (`--layout-row-height`). */
function measureRowHeight(): number {
  return parseLayoutRowHeight(
    getComputedStyle(document.documentElement).getPropertyValue("--layout-row-height"),
  );
}

function reportFallback(next: LayoutFallback | null, requestedName: string): void {
  if (isNewLayoutFallback(fallback, next) && next) {
    toastStore.show(
      `Layout “${requestedName}” could not be applied: ${describeLayoutFallback(next.reason)}. Using Default.`,
      "error",
      { duration: 8000 },
    );
  }
  fallback = next;
}

/**
 * Apply `requested` (a built-in id or a user file name) to this window.
 * Persisting the choice is the caller's job (settings); previews call this
 * directly and restore by applying the saved id again.
 */
export async function applyLayout(requested: string): Promise<void> {
  const ticket = ++generation;
  lastRequested = requested;
  try {
    let from = isBuiltinLayoutId(requested) ? catalog : await loadCatalog();
    if (ticket !== generation) return;
    for (;;) {
      const resolution = resolveLayoutTheme(from, requested);
      const sheets = await stylesheetsFor(resolution.theme, from);
      if (ticket !== generation) return;
      const elements = layoutStore.commit({
        id: resolution.theme.id,
        base: resolution.theme.base,
        sheets,
        rowHeight: layoutStore.detailsRowHeight,
      });
      // CSS is forgiving: a binary file or prose saved as .css still parses,
      // to nothing. The user sheet is always last; an empty one is a failure.
      const user = resolution.theme.source === "user" ? elements.at(-1) : undefined;
      if (user?.sheet && user.sheet.cssRules.length === 0) {
        from = catalog = withLayoutFailure(from, resolution.theme.id, "no-rules");
        listed = Promise.resolve(from);
        continue;
      }
      layoutStore.setRowHeight(measureRowHeight());
      reportFallback(resolution.fallback, requested);
      return;
    }
  } catch (error) {
    // A failed lazy stylesheet import must not leave the window half-styled.
    console.error("Failed to apply layout theme:", error);
    if (ticket !== generation) return;
    layoutStore.commit({ id: "default", base: "default", sheets: [], rowHeight: 32 });
    reportFallback({ requested, reason: "load-failed" }, requested);
  }
}

/** A `layouts/*.css` file was added, edited or removed. Re-applies what the
 *  window shows, so an open picker keeps its preview. */
export function reloadLayouts(): Promise<void> {
  listed = null;
  return applyLayout(lastRequested ?? settingsStore.layoutTheme);
}

/** Catalog for the settings selector and picker, refreshed from disk. */
export function refreshLayoutCatalog(): Promise<LayoutCatalog> {
  listed = null;
  return loadCatalog();
}

export const layoutController = {
  /** Built-ins first, then usable user layouts. */
  get themes(): readonly LayoutThemeInfo[] {
    return catalog.themes;
  },
  /** Why the selected layout is not applied, or null. */
  get fallback(): LayoutFallback | null {
    return fallback;
  },
  describeFallback: describeLayoutFallback,
};
