/**
 * System-level actions that don't touch pane state — moved out of the
 * explorer store, which only carried them because the context menu had a
 * reference to it.
 */

import { setAsWallpaper as apiSetAsWallpaper } from "$lib/api/system";
import { openInTerminal as apiOpenInTerminal } from "$lib/api/open";
import { toastStore } from "../toast.svelte";
import { settingsStore } from "../settings.svelte";

export async function setWallpaper(path: string): Promise<void> {
  const result = await apiSetAsWallpaper(path);
  if (!result.ok) {
    toastStore.show(`Set wallpaper failed: ${result.error}`, "error");
  }
}

export async function openTerminal(directory: string): Promise<void> {
  const result = await apiOpenInTerminal(directory, settingsStore.terminalApp);
  if (!result.ok) {
    toastStore.show(`Open terminal failed: ${result.error}`, "error");
  }
}
