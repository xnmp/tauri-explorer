import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkspaces } from "$lib/state/workspaces.svelte";

const leaf = (id = "pane") => ({ type: "leaf", id, path: "/home/user" });
const state = (layout: unknown = leaf()) => ({
  version: 3,
  tabs: [{ id: "tab", kind: "explorer", layout, activePaneId: "pane" }],
  activeTabId: "tab",
});
const workspace = (overrides: Record<string, unknown> = {}) => ({
  id: "ws-1",
  name: "Workspace",
  createdAt: 1,
  updatedAt: 2,
  state: state(),
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("workspace persisted input", () => {
  it.each([{}, null, "wrong", 42])("loads malformed root %j as an empty store", async (value) => {
    localStorage.setItem("explorer-workspaces", JSON.stringify(value));
    const { workspacesStore } = await import("$lib/state/workspaces.svelte");
    expect(workspacesStore.list).toEqual([]);
    expect(workspacesStore.count).toBe(0);
  });

  it("keeps valid workspaces and discards malformed metadata or state", () => {
    const decoded = normalizeWorkspaces([
      workspace(),
      workspace({ id: "bad-name", name: null }),
      workspace({ id: "bad-time", createdAt: "yesterday" }),
      workspace({ id: "bad-state", state: [] }),
    ]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ id: "ws-1", name: "Workspace" });
  });

  it("rejects layouts deeper than the canonical tab-state limit", () => {
    let layout: unknown = leaf();
    for (let depth = 0; depth < 70; depth++) {
      layout = {
        type: "split",
        id: `split-${depth}`,
        direction: "row",
        ratio: 0.5,
        first: layout,
        second: leaf(`sibling-${depth}`),
      };
    }
    expect(normalizeWorkspaces([workspace({ state: state(layout) })])).toEqual([]);
  });

  it("bounds huge workspace and tab arrays before canonical normalization", () => {
    const manyWorkspaces = Array.from({ length: 10_000 }, (_, index) =>
      workspace({ id: `ws-${index}` }),
    );
    expect(normalizeWorkspaces(manyWorkspaces)).toHaveLength(20);

    const hugeState = { ...state(), tabs: Array.from({ length: 4097 }, (_, index) => ({
      id: `tab-${index}`,
      kind: "explorer",
      layout: leaf(`pane-${index}`),
      activePaneId: `pane-${index}`,
    })) };
    expect(normalizeWorkspaces([workspace({ state: hugeState })])).toEqual([]);
  });

  it("applies one aggregate layout budget across the workspace list", () => {
    const tabs = Array.from({ length: 3000 }, (_, index) => ({
      id: `tab-${index}`,
      kind: "explorer",
      layout: leaf(`pane-${index}`),
      activePaneId: `pane-${index}`,
    }));
    const largeState = { version: 3, tabs, activeTabId: "tab-0" };
    const decoded = normalizeWorkspaces([
      workspace({ id: "first", state: largeState }),
      workspace({ id: "second", state: largeState }),
    ]);
    expect(decoded.map(({ id }) => id)).toEqual(["first"]);
  });

  it("drops duplicate workspace ids so actions remain unambiguous", () => {
    expect(normalizeWorkspaces([workspace(), workspace({ name: "Duplicate" })])).toHaveLength(1);
  });
});
