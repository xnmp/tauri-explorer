/**
 * System-level actions that don't touch pane state — moved out of the
 * explorer store, which only carried them because the context menu had a
 * reference to it.
 */

import { setAsWallpaper as apiSetAsWallpaper } from "$lib/api/system";
import { openInTerminal as apiOpenInTerminal } from "$lib/api/open";
import { toastStore } from "../toast.svelte";
import { settingsStore } from "../settings.svelte";

/** A partial-wallpaper notice is a sentence or two; give it time to be read. */
const PARTIAL_NOTICE_MS = 8000;

export async function setWallpaper(path: string): Promise<void> {
  const result = await apiSetAsWallpaper(path);
  if (!result.ok) {
    toastStore.show(`Set wallpaper failed: ${result.error}`, "error");
  } else if (result.data) {
    // Partial success (e.g. macOS: other Spaces unchanged) — say what wasn't done.
    toastStore.show(result.data, "info", { duration: PARTIAL_NOTICE_MS });
  }
}

export async function openTerminal(directory: string): Promise<void> {
  const result = await apiOpenInTerminal(directory, settingsStore.terminalApp);
  if (!result.ok) {
    toastStore.show(`Open terminal failed: ${result.error}`, "error");
  }
}
