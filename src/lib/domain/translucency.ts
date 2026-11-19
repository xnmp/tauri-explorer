/**
 * Window translucency (#1757): one cross-platform setting, implemented with
 * each platform's own window material.
 *
 * - macOS: NSVisualEffectView vibrancy with the `sidebar` material (#1733).
 * - Windows 11 22H2+: the DWM transient (acrylic) system backdrop.
 * - Windows 11 before 22H2: Mica.
 * - Elsewhere (Linux, Windows 10): unavailable, so the setting is hidden.
 *
 * The native side picks the material (`src-tauri/src/translucency.rs`, which
 * knows the OS build) and publishes it to every page as
 * `window.__TRANSLUCENCY_MATERIAL__`; this module turns that and the user's
 * setting into window options and page state. A material is a property of the
 * window, fixed when the window is created: a window built opaque cannot show
 * one, so turning the setting on applies to new windows and after a restart.
 */

/** A native window material the app can put behind a translucent window. */
export type TranslucencyMaterial = "vibrancy" | "acrylic" | "mica";

const MATERIALS: readonly TranslucencyMaterial[] = ["vibrancy", "acrylic", "mica"];

/**
 * `NSVisualEffectMaterial.sidebar`. `UnderWindowBackground` looked opaque in
 * dark mode (docs/lessons/1733-macos-vibrancy-material.md). The value is the
 * serialized name of Tauri's `Effect.Sidebar`; `tests/domain/translucency.test.ts`
 * keeps it equal to the Rust constant.
 */
export const MACOS_VIBRANCY_MATERIAL = "sidebar" as const;

/** Keep the macOS material lit while the window is inactive. */
export const MACOS_VIBRANCY_STATE = "active" as const;

export function isTranslucencyMaterial(value: unknown): value is TranslucencyMaterial {
  return typeof value === "string" && (MATERIALS as readonly string[]).includes(value);
}

/**
 * The material this platform offers. `published` is what the native side
 * injected: a material, or null where none is available. When nothing was
 * published (the browser build and its tests), fall back to the platform's
 * usual material so a simulated macOS or Windows page behaves like one.
 */
export function platformMaterial(
  published: unknown,
  platform: { readonly isMac: boolean; readonly isWindows: boolean },
): TranslucencyMaterial | null {
  if (published === null || isTranslucencyMaterial(published)) return published;
  if (platform.isMac) return "vibrancy";
  if (platform.isWindows) return "acrylic";
  return null;
}

/**
 * Launch-URL parameter naming the material a JS-created window was built
 * with ("none" for an opaque window). Unlike a one-shot launch request it
 * describes the window itself, so a reload or renderer recovery keeps
 * reading it (not through `launchRequest`).
 */
export const WINDOW_MATERIAL_PARAM = "material";
const NO_MATERIAL = "none";

/** `params` plus the material a window is being built with. */
export function withWindowMaterial(
  params: URLSearchParams,
  material: TranslucencyMaterial | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set(WINDOW_MATERIAL_PARAM, material ?? NO_MATERIAL);
  return next;
}

/**
 * The material this page's window was actually built with, as its creator
 * published it: the Rust main window injects `__WINDOW_MATERIAL__`, a
 * JS-created window carries `material=` in its URL. Undefined when neither
 * says (the browser build), and the page must infer it from its settings.
 * `src/app.html` repeats this read for its pre-paint background.
 */
export function builtWindowMaterial(
  injected: unknown,
  search: string,
): TranslucencyMaterial | null | undefined {
  if (injected === null || isTranslucencyMaterial(injected)) return injected;
  const param = new URLSearchParams(search).get(WINDOW_MATERIAL_PARAM);
  if (param === NO_MATERIAL) return null;
  return isTranslucencyMaterial(param) ? param : undefined;
}

/** The material actually behind a window: the platform's, when the setting
 *  is on. Anything but `true` counts as off, so a malformed settings blob can
 *  never make a window transparent. */
export function activeMaterial(
  available: TranslucencyMaterial | null,
  enabled: unknown,
): TranslucencyMaterial | null {
  return enabled === true ? available : null;
}

/** Native window effects for a material, in Tauri's serialized names. */
export interface MaterialEffects {
  readonly effects: readonly [typeof MACOS_VIBRANCY_MATERIAL | "acrylic" | "mica"];
  readonly state?: typeof MACOS_VIBRANCY_STATE;
}

export function materialEffects(material: TranslucencyMaterial): MaterialEffects {
  switch (material) {
    case "vibrancy":
      return { effects: [MACOS_VIBRANCY_MATERIAL], state: MACOS_VIBRANCY_STATE };
    case "acrylic":
      return { effects: ["acrylic"] };
    case "mica":
      return { effects: ["mica"] };
  }
}

/**
 * The Translucency setting for a blob written before #1757, which configured
 * each platform separately: macOS "Window Vibrancy" (with or without "Native
 * Blur") or a Windows Mica/Acrylic backdrop. Either one meant the user wanted
 * a translucent window. The Rust window builder applies the same rule to a
 * settings.json the frontend has not migrated yet (`legacy_enabled`).
 */
export function legacyTranslucency(persisted: unknown): boolean {
  if (typeof persisted !== "object" || persisted === null) return false;
  const blob = persisted as Record<string, unknown>;
  return blob.macOsVibrancy === true || blob.windowsBackdrop === "mica" || blob.windowsBackdrop === "acrylic";
}
