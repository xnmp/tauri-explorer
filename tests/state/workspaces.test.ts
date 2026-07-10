/**
 * Tests for the workspaces store (#228): saving named tab layouts,
 * update-on-same-name, rename/delete, and persistence. The palette's
 * "Workspaces: Open..." picker (#229) reads the list at open time.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { workspacesStore } from "$lib/state/workspaces.svelte";
import type { PersistedTabState } from "$lib/state/window-tabs-persistence";

function sampleState(path = "/home/a"): PersistedTabState {
  return {
    version: 3,
    tabs: [
      {
        id: "t1",
        kind: "explorer",
        layout: { type: "leaf", id: "p1", path },
        activePaneId: "p1",
      },
    ],
    activeTabId: "t1",
  };
}

beforeEach(() => {
  // The store is a module singleton — clear it through its own API.
  for (const ws of [...workspacesStore.list]) {
    workspacesStore.remove(ws.id);
  }
});

describe("workspacesStore", () => {
  it("saves a named workspace and lists it", () => {
    const ws = workspacesStore.save("Research", sampleState());
    expect(workspacesStore.count).toBe(1);
    expect(workspacesStore.get(ws.id)?.name).toBe("Research");
    expect(workspacesStore.get(ws.id)?.state.tabs).toHaveLength(1);
  });

  it("saving the same name updates the existing workspace", () => {
    const first = workspacesStore.save("Same", sampleState("/home/a"));
    const second = workspacesStore.save("Same", sampleState("/srv/b"));

    expect(second.id).toBe(first.id);
    expect(workspacesStore.count).toBe(1);
    const tab = workspacesStore.get(first.id)!.state.tabs[0];
    expect(tab.kind === "explorer" && tab.layout.type === "leaf" && tab.layout.path).toBe("/srv/b");
  });

  it("rename and remove work", () => {
    const ws = workspacesStore.save("Old", sampleState());
    workspacesStore.rename(ws.id, "New");
    expect(workspacesStore.get(ws.id)?.name).toBe("New");

    workspacesStore.remove(ws.id);
    expect(workspacesStore.count).toBe(0);
  });

  it("persists across store reloads via localStorage", () => {
    workspacesStore.save("Persisted", sampleState());
    const raw = localStorage.getItem("explorer-workspaces");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0].name).toBe("Persisted");
  });
});
