/**
 * This window's translucency (#1757). The platform's material comes from the
 * native side (`window.__TRANSLUCENCY_MATERIAL__`, see `domain/translucency.ts`);
 * whether this window shows it was decided when the window was created, from
 * the settings of that moment, and cannot change while it lives.
 *
 * So the page follows the Translucency setting only until its settings have
 * loaded (the localStorage cache gives the first paint the right material),
 * then keeps that answer. Turning the setting on or off later reaches new
 * windows and the next launch; restyling this one would put a transparent
 * page on an opaque window, or the reverse.
 */

import { isMac, isWindows } from "$lib/domain/platform";
import { activeMaterial, platformMaterial, type TranslucencyMaterial } from "$lib/domain/translucency";
import { settingsStore } from "./settings.svelte";

/** The material this platform offers; null when it has none (the setting is
 *  hidden there). */
export const availableMaterial: TranslucencyMaterial | null = platformMaterial(
  typeof window === "undefined"
    ? undefined
    : (window as Window & { __TRANSLUCENCY_MATERIAL__?: unknown }).__TRANSLUCENCY_MATERIAL__,
  { isMac, isWindows },
);

let settled = $state<{ material: TranslucencyMaterial | null } | null>(null);

/** The material behind this window, or null for an opaque window. */
export function windowMaterial(): TranslucencyMaterial | null {
  return settled ? settled.material : activeMaterial(availableMaterial, settingsStore.translucency);
}

/** Fix this window's material once its settings have loaded: they are the
 *  settings the native window was created with. Later calls change nothing. */
export function settleWindowMaterial(): void {
  settled ??= { material: activeMaterial(availableMaterial, settingsStore.translucency) };
}

/** The material a window created now gets (none while the setting is off). */
export function newWindowMaterial(): TranslucencyMaterial | null {
  return activeMaterial(availableMaterial, settingsStore.translucency);
}
