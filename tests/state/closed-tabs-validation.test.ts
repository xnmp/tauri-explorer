import { afterEach, expect, it } from "vitest";
import { createClosedTabsStore } from "$lib/state/closed-tabs";
import { normalizeClosedSnapshot } from "$lib/state/window-tabs-persistence";

afterEach(() => localStorage.removeItem("explorer-closed-tabs"));

it("tolerates a malformed persisted stack and restores the newest bounded history", () => {
  localStorage.setItem("explorer-closed-tabs", "{}");
  expect(createClosedTabsStore().size).toBe(0);
  localStorage.setItem("explorer-closed-tabs", JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ path: `/tab/${i}` }))));
  const store = createClosedTabsStore();
  expect(store.size).toBe(20);
  expect(store.pop()?.path).toBe("/tab/999");
});

it("normalizes restore metadata and rejects a malformed legacy target", () => {
  expect(normalizeClosedSnapshot({ leftPath: "/left", rightPath: {}, activePaneId: "right", closedAt: Infinity }))
    .toMatchObject({ path: "/left", closedAt: 0 });
  expect(normalizeClosedSnapshot({ path: "/valid", closedAt: -1, closedTs: NaN, kind: {} }))
    .toEqual({ path: "/valid", closedAt: 0, fromClosedWindow: false });
});
