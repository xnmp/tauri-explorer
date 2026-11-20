/**
 * Built-in layout theme ids and the legacy-preference migration (#1306).
 *
 * Kept apart from `layout-theme.ts` because settings load and first paint
 * need these few names, while the catalog, metadata parser and resolution
 * load lazily with the first layout application.
 *
 * Pure and framework-free.
 */

export const DEFAULT_LAYOUT_ID = "default";
export const FLOATING_ISLANDS_LAYOUT_ID = "floating-islands";
export const HAIRLINE_LEDGER_LAYOUT_ID = "hairline-ledger";
export const SOFT_CARDS_LAYOUT_ID = "soft-cards";

export type BuiltinLayoutId =
  | typeof DEFAULT_LAYOUT_ID
  | typeof FLOATING_ISLANDS_LAYOUT_ID
  | typeof HAIRLINE_LEDGER_LAYOUT_ID
  | typeof SOFT_CARDS_LAYOUT_ID;

const BUILTIN_IDS: readonly string[] = [
  DEFAULT_LAYOUT_ID,
  FLOATING_ISLANDS_LAYOUT_ID,
  HAIRLINE_LEDGER_LAYOUT_ID,
  SOFT_CARDS_LAYOUT_ID,
];

export function isBuiltinLayoutId(value: unknown): value is BuiltinLayoutId {
  return typeof value === "string" && BUILTIN_IDS.includes(value);
}

/**
 * Whether the active tab owns the window below the strip on this base: the
 * strip is shaded except for a hole the tab and its curved feet cut, and one
 * outline runs round the tab and along the strip's base (#1785, #1856, #1858,
 * #1871). The
 * title bar's tab seam layers and marks (`composables/tab-seam-marks.ts`)
 * draw it; the base's stylesheet colours them. Floating Islands rounds the
 * surface's top corners and adds a shadow; Default is the flat case;
 * Hairline Ledger is flat and square, with no feet. Compact density (#1878)
 * only resizes the chrome, and the marks follow it.
 */
const TAB_OWNS_WINDOW: ReadonlySet<BuiltinLayoutId> = new Set([
  FLOATING_ISLANDS_LAYOUT_ID,
  DEFAULT_LAYOUT_ID,
  HAIRLINE_LEDGER_LAYOUT_ID,
]);

export function tabOwnsWindow(base: BuiltinLayoutId): boolean {
  return TAB_OWNS_WINDOW.has(base);
}

/**
 * Layout id for a settings blob written before layout themes existed.
 *
 * The island layout used to be implied by any of three switches: the
 * platform-independent Floating Islands toggle, macOS vibrancy, or a Windows
 * Mica/Acrylic backdrop (#277, #407, #434). Each of those users saw islands,
 * so each migrates to Floating Islands; everyone else keeps Default.
 */
export function legacyLayoutThemeId(persisted: unknown): BuiltinLayoutId {
  if (typeof persisted !== "object" || persisted === null) return DEFAULT_LAYOUT_ID;
  const blob = persisted as Record<string, unknown>;
  const islands =
    blob.floatingIslands === true ||
    blob.macOsVibrancy === true ||
    (typeof blob.windowsBackdrop === "string" && blob.windowsBackdrop !== "off");
  return islands ? FLOATING_ISLANDS_LAYOUT_ID : DEFAULT_LAYOUT_ID;
}

/** The retired Compact layout's id (#1548). Never a user layout: those ids
 *  always end in `.css`. */
const LEGACY_COMPACT_LAYOUT_ID = "compact";

/**
 * Fold the retired Compact layout into the `compact` density setting (#1878):
 * `layoutTheme: "compact"` becomes Default with `compact: true`, which keeps
 * its heights (Default's own horizontal spacing and 13px tab text replace
 * the old layout's tighter ones). Applies to any blob, whatever its migration stamp, because a
 * downgraded build can write the old id again. Returns the input itself when
 * there is nothing to fold, so callers can tell whether it changed.
 */
export function foldLegacyCompactLayout<T extends { layoutTheme?: unknown; compact?: unknown }>(settings: T): T {
  if (settings.layoutTheme !== LEGACY_COMPACT_LAYOUT_ID) return settings;
  return { ...settings, layoutTheme: DEFAULT_LAYOUT_ID, compact: true };
}

/**
 * Mirror a built-in layout choice into the deprecated `floatingIslands` flag,
 * so a build from before layout themes keeps the chosen arrangement after a
 * downgrade. A user layout leaves the flag as it was.
 */
export function withLegacyLayoutMirror<T extends { layoutTheme?: string; floatingIslands?: boolean }>(patch: T): T {
  if (patch.floatingIslands !== undefined || !isBuiltinLayoutId(patch.layoutTheme)) return patch;
  return { ...patch, floatingIslands: patch.layoutTheme === FLOATING_ISLANDS_LAYOUT_ID };
}
