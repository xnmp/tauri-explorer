/**
 * Shared helpers used across command definition modules.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { windowTabsManager, tabSeedKey, type TabSnapshot } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import { savePersisted } from "../persisted";
import { consumeWarmWindow } from "../warm-window";
import { explorerWindowAppearance } from "../window-appearance";
import { formatWindowTitle } from "../../domain/tab-title";
import { resolveLaunchHomePath } from "../window-title.svelte";
import type { ViewMode } from "../types";

/** Open a new explorer window at the given path with optional view mode.
 *  When `tabSnapshot` is set (tab tear-off), the new window restores the
 *  full tab — dual-pane layout included — from a label-keyed seed. */
export async function openNewWindow(
  path: string,
  viewMode?: ViewMode,
  tabSnapshot?: TabSnapshot,
  /** Physical-pixel top-left to place the new window at (e.g. a tab tear-off at
   *  the cursor). Defaults to a small offset from the current window. */
  at?: { x: number; y: number },
): Promise<WebviewWindow | null> {
  // EXPERIMENTAL: activate a ready pre-warmed window instead of paying
  // webview-create cost. Tear-offs (tabSnapshot) always use a fresh window —
  // they need label-keyed snapshot seeding the warm path doesn't do. If no warm
  // window is ready (or activation fails), fall through to a fresh window so
  // Ctrl+N can never be a no-op.
  if (!tabSnapshot && settingsStore.warmWindow) {
    const used = await consumeWarmWindow(path, viewMode, at);
    if (used) return null;
  }

  // Seed the child window with current directory entries for instant
  // rendering. Fresh windows only: seeds are consumed at boot by
  // windowTabsManager.init, which a warm window ran long ago.
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
  const params = new URLSearchParams({ path, focusAddressBar: "1" });
  const homePath = resolveLaunchHomePath();
  if (homePath) params.set("home", homePath);
  if (viewMode) params.set("viewMode", viewMode);
  const url = `${baseUrl}?${params.toString()}`;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  const size = await win.outerSize();

  return new WebviewWindow(label, {
    url,
    width: size.width,
    height: size.height,
    // Tear-off places the new window so its title bar sits under the cursor;
    // otherwise offset slightly from the current window.
    x: at ? Math.round(at.x - 120) : pos.x + 30,
    y: at ? Math.round(at.y - 16) : pos.y + 30,
    ...explorerWindowAppearance(formatWindowTitle(path, homePath)),
  });
}

/** Get the active explorer instance for commands */
export function getActiveExplorer() {
  return windowTabsManager.getActiveExplorer();
}
