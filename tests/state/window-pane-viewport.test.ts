import { afterEach, expect, it } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
const managers: ReturnType<typeof createWindowTabsManager>[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); });

it("focus follows constrained visible neighbors and viewport changes preserve saved ratios", () => {
  const manager = createWindowTabsManager(); managers.push(manager);
  const leaf = (id: string) => ({ type: "leaf" as const, id, path: "/home/user" });
  const layout = { type: "split" as const, id: "root", direction: "row" as const, ratio: 0.5,
    first: { type: "split" as const, id: "left", direction: "column" as const, ratio: 0.1, first: leaf("a"), second: leaf("b") },
    second: { type: "split" as const, id: "right", direction: "column" as const, ratio: 0.9, first: leaf("c"), second: leaf("d") } };
  manager.restoreFromState({ version: 3, tabs: [{ id: "tab", kind: "explorer", layout, activePaneId: "b" }], activeTabId: "tab" });
  manager.paneViewport.measure(800, 300, 6);
  manager.focusPaneInDirection("right");
  expect(manager.activePaneId).toBe("d");
  manager.paneViewport.measure(1200, 3000, 8);
  manager.setActivePane("b");
  manager.focusPaneInDirection("right");
  expect(manager.activePaneId).toBe("c");
  expect(manager.captureState().tabs[0].layout).toEqual(layout);
});
