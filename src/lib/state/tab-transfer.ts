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
/** Tauri event used to hand a tab off to a specific window (cross-window move). */
const ADOPT_EVENT = "explorer://adopt-tab";

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

/**
 * Resolve which explorer window (if any) contains the given SCREEN position
 * (physical pixels). Returns the window label, or null if the point is outside
 * every window. This is how a cross-window tab drop is detected: HTML5 drag
 * events never reach another Tauri webview, so the SOURCE window resolves the
 * release position itself instead of relying on the target receiving a drop.
 */
export async function windowAtScreenPos(physX: number, physY: number): Promise<string | null> {
  try {
    const { getAllWindows } = await import("@tauri-apps/api/window");
    const wins = await getAllWindows();
    for (const w of wins) {
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      if (
        physX >= pos.x &&
        physX < pos.x + size.width &&
        physY >= pos.y &&
        physY < pos.y + size.height
      ) {
        return w.label;
      }
    }
  } catch {
    // Not running under Tauri (e.g. browser E2E) — no windows to resolve.
  }
  return null;
}

/** Source side: push the dragged tab to another window via a Tauri event. */
export async function sendTabToWindow(targetLabel: string, snapshot: TabSnapshot): Promise<void> {
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo(targetLabel, ADOPT_EVENT, snapshot);
  } catch {
    // Not in Tauri runtime.
  }
}

/** Source side: remove tabs that other windows claim, and (target side) adopt
 *  tabs handed to us via the Tauri adopt event. Call once per window; returns
 *  an unsubscribe. */
export function initTabTransferListener(): () => void {
  // Source side: BroadcastChannel removal when a same-document drop claims a tab.
  const ch = getChannel();
  const onMessage = (event: MessageEvent) => {
    const msg = event.data as TabClaimedMessage | null;
    if (msg?.type !== "tab-claimed") return;
    if (msg.sourceWindow !== windowTabsManager.windowLabel) return;
    windowTabsManager.removeTransferredTab(msg.tabId);
  };
  ch?.addEventListener("message", onMessage);

  // Target side: adopt a tab handed to us from another window via Tauri event.
  let unlistenAdopt: (() => void) | null = null;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<TabSnapshot>(ADOPT_EVENT, (event) => {
        windowTabsManager.adoptTab(event.payload);
        import("@tauri-apps/api/window")
          .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
          .catch(() => {});
      }),
    )
    .then((un) => {
      unlistenAdopt = un;
    })
    .catch(() => {}); // Not in Tauri runtime.

  return () => {
    ch?.removeEventListener("message", onMessage);
    unlistenAdopt?.();
  };
}
