/**
 * Shared helpers used across command definition modules.
 */

import { WebviewWindow, type Color } from "@tauri-apps/api/webviewWindow";
import { isMac } from "$lib/domain/platform";
import { windowTabsManager } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import type { ViewMode } from "../types";

function getPersistedBgColor(): Color | undefined {
  const raw = localStorage.getItem("explorer-bg-rgba");
  if (!raw) return undefined;
  try {
    const [r, g, b, a] = JSON.parse(raw) as [number, number, number, number];
    return [r, g, b, a];
  } catch {
    return undefined;
  }
}

/** Open a new explorer window at the given path with optional view mode */
export async function openNewWindow(path: string, viewMode?: ViewMode): Promise<void> {
  const label = "explorer-" + Date.now();
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({ path });
  if (viewMode) params.set("viewMode", viewMode);
  const url = `${baseUrl}?${params.toString()}`;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  new WebviewWindow(label, {
    url,
    title: "tauri-explorer",
    width: size.width,
    height: size.height,
    x: pos.x + 30,
    y: pos.y + 30,
    backgroundColor: getPersistedBgColor(),
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
