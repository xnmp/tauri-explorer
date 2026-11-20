import { describe, expect, it } from "vitest";
import {
  acceptsDetailLoad,
  closeDetailSelection,
  createDetailSelection,
  selectDetailCommit,
} from "$lib/domain/git-graph-selection";

const first = { oid: "a" };
const second = { oid: "b" };

describe("git graph detail selection transitions", () => {
  it("selects a commit and asks for its detail load", () => {
    const selected = selectDetailCommit(createDetailSelection(), first);
    expect(selected.state.selected).toEqual(first);
    expect(selected.load).toMatchObject({ commit: first, generation: selected.state.generation });
    expect(acceptsDetailLoad(selected.state, selected.load!)).toBe(true);
  });

  it("closes when the open commit is selected again", () => {
    const selected = selectDetailCommit(createDetailSelection(), first);
    const toggled = selectDetailCommit(selected.state, first);
    expect(toggled.state.selected).toBeNull();
    expect(toggled.load).toBeNull();
  });

  it("advances the generation on every transition", () => {
    const selected = selectDetailCommit(createDetailSelection(), first);
    const replaced = selectDetailCommit(selected.state, second);
    const closed = closeDetailSelection(replaced.state);
    expect(replaced.state.generation).toBeGreaterThan(selected.state.generation);
    expect(closed.generation).toBeGreaterThan(replaced.state.generation);
  });

  it("rejects a stale load after a close or later selection", () => {
    const selected = selectDetailCommit(createDetailSelection(), first);
    const load = selected.load!;
    expect(acceptsDetailLoad(closeDetailSelection(selected.state), load)).toBe(false);
    expect(acceptsDetailLoad(selectDetailCommit(selected.state, second).state, load)).toBe(false);
  });

  it("rejects a load from an earlier selection of the same commit after close and reopen", () => {
    const selected = selectDetailCommit(createDetailSelection(), first);
    const reopened = selectDetailCommit(closeDetailSelection(selected.state), first);
    expect(reopened.state.selected).toEqual(first);
    expect(acceptsDetailLoad(reopened.state, selected.load!)).toBe(false);
    expect(acceptsDetailLoad(reopened.state, reopened.load!)).toBe(true);
  });
});
