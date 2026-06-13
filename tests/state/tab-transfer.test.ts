/**
 * Cross-window tab transfer (src/lib/state/tab-transfer.ts): drag marker
 * round-trip, claim adopts + broadcasts + clears, source removes on claim.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal BroadcastChannel stub: all instances of one channel name share a
// listener list (mirrors same-origin window behavior closely enough).
type Listener = (event: MessageEvent) => void;
const channels = new Map<string, Set<Listener>>();

function listeners(name: string): Set<Listener> {
  let set = channels.get(name);
  if (!set) {
    set = new Set();
    channels.set(name, set);
  }
  return set;
}

class FakeBroadcastChannel {
  constructor(private name: string) {
    listeners(name);
  }
  addEventListener(_type: string, fn: Listener): void {
    listeners(this.name).add(fn);
  }
  removeEventListener(_type: string, fn: Listener): void {
    listeners(this.name).delete(fn);
  }
  postMessage(data: unknown): void {
    // Unlike the real API, deliver to ALL listeners including the sender's
    // window — harmless here, and lets one test observe both sides.
    for (const fn of listeners(this.name)) {
      fn({ data } as MessageEvent);
    }
  }
}

vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

const manager = vi.hoisted(() => ({
  adoptTab: vi.fn(),
  removeTransferredTab: vi.fn(),
  windowLabel: "main",
}));

vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: manager,
}));

import {
  tabDragState,
  isForeignTabDrag,
  claimDraggedTab,
  initTabTransferListener,
  type TabDragData,
} from "../../src/lib/state/tab-transfer";

function makeDrag(sourceWindow: string): TabDragData {
  return {
    sourceWindow,
    tabId: "tab-123",
    snapshot: {
      leftPath: "/home/user/Documents",
      rightPath: "/home/user",
      activePaneId: "left",
      dualPaneEnabled: false,
      splitRatio: 0.5,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  // The module caches its channel — empty the listener sets in place
  // instead of replacing them.
  for (const set of channels.values()) set.clear();
  manager.adoptTab.mockClear();
  manager.removeTransferredTab.mockClear();
});

describe("tabDragState", () => {
  it("round-trips drag data through localStorage", () => {
    expect(tabDragState.read()).toBeNull();
    tabDragState.start(makeDrag("explorer-1"));
    expect(tabDragState.read()).toMatchObject({ sourceWindow: "explorer-1", tabId: "tab-123" });
    tabDragState.clear();
    expect(tabDragState.read()).toBeNull();
  });
});

describe("isForeignTabDrag", () => {
  it("is true only for drags from a different window", () => {
    expect(isForeignTabDrag(null)).toBe(false);
    expect(isForeignTabDrag(makeDrag("main"))).toBe(false); // own window
    expect(isForeignTabDrag(makeDrag("explorer-2"))).toBe(true);
  });
});

describe("claim + source removal", () => {
  it("claiming adopts the tab, clears the marker, and the source removes its copy", () => {
    const stop = initTabTransferListener();

    // Simulate: another window ("explorer-1") started dragging a tab and we
    // are the target — except the listener under test plays the SOURCE role,
    // so make the drag originate from OUR window label ("main").
    const drag = makeDrag("main");
    tabDragState.start(drag);

    claimDraggedTab(drag, 2);

    expect(manager.adoptTab).toHaveBeenCalledWith(drag.snapshot, 2);
    expect(tabDragState.read()).toBeNull();
    // The broadcast reached the source-side listener, which removed the tab.
    expect(manager.removeTransferredTab).toHaveBeenCalledWith("tab-123");
    stop();
  });

  it("ignores claims for tabs from other windows", () => {
    const stop = initTabTransferListener();

    const drag = makeDrag("explorer-9"); // some other window's tab
    claimDraggedTab(drag);

    expect(manager.adoptTab).toHaveBeenCalledWith(drag.snapshot, undefined);
    // We are "main", the source is "explorer-9" — our listener must not
    // remove anything.
    expect(manager.removeTransferredTab).not.toHaveBeenCalled();
    stop();
  });

  it("unsubscribing stops source-side removal", () => {
    const stop = initTabTransferListener();
    stop();

    claimDraggedTab(makeDrag("main"));
    expect(manager.removeTransferredTab).not.toHaveBeenCalled();
  });
});
