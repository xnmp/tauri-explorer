/**
 * Window options shared by every code path that creates an explorer window —
 * fresh Ctrl+N windows (shared.ts) and hidden pre-warmed windows
 * (warm-window.ts) — so a warm window revealed later is indistinguishable from
 * a freshly created one on every platform.
 */

import type { Color } from "@tauri-apps/api/webviewWindow";
import { isMac, isWindows } from "$lib/domain/platform";
import { windowsBackdropEffects } from "./window-backdrop";
import { settingsStore } from "./settings.svelte";
import { EXPLORER_BG_RGBA_KEY, loadPersisted } from "./persisted";

function getPersistedBgColor(): Color | undefined {
  const rgba = loadPersisted<[number, number, number, number] | null>(EXPLORER_BG_RGBA_KEY, null);
  return rgba ?? undefined;
}

/** Appearance/behavior options for a new explorer window. Mirrors the main
 *  window's backdrop so new windows match (issue: Windows Mica/Acrylic). A
 *  translucent backdrop needs a transparent window and no opaque background
 *  color; the DWM system backdrop still rounds the corners. */
export function explorerWindowAppearance() {
  const windowEffects = windowsBackdropEffects();
  const winBackdrop = windowEffects !== undefined;
  return {
    title: "tauri-explorer",
    backgroundColor: winBackdrop ? undefined : getPersistedBgColor(),
    decorations: isMac,
    // Windows 11 only rounds corners (and draws the DWM shadow) on opaque
    // windows OR ones with a system backdrop. So an opaque window OR a
    // Mica/Acrylic backdrop keeps rounded corners; a plain transparent window
    // (no backdrop) is what produced the sharp-corner bug.
    transparent: winBackdrop ? true : !isMac && !isWindows,
    shadow: isMac || isWindows,
    windowEffects,
    dragDropEnabled: true,
    acceptFirstMouse: true,
    titleBarStyle: isMac && settingsStore.integratedTitleBar ? ("overlay" as const) : undefined,
    hiddenTitle: isMac && settingsStore.integratedTitleBar,
  };
}
