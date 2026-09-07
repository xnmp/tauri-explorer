import { expect, it, vi, beforeEach } from "vitest";
const native = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", destroy: native.destroy }) }));
beforeEach(() => { native.destroy.mockReset().mockResolvedValue(undefined); });
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

it("keeps a restored replacement when an older transfer acknowledges the same tab ID", async () => {
  const manager = createWindowTabsManager();
  try {
    manager.createTab("/home/base");
    const moving = manager.createTab("/home/moving");
    const transfer = manager.beginTabTransfer(moving.id)!;
    const restored = manager.captureState();
    manager.restoreFromState(restored);
    expect(transfer.complete()).toBe(false);
    expect(manager.tabs.map((tab) => manager.getTabPath(tab.id))).toEqual(["/home/base", "/home/moving"]);
  } finally { await manager.dispose(); }
});

it("removes the original once after adoption without putting it in closed tabs", async () => {
  const manager = createWindowTabsManager();
  try {
    manager.createTab("/home/base");
    const moving = manager.createTab("/home/moving");
    const transfer = manager.beginTabTransfer(moving.id)!;
    expect(transfer.snapshot.path).toBe("/home/moving");
    expect(manager.tabs).toHaveLength(2);
    expect(transfer.complete()).toBe(true);
    expect(transfer.complete()).toBe(false);
    expect(manager.tabs.map((tab) => manager.getTabPath(tab.id))).toEqual(["/home/base"]);
    expect(manager.canRestoreTab).toBe(false);
  } finally { await manager.dispose(); }
});

it("does not discard source edits made after its transfer snapshot", async () => {
  const manager = createWindowTabsManager();
  try {
    manager.createTab("/home/base");
    const moving = manager.createTab("/home/moving");
    const transfer = manager.beginTabTransfer(moving.id)!;
    manager.splitPane("right");
    expect(transfer.complete()).toBe(false);
    expect(manager.tabs).toHaveLength(2);
    expect(manager.exportTab(moving.id)?.tab?.layout.type).toBe("split");
  } finally { await manager.dispose(); }
});

it("revokes source removal at manager disposal", async () => {
  const manager = createWindowTabsManager();
  manager.createTab("/home/base");
  const moving = manager.createTab("/home/moving");
  const transfer = manager.beginTabTransfer(moving.id)!;
  await manager.dispose();
  expect(transfer.complete()).toBe(false);
});

it("keeps a newly opened tab when transfer completes before native close dispatch", async () => {
  const manager = createWindowTabsManager();
  try {
    const source = manager.createTab("/source");
    expect(manager.beginTabTransfer(source.id)!.complete()).toBe(true);
    expect(manager.tabs).toHaveLength(0);
    manager.createTab("/new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.destroy).not.toHaveBeenCalled();
    expect(manager.getTabPath(manager.tabs[0].id)).toBe("/new");
  } finally { await manager.dispose(); }
});

it("does not accept new ownership after native window close has been dispatched", async () => {
  let finish!: () => void;
  native.destroy.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const manager = createWindowTabsManager();
  try {
    const source = manager.createTab("/source");
    const saved = manager.captureState();
    manager.beginTabTransfer(source.id)!.complete();
    await vi.waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
    expect(() => manager.createTab("/new")).toThrow("closing");
    expect(() => manager.adoptTab({ path: "/adopted" })).toThrow("closing");
    expect(() => manager.restoreFromState(saved)).toThrow("closing");
    expect(manager.tabs).toHaveLength(0);
  } finally { finish?.(); await manager.dispose(); }
});

it("allows new ownership again if native close rejects", async () => {
  let fail!: (error: Error) => void;
  native.destroy.mockImplementation(() => new Promise<void>((_, reject) => { fail = reject; }));
  const manager = createWindowTabsManager();
  try {
    const source = manager.createTab("/source");
    manager.beginTabTransfer(source.id)!.complete();
    await vi.waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
    fail(new Error("compositor refused"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tab = manager.createTab("/recovered");
    expect(manager.getTabPath(tab.id)).toBe("/recovered");
  } finally { await manager.dispose(); }
});

it("reserves one transfer per tab until cancellation or completion", async () => {
  const manager = createWindowTabsManager();
  try {
    const source = manager.createTab("/source");
    const transfer = manager.beginTabTransfer(source.id)!;
    expect(manager.beginTabTransfer(source.id)).toBeNull();
    transfer.cancel();
    const next = manager.beginTabTransfer(source.id)!;
    expect(next).not.toBeNull();
    expect(transfer.complete()).toBe(false);
    next.cancel();
  } finally { await manager.dispose(); }
});

it("preserves closed-tab history when restoration is rejected during native close", async () => {
  let fail!: (error: Error) => void;
  native.destroy.mockImplementation(() => new Promise<void>((_, reject) => { fail = reject; }));
  const manager = createWindowTabsManager();
  try {
    const source = manager.createTab("/source");
    const previous = manager.createTab("/previous");
    manager.closeTab(previous.id);
    manager.beginTabTransfer(source.id)!.complete();
    await vi.waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
    expect(() => manager.restoreClosedTab()).toThrow("closing");
    expect(() => manager.restoreClosedSurface()).toThrow("closing");
    expect(manager.canRestoreTab).toBe(true);
    fail(new Error("native close failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.restoreClosedTab()).toEqual({ restored: true });
    expect(manager.getTabPath(manager.tabs[0].id)).toBe("/previous");
  } finally { await manager.dispose(); }
});
