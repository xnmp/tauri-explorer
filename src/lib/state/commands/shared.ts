/**
 * Shared helpers used across command definition modules.
 */

import { WebviewWindow, type Color } from "@tauri-apps/api/webviewWindow";
import { isMac, isWindows } from "$lib/domain/platform";
import { windowTabsManager, tabSeedKey, type TabSnapshot } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import { savePersisted } from "../persisted";
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

/** Open a new explorer window at the given path with optional view mode.
 *  When `tabSnapshot` is set (tab tear-off), the new window restores the
 *  full tab — dual-pane layout included — from a label-keyed seed. */
export async function openNewWindow(
  path: string,
  viewMode?: ViewMode,
  tabSnapshot?: TabSnapshot,
): Promise<void> {
  // Seed the child window with current directory entries for instant rendering
  const explorer = windowTabsManager.getActiveExplorer();
  if (explorer && explorer.currentPath === path) {
    savePersisted(`dir-seed:${path}`, {
      currentPath: explorer.currentPath,
      entries: explorer.displayEntries,
      sortBy: explorer.sortBy,
      sortAscending: explorer.sortAscending,
      viewMode: viewMode ?? explorer.viewMode,
      ts: Date.now(),
    });
  }

  const label = "explorer-" + Date.now();
  if (tabSnapshot) {
    savePersisted(tabSeedKey(label), { snapshot: tabSnapshot, ts: Date.now() });
  }
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
    // Windows 11 only rounds corners (and draws the DWM shadow) on opaque
    // windows. The main window is opaque on Windows, so new windows must be
    // too — a transparent window keeps the sharp corners the bug reports.
    transparent: !isMac && !isWindows,
    shadow: isMac || isWindows,
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
