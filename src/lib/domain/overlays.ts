/**
 * Boolean overlay registry (#1565): the window dialogs that carry no payload.
 *
 * Adding such a dialog means adding one id here; `dialogStore` derives
 * "any open", "close all" and the unmounted sweep from this registry, so a
 * dialog cannot be forgotten by one of them. Dialogs with payloads (file
 * operations, picker, image editor, open-with, modal ownership) live in the
 * store but join the same any/close rules there.
 *
 * Every overlay here is blocking (counts toward "any modal open") and is
 * closed by both close-all and the unmounted sweep; there are no exceptions
 * today. If one is ever needed, encode it as per-id data here, not in the store.
 */
export const OVERLAY_IDS = [
  "quickOpen",
  "commandPalette",
  "settings",
  "about",
  "contentSearch",
  "workspace",
  "jobsPanel",
  "themePicker",
  "shortcuts",
  "keybindings",
  "plugins",
  "userReport",
  "fileRecovery",
] as const;

export type OverlayId = (typeof OVERLAY_IDS)[number];
export type OpenOverlays = ReadonlySet<OverlayId>;

export const NO_OVERLAYS: OpenOverlays = new Set<OverlayId>();

export function isOverlayOpen(open: OpenOverlays, id: OverlayId): boolean {
  return open.has(id);
}

/** Opens `id`, first closing every id in `closing` (mutually exclusive peers). */
export function openOverlay(open: OpenOverlays, id: OverlayId, closing: readonly OverlayId[] = []): OpenOverlays {
  const next = new Set(open);
  for (const other of closing) next.delete(other);
  next.add(id);
  return next;
}

export function closeOverlay(open: OpenOverlays, id: OverlayId): OpenOverlays {
  if (!open.has(id)) return open;
  const next = new Set(open);
  next.delete(id);
  return next;
}

export function toggleOverlay(open: OpenOverlays, id: OverlayId): OpenOverlays {
  return open.has(id) ? closeOverlay(open, id) : openOverlay(open, id);
}

export function closeAllOverlays(): OpenOverlays {
  return NO_OVERLAYS;
}

export function anyOverlayOpen(open: OpenOverlays): boolean {
  return open.size > 0;
}
