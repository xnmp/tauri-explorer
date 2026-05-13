/**
 * Shared helpers used across command definition modules.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isMac } from "$lib/domain/platform";
import { windowTabsManager } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import type { ViewMode } from "../types";

/** Open a new explorer window at the given path with optional view mode */
export function openNewWindow(path: string, viewMode?: ViewMode): void {
  const label = "explorer-" + Date.now();
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({ path });
  if (viewMode) params.set("viewMode", viewMode);
  const url = `${baseUrl}?${params.toString()}`;
  new WebviewWindow(label, {
    url,
    title: "tauri-explorer",
    width: 1200,
    height: 800,
    decorations: isMac,
    transparent: !isMac,
    shadow: isMac,
    dragDropEnabled: true,
    acceptFirstMouse: true,
    titleBarStyle: isMac && settingsStore.integratedTitleBar ? "overlay" : undefined,
    hiddenTitle: isMac && settingsStore.integratedTitleBar,
  });
}

/** Get the active explorer instance for commands */
export function getActiveExplorer() {
  return windowTabsManager.getActiveExplorer();
}
