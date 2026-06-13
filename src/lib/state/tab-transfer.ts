/**
 * Cross-window tab drag-and-drop and tear-off.
 *
 * Mirrors the file-drag pattern (drag.svelte.ts): dataTransfer is
 * unreliable between separate webview contexts in Tauri, so the in-flight
 * tab drag is marked in localStorage (all windows share the origin), and a
 * BroadcastChannel tells the source window when a target claimed the tab.
 *
 * Flow:
 * - source dragstart  → tabDragState.start(snapshot + ids)
 * - target tab-strip drop → claimDraggedTab(): adopt locally, clear marker,
 *   broadcast "tab-claimed"
 * - source "tab-claimed" → removeTransferredTab() (no closed-tab snapshot)
 * - source dragend with no claim and the pointer outside the window
 *   → tear-off: spawn a new window seeded with the tab (WindowTabBar)
 */

import { loadPersisted, savePersisted, removePersisted } from "./persisted";
import { windowTabsManager, type TabSnapshot } from "./window-tabs.svelte";

const DRAG_KEY = "explorer-tab-drag";
const CHANNEL_NAME = "explorer-tab-transfer";

export interface TabDragData {
  sourceWindow: string;
  tabId: string;
  snapshot: TabSnapshot;
}

interface TabClaimedMessage {
  type: "tab-claimed";
  sourceWindow: string;
  tabId: string;
}

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** The in-flight tab drag, visible to every window. */
export const tabDragState = {
  start(data: TabDragData): void {
    savePersisted(DRAG_KEY, data);
  },
  read(): TabDragData | null {
    return loadPersisted<TabDragData | null>(DRAG_KEY, null);
  },
  clear(): void {
    removePersisted(DRAG_KEY);
  },
};

/** True when `data` is a tab drag coming from a different window. */
export function isForeignTabDrag(data: TabDragData | null): data is TabDragData {
  return data !== null && data.sourceWindow !== windowTabsManager.windowLabel;
}

/** Target side: adopt the dragged tab into this window (at `index`),
 *  notify the source so it removes its copy, and take focus. */
export function claimDraggedTab(data: TabDragData, index?: number): void {
  windowTabsManager.adoptTab(data.snapshot, index);
  tabDragState.clear();
  const msg: TabClaimedMessage = {
    type: "tab-claimed",
    sourceWindow: data.sourceWindow,
    tabId: data.tabId,
  };
  getChannel()?.postMessage(msg);
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
    .catch(() => {}); // Not in Tauri runtime
}

/** Source side: remove tabs that other windows claim. Call once per window;
 *  returns an unsubscribe. */
export function initTabTransferListener(): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const onMessage = (event: MessageEvent) => {
    const msg = event.data as TabClaimedMessage | null;
    if (msg?.type !== "tab-claimed") return;
    if (msg.sourceWindow !== windowTabsManager.windowLabel) return;
    windowTabsManager.removeTransferredTab(msg.tabId);
  };
  ch.addEventListener("message", onMessage);
  return () => ch.removeEventListener("message", onMessage);
}
