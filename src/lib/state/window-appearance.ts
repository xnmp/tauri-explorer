/**
 * Window options shared by every code path that creates an explorer window —
 * fresh Ctrl+N windows (shared.ts) and hidden pre-warmed windows
 * (warm-window.ts) — so a warm window revealed later is indistinguishable from
 * a freshly created one on every platform.
 */

import type { Color } from "@tauri-apps/api/webviewWindow";
import type { Effect, EffectState, Effects } from "@tauri-apps/api/window";
import { isMac, isWindows } from "$lib/domain/platform";
import { materialEffects, type TranslucencyMaterial } from "$lib/domain/translucency";
import { E2E_HOOKS_ENABLED } from "$lib/api/e2e-hooks";
import { settingsStore } from "./settings.svelte";
import { newWindowMaterial } from "./window-translucency.svelte";
import { EXPLORER_BG_RGBA_KEY, loadPersisted } from "./persisted";

function getPersistedBgColor(): Color | undefined {
  const rgba = loadPersisted<[number, number, number, number] | null>(EXPLORER_BG_RGBA_KEY, null);
  return rgba ?? undefined;
}

/** The native effects for a JS-created window's material, matching the
 *  Rust-built main window (#1757). The domain names effects by Tauri's
 *  serialized enum values; the `satisfies` checks keep those names valid for
 *  this Tauri API. */
function materialOptions(material: TranslucencyMaterial | null): Effects | undefined {
  if (!material) return undefined;
  const { effects, state } = materialEffects(material);
  return {
    effects: effects.map((effect) => (effect satisfies `${Effect}`) as Effect),
    ...(state ? { state: (state satisfies `${EffectState}`) as EffectState } : {}),
  };
}

/** Appearance/behavior options for a new explorer window. Mirrors the main
 *  window's material so new windows match (macOS vibrancy, Windows acrylic or
 *  Mica). A material needs a transparent window and no opaque background
 *  colour; the DWM system backdrop still rounds the corners. The caller also
 *  puts `material` in the window's URL (`withWindowMaterial`), so pass the
 *  same value to both. */
export function explorerWindowAppearance(title: string, material: TranslucencyMaterial | null = newWindowMaterial()) {
  const windowEffects = materialOptions(material);
  const translucent = windowEffects !== undefined;
  // The public JS options omit this field, but Tauri's creation command
  // deserializes WindowConfig.additionalBrowserArgs. The Windows-only Cargo
  // attach feature injects the exact main-window string into every page.
  // Preserve it for all descendants sharing that WebView2 data directory.
  const browserArgs = E2E_HOOKS_ENABLED &&
    typeof window !== "undefined"
    ? (window as Window & { __E2E_WEBVIEW_BROWSER_ARGS__?: string }).__E2E_WEBVIEW_BROWSER_ARGS__
    : undefined;
  return {
    ...(isWindows && typeof browserArgs === "string" ? { additionalBrowserArgs: browserArgs } : {}),
    title,
    // A transparent window's persisted opaque colour would hide the material.
    backgroundColor: translucent ? undefined : getPersistedBgColor(),
    decorations: isMac,
    // Windows 11 only rounds corners (and draws the DWM shadow) on opaque
    // windows OR ones with a system backdrop. So an opaque window OR a
    // Mica/Acrylic backdrop keeps rounded corners; a plain transparent window
    // (no backdrop) is what produced the sharp-corner bug.
    transparent: translucent ? true : !isMac && !isWindows,
    shadow: isMac || isWindows,
    windowEffects,
    dragDropEnabled: true,
    acceptFirstMouse: true,
    titleBarStyle: isMac && settingsStore.integratedTitleBar ? ("overlay" as const) : undefined,
    hiddenTitle: isMac && settingsStore.integratedTitleBar,
  };
}
