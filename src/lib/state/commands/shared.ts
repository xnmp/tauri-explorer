/**
 * Shared helpers used across command definition modules.
 */

import { WebviewWindow, type Color } from "@tauri-apps/api/webviewWindow";
import { isMac, isWindows } from "$lib/domain/platform";
import { windowsBackdropEffects } from "../window-backdrop";
import { windowTabsManager, tabSeedKey, type TabSnapshot } from "../window-tabs.svelte";
import { settingsStore } from "../settings.svelte";
import { savePersisted } from "../persisted";
import { consumeWarmWindow } from "../warm-window";
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
  /** Physical-pixel top-left to place the new window at (e.g. a tab tear-off at
   *  the cursor). Defaults to a small offset from the current window. */
  at?: { x: number; y: number },
): Promise<void> {
  // Seed the child window with current directory entries for instant rendering.
  // Shared by the warm-window and fresh-window paths.
  const writeSeed = () => {
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
  };

  // EXPERIMENTAL: activate a ready pre-warmed window instead of paying
  // webview-create cost. Tear-offs (tabSnapshot) always use a fresh window —
  // they need label-keyed snapshot seeding the warm path doesn't do. If no warm
  // window is ready (or activation fails), fall through to a fresh window so
  // Ctrl+N can never be a no-op.
  if (!tabSnapshot && settingsStore.warmWindow) {
    const used = await consumeWarmWindow(path, viewMode, at, writeSeed);
    if (used) return;
  }

  writeSeed();

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

  // Mirror the main window's backdrop so new windows match (issue: Windows
  // Mica/Acrylic). A translucent backdrop needs a transparent window and no
  // opaque background color; the DWM system backdrop still rounds the corners.
  const windowEffects = windowsBackdropEffects();
  const winBackdrop = windowEffects !== undefined;

  new WebviewWindow(label, {
    url,
    title: "tauri-explorer",
    width: size.width,
    height: size.height,
    // Tear-off places the new window so its title bar sits under the cursor;
    // otherwise offset slightly from the current window.
    x: at ? Math.round(at.x - 120) : pos.x + 30,
    y: at ? Math.round(at.y - 16) : pos.y + 30,
    backgroundColor: winBackdrop ? undefined : getPersistedBgColor(),
    decorations: isMac,
    // Windows 11 only rounds corners (and draws the DWM shadow) on opaque
    // windows OR ones with a system backdrop. So an opaque window OR a
    // Mica/Acrylic backdrop keeps rounded corners; a plain transparent window
    // (no backdrop) is what produced the sharp-corner bug.
    transparent: winBackdrop ? true : !isMac && !isWindows,
    shadow: isMac || isWindows,
    windowEffects,
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
