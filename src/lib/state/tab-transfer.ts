/** Pointer-driven tab drag markers and acknowledged native tab transfers.
 * The sender retains ownership until the destination actually adopts its tab. */

import { windowTabsManager, type TabSnapshot } from "./window-tabs.svelte";
import { normalizeSnapshot } from "./window-tabs-persistence";
import { TAB_ADOPT_EVENT, acknowledgeWindowHandoff, normalizeWindowHandoff, requestWindowHandoff } from "./window-handoff";
import { isRecord, isWindowPath, windowSeedFitsBudget } from "$lib/domain/window-input";

export interface TabDragData {
  id: string;
  sourceWindow: string;
  tabId: string;
  snapshot: TabSnapshot;
}

function normalizeTabDrag(raw: unknown): TabDragData | null {
  if (!isRecord(raw) || !isWindowPath(raw.id) || !isWindowPath(raw.sourceWindow) || !isWindowPath(raw.tabId)) return null;
  const snapshot = normalizeSnapshot(raw.snapshot);
  return snapshot ? { id: raw.id, sourceWindow: raw.sourceWindow, tabId: raw.tabId, snapshot } : null;
}

/** Pointer drag state belongs to this source window. Native transfer routing
 * uses screen coordinates and explicit messages; no other window reads this
 * marker, so it must not persist across windows or application launches. */
export function createTabDragState() {
  let active: TabDragData | null = null;
  return {
    start(data: unknown): string | null {
      active = isRecord(data) ? normalizeTabDrag({ ...data, id: crypto.randomUUID() }) : null;
      return active?.id ?? null;
    },
    read(): TabDragData | null { return active; },
    clear(expectedId: string | null | undefined): boolean {
      if (!active || active.id !== expectedId) return false;
      active = null;
      return true;
    },
  };
}

export const tabDragState = createTabDragState();

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
      if (!await w.isVisible()) continue;
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

/** False leaves the source tab intact, including when a picker or an unready
 * window receives the native event but has no adoption listener. */
export async function sendTabToWindow(targetLabel: string, snapshot: TabSnapshot): Promise<boolean> {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized || !windowSeedFitsBudget(normalized)) return false;
  return requestWindowHandoff(windowTabsManager.windowLabel, targetLabel, async (handoff) => {
    const { emitTo } = await import("@tauri-apps/api/event");
    const payload = { snapshot: normalized, handoff };
    if (!windowSeedFitsBudget(payload)) throw new Error("Tab transfer exceeds window message budget");
    await emitTo(targetLabel, TAB_ADOPT_EVENT, payload);
  });
}

/** Install a label-scoped receiver: Tauri's default Any target also receives
 * events emitted to other windows. Picker windows never install it, and therefore cannot acknowledge/consume a tab dropped over them. */
export function initTabTransferListener(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  const adoptedRequests = new Set<string>();
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<unknown>(TAB_ADOPT_EVENT, async ({ payload }) => {
      if (disposed || !isRecord(payload) || !windowSeedFitsBudget(payload)) return;
      const snapshot = normalizeSnapshot(payload.snapshot);
      const handoff = normalizeWindowHandoff(payload.handoff);
      if (!snapshot || !handoff) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const self = getCurrentWindow();
        if (!await self.isVisible() || disposed || !windowTabsManager.acceptsTransfers) return;
        const requestKey = JSON.stringify([handoff.sourceWindow, handoff.requestId]);
        if (!adoptedRequests.has(requestKey)) {
          windowTabsManager.adoptTab(snapshot);
          adoptedRequests.add(requestKey);
          if (adoptedRequests.size > 128) adoptedRequests.delete(adoptedRequests.values().next().value!);
        }
        await acknowledgeWindowHandoff(handoff, windowTabsManager.windowLabel);
        if (!disposed) await self.setFocus();
      } catch {
        // The native destination may disappear at any await. Without an
        // acknowledgement the source keeps its tab; retries remain idempotent.
      }
    }, { target: windowTabsManager.windowLabel }),
  ).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(() => {});
  return () => {
    if (disposed) return;
    disposed = true;
    adoptedRequests.clear();
    unlisten?.();
  };
}
