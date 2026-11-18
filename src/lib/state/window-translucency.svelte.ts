/**
 * This window's translucency (#1757). The platform's material comes from the
 * native side (`window.__TRANSLUCENCY_MATERIAL__`, see `domain/translucency.ts`);
 * whether this window shows it was decided when the window was created and
 * cannot change while it lives.
 *
 * Its creator says which: the Rust main window injects `__WINDOW_MATERIAL__`
 * and JS-created windows carry `material=` in their URL, which a reload or a
 * renderer recovery keeps. Only a page with neither (the browser build)
 * infers it: it follows the Translucency setting until its settings have
 * loaded, then keeps that answer. Turning the setting on or off later reaches
 * new windows and the next launch; restyling this one would put a transparent
 * page on an opaque window, or the reverse.
 */

import { isMac, isWindows } from "$lib/domain/platform";
import {
  activeMaterial,
  builtWindowMaterial,
  platformMaterial,
  type TranslucencyMaterial,
} from "$lib/domain/translucency";
import { settingsStore } from "./settings.svelte";

type MaterialWindow = Window & { __TRANSLUCENCY_MATERIAL__?: unknown; __WINDOW_MATERIAL__?: unknown };
const page = typeof window === "undefined" ? undefined : (window as MaterialWindow);

/** The material this platform offers; null when it has none (the setting is
 *  hidden there). */
export const availableMaterial: TranslucencyMaterial | null = platformMaterial(
  page?.__TRANSLUCENCY_MATERIAL__,
  { isMac, isWindows },
);

const built = page ? builtWindowMaterial(page.__WINDOW_MATERIAL__, page.location?.search ?? "") : undefined;

let settled = $state<{ material: TranslucencyMaterial | null } | null>(
  built === undefined ? null : { material: built },
);

/** The material behind this window, or null for an opaque window. */
export function windowMaterial(): TranslucencyMaterial | null {
  return settled ? settled.material : activeMaterial(availableMaterial, settingsStore.translucency);
}

/** Fix an inferred material once this window's settings have loaded: they are
 *  the settings the native window was created with. Changes nothing for a
 *  window whose creator said, nor on later calls. */
export function settleWindowMaterial(): void {
  settled ??= { material: activeMaterial(availableMaterial, settingsStore.translucency) };
}

/** The material a window created now gets (none while the setting is off). */
export function newWindowMaterial(): TranslucencyMaterial | null {
  return activeMaterial(availableMaterial, settingsStore.translucency);
}
