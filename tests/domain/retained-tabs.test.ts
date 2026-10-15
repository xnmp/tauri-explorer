/**
 * Retained tab mounts (#1173): recently active tabs keep their pane tree so a
 * switch back only toggles visibility, without reordering mounted subtrees.
 */
import { describe, expect, it } from "vitest";
import { emptyRetainedTabs, retainTabs, RETAINED_TAB_CAPACITY, type RetainedTabs } from "$lib/domain/retained-tabs";

const all = () => true;

function visit(keys: string[], capacity = 3, live: (key: string) => boolean = all): RetainedTabs<string> {
  return keys.reduce((state, key) => retainTabs(state, key, live, capacity), emptyRetainedTabs<string>());
}

describe("retainTabs", () => {
  it("mounts each newly active tab after the ones already mounted", () => {
    expect(visit(["a", "b", "c"]).mounted).toEqual(["a", "b", "c"]);
  });

  it("keeps the render order stable when switching back to a retained tab", () => {
    const state = visit(["a", "b", "c", "a", "b"]);
    expect(state.mounted).toEqual(["a", "b", "c"]);
    expect(state.recent).toEqual(["b", "a", "c"]);
  });

  it("evicts the least recently active tab beyond capacity", () => {
    const state = visit(["a", "b", "c", "a", "d"]);
    expect(state.recent).toEqual(["d", "a", "c"]);
    expect(state.mounted).toEqual(["a", "c", "d"]);
  });

  it("drops closed tabs and never retains one that is no longer live", () => {
    const state = visit(["a", "b", "c"]);
    const next = retainTabs(state, "c", (key) => key !== "b", 3);
    expect(next.mounted).toEqual(["a", "c"]);
    expect(next.recent).toEqual(["c", "a"]);
  });

  it("keeps the active tab mounted even at capacity one", () => {
    expect(visit(["a", "b"], 1).mounted).toEqual(["b"]);
    expect(visit(["a", "b"], 0).mounted).toEqual(["b"]);
  });

  it("is idempotent for an unchanged active tab", () => {
    const state = visit(["a", "b"]);
    expect(retainTabs(state, "b", all, 3)).toEqual(state);
  });

  it("retains nothing new without an active tab", () => {
    const state = retainTabs(visit(["a", "b"]), null, (key) => key === "a", 3);
    expect(state.mounted).toEqual(["a"]);
  });

  it("bounds the default capacity", () => {
    const keys = Array.from({ length: RETAINED_TAB_CAPACITY + 3 }, (_, i) => `t${i}`);
    const state = keys.reduce((s, key) => retainTabs(s, key, all), emptyRetainedTabs<string>());
    expect(state.mounted).toHaveLength(RETAINED_TAB_CAPACITY);
    expect(state.mounted.at(-1)).toBe(keys.at(-1));
  });
});
