/**
 * Layout theme application, eager half (#1306).
 *
 * Owns what first paint needs: the `data-layout` / `data-layout-base` root
 * attributes, the injected layout stylesheets, the structural arrangement
 * (Floating Islands hoists Miller columns and widens split dividers) and the
 * Details row height a layout asks for. Everything else — reading the
 * `layouts/` folder, metadata, resolution, fallback notices — lives in the
 * lazily loaded `layout-controller.svelte.ts`, which calls `commit` here.
 *
 * The last applied layout is cached in localStorage, stylesheets included,
 * and painted synchronously by `start()` while the page mounts (before the
 * first frame), so a lazily loaded built-in or a user layout paints on the
 * first frame instead of flashing Default. Importing the module touches no
 * DOM. Floating Islands ships in the startup
 * CSS (`layouts/floating-islands.css`) and needs only the attribute.
 *
 * Layout sheets are appended to <body>, after every <head> stylesheet the
 * app or a lazily loaded component adds, so at equal specificity a layout
 * rule wins over base styles (docs/layout-themes.md, "Precedence").
 */

import {
  DEFAULT_LAYOUT_ID,
  FLOATING_ISLANDS_LAYOUT_ID,
  isBuiltinLayoutId,
  type BuiltinLayoutId,
} from "$lib/domain/layout-theme-ids";
import { paneDividerSize } from "$lib/domain/pane-viewport";
import { detailsRowHeight, listRowHeight } from "$lib/domain/row-thumbnails";
import { loadPersisted, savePersisted } from "./persisted";
import { settingsStore } from "./settings.svelte";

export interface AppliedLayout {
  /** Applied layout id (Default after a fallback). */
  readonly id: string;
  readonly base: BuiltinLayoutId;
  /** Stylesheets in cascade order: lazy built-in base, then user CSS. */
  readonly sheets: readonly string[];
  /** Details row height in CSS px. */
  readonly rowHeight: number;
}

const CACHE_KEY = "explorer-layout";
/** Stylesheets larger than this are not cached; that layout then paints
 *  Default for the moment it takes to read it from disk. */
const MAX_CACHED_SHEET_CHARS = 256 * 1024;
const SHEET_ATTR = "data-layout-sheet";

function readCache(): AppliedLayout | null {
  const raw = loadPersisted<unknown>(CACHE_KEY, null, MAX_CACHED_SHEET_CHARS * 2);
  if (typeof raw !== "object" || raw === null) return null;
  const { id, base, sheets, rowHeight } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !isBuiltinLayoutId(base) || typeof rowHeight !== "number") return null;
  if (!Array.isArray(sheets) || !sheets.every((sheet) => typeof sheet === "string")) return null;
  return { id, base, sheets, rowHeight };
}

function writeCache(layout: AppliedLayout): void {
  const size = layout.sheets.reduce((total, sheet) => total + sheet.length, 0);
  // An uncacheable layout must not leave an older layout's sheets cached.
  savePersisted(CACHE_KEY, size <= MAX_CACHED_SHEET_CHARS ? layout : null);
}

/** Replace the injected layout stylesheets; returns the new elements. */
function paint(layout: AppliedLayout): HTMLStyleElement[] {
  if (typeof document === "undefined") return [];
  const root = document.documentElement;
  root.setAttribute("data-layout", layout.id);
  root.setAttribute("data-layout-base", layout.base);
  const previous = document.querySelectorAll(`style[${SHEET_ATTR}]`);
  const next = layout.sheets.map((css) => {
    const style = document.createElement("style");
    style.setAttribute(SHEET_ATTR, "");
    style.textContent = css;
    return style;
  });
  document.body.append(...next);
  previous.forEach((element) => element.remove());
  return next;
}

type Controller = typeof import("./layout-controller.svelte");
let controller: Promise<Controller> | undefined;
const loadController = () => (controller ??= import("./layout-controller.svelte"));

function createLayoutStore() {
  const requested = settingsStore.layoutTheme;
  const cached = readCache();
  const initial: AppliedLayout =
    cached?.id === requested
      ? cached
      : {
          id: requested,
          base: isBuiltinLayoutId(requested) ? requested : DEFAULT_LAYOUT_ID,
          sheets: [],
          rowHeight: 32,
        };
  let applied = $state.raw(initial);

  return {
    get applied() {
      return applied;
    },
    /** Floating Islands arrangement: Miller columns become their own island
     *  when the sidebar is hidden, and split dividers widen into gaps. */
    get islands() {
      return applied.base === FLOATING_ISLANDS_LAYOUT_ID;
    },
    /** Split-pane divider thickness for this arrangement, in CSS px. */
    get paneDividerSize() {
      return paneDividerSize(applied.base === FLOATING_ISLANDS_LAYOUT_ID);
    },
    /** Details row height: the layout's, raised for row thumbnails (#1465). */
    get detailsRowHeight() {
      return detailsRowHeight(applied.rowHeight, settingsStore.state.rowThumbnails);
    },
    /** List row (slot) height, for classic and column-flow List (#1465). */
    get listRowHeight() {
      return listRowHeight(settingsStore.state.rowThumbnails);
    },
    /** Apply a resolved layout. Returns the injected style elements. */
    commit(layout: AppliedLayout): HTMLStyleElement[] {
      const elements = paint(layout);
      applied = layout;
      writeCache(layout);
      return elements;
    },
    /** Record the Details row height the committed sheets ask for. */
    setRowHeight(rowHeight: number): void {
      if (rowHeight === applied.rowHeight) return;
      applied = { ...applied, rowHeight };
      writeCache(applied);
    },
    /** Paint the cached layout, then follow the selected layout for this
     *  window's lifetime. Called while the page mounts, before first paint. */
    start(): () => void {
      paint(applied);
      return $effect.root(() => {
        $effect(() => {
          const id = settingsStore.layoutTheme;
          void loadController().then((c) => c.applyLayout(id));
        });
      });
    },
    /** A `layouts/*.css` file changed on disk. */
    reload(): Promise<void> {
      return loadController().then((c) => c.reloadLayouts());
    },
  };
}

export const layoutStore = createLayoutStore();
