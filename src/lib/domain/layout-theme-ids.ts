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

export type BuiltinLayoutId =
  | typeof DEFAULT_LAYOUT_ID
  | typeof FLOATING_ISLANDS_LAYOUT_ID
  | typeof HAIRLINE_LEDGER_LAYOUT_ID;

const BUILTIN_IDS: readonly string[] = [
  DEFAULT_LAYOUT_ID,
  FLOATING_ISLANDS_LAYOUT_ID,
  HAIRLINE_LEDGER_LAYOUT_ID,
];

export function isBuiltinLayoutId(value: unknown): value is BuiltinLayoutId {
  return typeof value === "string" && BUILTIN_IDS.includes(value);
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
