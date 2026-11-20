/**
 * Site demo bridge: the decisions behind three of its host-facing behaviours,
 * kept free of the DOM and the stores so they can be tested through an import
 * (`site-demo-bridge.svelte.ts` wires them up).
 */
import type { MockControl } from "$lib/api/mock-control";

/** Where `focusApp` puts focus in the active pane when nothing holds it, in order. */
export const FOCUS_TARGETS = [
  ".file-list .entry-item.selected",
  ".file-list .entry-item[tabindex='0']",
  ".file-list .virtual-viewport",
] as const;

/** The first of FOCUS_TARGETS the pane has, else the pane itself; null without a pane. */
export function pickFocusTarget<T>(pane: (T & { querySelector(selector: string): T | null }) | null): T | null {
  if (!pane) return null;
  for (const selector of FOCUS_TARGETS) {
    const found = pane.querySelector(selector);
    if (found) return found;
  }
  return pane;
}

/** Focus needs restoring only when nothing in the frame holds it. */
export const focusIsLost = (active: unknown, body: unknown): boolean => !active || active === body;

/** Calls `emit` with each value that differs (as JSON) from the one before; the first always counts. */
export function changeEmitter(emit: (value: unknown) => void): (value: unknown) => void {
  let last: string | undefined;
  return (value) => {
    const key = JSON.stringify(value);
    if (key === last) return;
    last = key;
    emit(value);
  };
}

/** The title bar's window buttons go to the host as `window-control` events. */
export function forwardWindowControls(
  control: Pick<MockControl, "windowControl">,
  emit: (event: string, data: unknown) => void,
): void {
  control.windowControl = (action) => emit("window-control", { action });
}

/** The overlay flags the bridge reads from the dialog store, by name. */
export interface OverlayFlags {
  isQuickOpenOpen: boolean;
  isCommandPaletteOpen: boolean;
  isContentSearchOpen: boolean;
  isThemePickerOpen: boolean;
  isKeybindingsOpen: boolean;
  isSettingsOpen: boolean;
}

export type OverlayKind = "quick-open" | "command-palette" | "content-search" | "theme-picker" | "keybindings" | "settings";

/**
 * Which overlay the `overlay` event names (`kind`): the first open one, in the
 * order a host is likeliest to care about; null when none of these is open
 * (another dialog, the fullscreen preview, or nothing).
 */
export function overlayKind(flags: OverlayFlags): OverlayKind | null {
  if (flags.isQuickOpenOpen) return "quick-open";
  if (flags.isCommandPaletteOpen) return "command-palette";
  if (flags.isContentSearchOpen) return "content-search";
  if (flags.isThemePickerOpen) return "theme-picker";
  if (flags.isKeybindingsOpen) return "keybindings";
  if (flags.isSettingsOpen) return "settings";
  return null;
}
