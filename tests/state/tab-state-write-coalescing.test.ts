/**
 * Tab-state persistence must stay off the interaction path (#481).
 *
 * window-tabs saves its state from ~19 call sites — every tab open, close,
 * switch, rename, split and pane focus. Under WebKitGTK localStorage is
 * SQLite-backed and fsyncs on the UI thread, so each of those writes can eat
 * a disk-flush stall (~70ms on a DRAM-less SSD) at the exact moment the user
 * pressed a key. Every write but the last is redundant — only the final tab
 * layout is ever read back.
 *
 * These tests assert on what reaches localStorage under the `explorer-tabs`
 * key: how many writes land, and whether the value a *next boot* restores is
 * still the post-burst state. That is the seam the behaviour actually flows
 * through — the manager's own getters would be green either way.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

const TABS_KEY = "explorer-tabs";

let setItem: ReturnType<typeof vi.spyOn>;

/** Values written to the tab-state key, oldest first. */
function tabWrites(): string[] {
  const calls = setItem.mock.calls as [string, string][];
  return calls.filter((c) => c[0] === TABS_KEY).map((c) => c[1]);
}

/** The tab state a next boot would restore, or null if nothing is stored. */
function storedState(): { tabs: unknown[]; activeTabId: string | null } | null {
  const raw = localStorage.getItem(TABS_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** A manager with one tab at /home/user and no saved state read back. */
function freshManager() {
  const manager = createWindowTabsManager();
  manager.init("/home/user", true);
  return manager;
}

/** Explorer loads use real async work, so release fake persistence timers
 * before awaiting the manager teardown that owns those loads. */
async function disposeManagers(...managers: Array<ReturnType<typeof createWindowTabsManager>>) {
  vi.useRealTimers();
  await Promise.all(managers.map((manager) => manager.dispose()));
}

/** An EventTarget stand-in — the unit env is `node`, with no real window. */
function fakeEventTarget() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    addEventListener(type: string, fn: (e: Event) => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(new Event(type));
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  setItem = vi.spyOn(localStorage, "setItem");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tab-state write coalescing (#481)", () => {
  it("a burst of ten tab interactions costs one localStorage write, not ten", async () => {
    const manager = freshManager();
    setItem.mockClear(); // ignore the write from init()

    // Ten interactions, 10ms apart — a plausible burst of Ctrl+T / Ctrl+Tab.
    for (let i = 0; i < 4; i++) {
      manager.createTab(`/tmp/burst-${i}`);
      vi.advanceTimersByTime(10);
    }
    for (let i = 0; i < 6; i++) {
      manager.nextTab();
      vi.advanceTimersByTime(10);
    }

    // Nothing may land while the user is still interacting.
    expect(tabWrites()).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(tabWrites()).toHaveLength(1);

    await disposeManagers(manager);
  });

  it("the coalesced write is the state of the last interaction, so a next boot restores it", async () => {
    const manager = freshManager();
    manager.createTab("/tmp/one");
    manager.createTab("/tmp/two");
    manager.createTab("/tmp/three");
    const finalActiveId = manager.activeTabId;
    const finalTabCount = manager.tabs.length;

    vi.advanceTimersByTime(500);

    // The stored value is the post-burst state, not an intermediate one.
    expect(storedState()).toMatchObject({ activeTabId: finalActiveId });
    expect(storedState()!.tabs).toHaveLength(finalTabCount);

    // And a cold start really does come back with those tabs.
    const rebooted = createWindowTabsManager();
    rebooted.init("/home/user");
    expect(rebooted.tabs).toHaveLength(finalTabCount);
    expect(rebooted.getTabPath(rebooted.activeTabId!)).toBe("/tmp/three");

    await disposeManagers(manager, rebooted);
  });

  it("save() still persists synchronously for the beforeunload and interval saves", async () => {
    const manager = freshManager();
    manager.createTab("/tmp/urgent");
    setItem.mockClear();

    manager.save();

    // Stored before any timer runs — use-window-lifecycle depends on this.
    expect(tabWrites()).toHaveLength(1);
    expect(storedState()).toMatchObject({ activeTabId: manager.activeTabId });

    // …and it consumed the coalesced write rather than queueing behind it.
    vi.advanceTimersByTime(500);
    expect(tabWrites()).toHaveLength(1);

    await disposeManagers(manager);
  });

  it("a write still pending when the page is hidden lands before the page goes away", async () => {
    const doc = fakeEventTarget() as ReturnType<typeof fakeEventTarget> & {
      visibilityState: string;
    };
    doc.visibilityState = "visible";
    vi.stubGlobal("document", doc);
    const manager = freshManager();
    manager.createTab("/tmp/closing");
    setItem.mockClear();

    doc.visibilityState = "hidden";
    doc.emit("visibilitychange");

    expect(tabWrites()).toHaveLength(1);
    expect(storedState()!.tabs).toHaveLength(manager.tabs.length);

    await disposeManagers(manager);
  });

  it("a write still pending on pagehide is not lost", async () => {
    const win = fakeEventTarget();
    vi.stubGlobal("window", win);
    const manager = freshManager();
    manager.createTab("/tmp/unloading");
    setItem.mockClear();

    win.emit("pagehide");

    expect(tabWrites()).toHaveLength(1);
    expect(storedState()!.tabs).toHaveLength(manager.tabs.length);

    await disposeManagers(manager);
  });

  it("coalescing is per burst: a later interaction writes again", async () => {
    const manager = freshManager();
    setItem.mockClear();

    manager.createTab("/tmp/first-burst");
    vi.advanceTimersByTime(500);
    expect(tabWrites()).toHaveLength(1);

    manager.createTab("/tmp/second-burst");
    vi.advanceTimersByTime(500);
    expect(tabWrites()).toHaveLength(2);
    expect(storedState()!.tabs).toHaveLength(3);

    await disposeManagers(manager);
  });
});
