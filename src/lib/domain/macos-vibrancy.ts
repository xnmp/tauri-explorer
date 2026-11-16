/**
 * macOS window vibrancy (#1733): which native window options every explorer
 * window gets for the user's vibrancy settings.
 *
 * The Rust-built main window (`src-tauri/src/lib.rs`, `macos_vibrancy_effects`)
 * reads the same two settings from settings.json before the webview exists, so
 * it cannot call this module; windows created from JS (fresh Ctrl+N children
 * and parked warm windows, via `state/window-appearance.ts`) do. The two must
 * agree or a new window looks different from the first one. The material name
 * is checked against the Rust constant by `tests/domain/macos-vibrancy.test.ts`.
 *
 * - Vibrancy off, or not macOS: no change (undefined).
 * - Vibrancy on, Native Blur off: a transparent window with no material; the
 *   page paints the theme background itself (`data-transparent-window`).
 * - Vibrancy on, Native Blur on: transparent plus the material.
 */

/**
 * `NSVisualEffectMaterial.sidebar`. `UnderWindowBackground` looked opaque in
 * dark mode (docs/lessons/1733-macos-vibrancy-material.md). The value is the
 * serialized name of Tauri's `Effect.Sidebar`.
 */
export const MACOS_VIBRANCY_MATERIAL = "sidebar" as const;

/** Keep the material lit while the window is inactive, like the main window. */
export const MACOS_VIBRANCY_STATE = "active" as const;

export interface MacOsVibrancySettings {
  readonly macOsVibrancy: boolean;
  readonly vibrancyBlur: boolean;
}

export type MacOsVibrancyMode = "off" | "transparent" | "material";

export interface MacOsWindowVibrancy {
  readonly transparent: true;
  readonly effects?: {
    readonly material: typeof MACOS_VIBRANCY_MATERIAL;
    readonly state: typeof MACOS_VIBRANCY_STATE;
  };
}

/** How the window is drawn for these settings on this platform. Settings are
 *  read defensively: anything but `true` counts as off (a malformed or partial
 *  settings blob must never turn transparency on), and Native Blur defaults
 *  on exactly as the Rust reader's `unwrap_or(true)` does. */
export function macOsVibrancyMode(
  isMac: boolean,
  settings: Partial<MacOsVibrancySettings> | null | undefined,
): MacOsVibrancyMode {
  if (!isMac || settings?.macOsVibrancy !== true) return "off";
  return settings.vibrancyBlur === false ? "transparent" : "material";
}

/** Native window options for a new explorer window, or undefined when the
 *  window keeps its platform defaults. */
export function macOsWindowVibrancy(
  isMac: boolean,
  settings: Partial<MacOsVibrancySettings> | null | undefined,
): MacOsWindowVibrancy | undefined {
  switch (macOsVibrancyMode(isMac, settings)) {
    case "off":
      return undefined;
    case "transparent":
      return { transparent: true };
    case "material":
      return {
        transparent: true,
        effects: { material: MACOS_VIBRANCY_MATERIAL, state: MACOS_VIBRANCY_STATE },
      };
  }
}
