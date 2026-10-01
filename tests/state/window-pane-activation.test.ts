import { expect, it, vi, beforeEach } from "vitest";
const native = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", destroy: native.destroy }) }));
beforeEach(() => { native.destroy.mockReset().mockResolvedValue(undefined); });
import { persistedLeaves } from "$lib/state/window-tabs-persistence";
import { createWindowTabsManager, type PersistedNode } from "$lib/state/window-tabs.svelte";

function fixture(prefix: string, count = 64) {
  let next = 0;
  function tree(size: number): PersistedNode {
    const id = `${prefix}-${next++}`;
    if (size === 1) return { type: "leaf", id, path: "/home/user" };
    const first = Math.floor(size / 2);
    return { type: "split", id, direction: "row", ratio: 0.5, first: tree(first), second: tree(size - first) };
  }
  const layout = tree(count);
  const activePaneId = `${prefix}-${next - 1}`;
  return { version: 3, tabs: [{ id: prefix, kind: "explorer", layout, activePaneId }], activeTabId: prefix };
}

function scheduler() {
  const pending = new Set<() => void>();
  const captured: (() => void)[] = [];
  return {
    captured,
    schedule(callback: () => void) { pending.add(callback); captured.push(callback); return () => { pending.delete(callback); }; },
    frame() { const batch = [...pending]; pending.clear(); for (const run of batch) run(); },
    drain() { for (let i = 0; pending.size && i < 100; i++) this.frame(); expect(pending.size).toBe(0); },
  };
}

it("opens the focused pane first and restores the complete large layout in bounded batches", async () => {
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    const state = fixture("large");
    manager.restoreFromState(state);
    expect(manager.getActiveExplorer()).toBeDefined();
    expect(manager.getAllExplorers()).toHaveLength(1);
    expect(manager.captureState().tabs[0].layout).toEqual(state.tabs[0].layout);
    clock.frame();
    expect(manager.getAllExplorers()).toHaveLength(5);
    clock.drain();
    expect(manager.getAllExplorers()).toHaveLength(64);
    expect(manager.captureState().tabs[0].layout).toEqual(state.tabs[0].layout);
  } finally { await manager.dispose(); }
});

it("a tab switch cancels pending activation without allocating the departed layout", async () => {
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    manager.restoreFromState(fixture("large"));
    const other = manager.createTab("/home/user/Documents");
    for (const late of [...clock.captured]) late();
    expect(manager.activeTabId).toBe(other.id);
    expect(manager.getAllExplorers()).toHaveLength(2);
    manager.setActiveTab("large");
    clock.drain();
    expect(manager.getAllExplorers()).toHaveLength(65);
  } finally { await manager.dispose(); }
});

it("obsolete activation cannot populate reused pane IDs after restoration or disposal", async () => {
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    const state = fixture("same");
    manager.restoreFromState(state);
    const obsolete = [...clock.captured];
    manager.restoreFromState(state);
    for (const late of obsolete) late();
    expect(manager.getAllExplorers()).toHaveLength(1);
    const pending = [...clock.captured];
    await manager.dispose();
    for (const late of pending) late();
    expect(manager.getAllExplorers()).toHaveLength(0);
  } finally { await manager.dispose(); }
});

it("focusing a reserved pane opens it immediately without duplicating its later batch", async () => {
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    const state = fixture("focus");
    manager.restoreFromState(state);
    const first = persistedLeaves(state.tabs[0].layout)[0].id;
    manager.setActivePane(first);
    const focused = manager.getActiveExplorer();
    expect(focused).toBeDefined();
    expect(manager.getAllExplorers()).toHaveLength(2);
    clock.drain();
    expect(manager.getActiveExplorer()).toBe(focused);
    expect(manager.getAllExplorers()).toHaveLength(64);
  } finally { await manager.dispose(); }
});

it("resumes materialization when native close rejects and the layout survives", async () => {
  let rejectClose!: (error: Error) => void;
  native.destroy.mockImplementation(() => new Promise<void>((_, reject) => { rejectClose = reject; }));
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    manager.restoreFromState(fixture("survivor"));
    manager.closeTab("survivor");
    await vi.waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
    manager.setActiveTab("survivor");
    clock.frame();
    expect(manager.getAllExplorers()).toHaveLength(1);
    rejectClose(new Error("native close refused"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.drain();
    expect(manager.tabs).toHaveLength(1);
    expect(manager.getAllExplorers()).toHaveLength(64);
  } finally { await manager.dispose(); }
});

it("closing the focused pane immediately opens its reserved successor", async () => {
  const clock = scheduler();
  const manager = createWindowTabsManager({ schedulePaneActivation: clock.schedule });
  try {
    const state = fixture("close-pane");
    manager.restoreFromState(state);
    const leaves = persistedLeaves(state.tabs[0].layout);
    manager.closePane();
    expect(manager.activePaneId).toBe(leaves.at(-2)!.id);
    const focused = manager.getActiveExplorer();
    expect(focused).toBeDefined();
    clock.drain();
    expect(manager.getActiveExplorer()).toBe(focused);
    expect(manager.getAllExplorers()).toHaveLength(63);
  } finally { await manager.dispose(); }
});
