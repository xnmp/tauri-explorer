import { describe, expect, it } from "vitest";
import {
  acceptsDetailLoad,
  closeCommitComparison,
  createCommitComparisonState,
  exitCommitComparison,
  selectComparisonCommit,
  startCommitComparison,
} from "$lib/domain/git-graph-comparison";

const first = { oid: "a", author_time: 20 };
const older = { oid: "b", author_time: 10 };
const newest = { oid: "c", author_time: 30 };

describe("git graph commit comparison transitions (#512)", () => {
  it("starts a pick and normalizes its second commit from older to newer", () => {
    const selected = selectComparisonCommit(createCommitComparisonState(), first, "*");
    const started = startCommitComparison(selected.state, "*");
    const finished = selectComparisonCommit(started.state, older, "*");

    expect(finished.load).toMatchObject({ kind: "comparison", older, newer: first });
    expect(finished.state.selected).toEqual(first);
    expect(finished.state.first).toBeNull();
  });

  it("cancels a pending pick and exits a comparison to the newer normal detail", () => {
    const selected = selectComparisonCommit(createCommitComparisonState(), first, "*");
    const cancelled = exitCommitComparison(startCommitComparison(selected.state, "*").state, "*");
    expect(cancelled.load).toMatchObject({ kind: "normal", commit: first });

    const paired = selectComparisonCommit(startCommitComparison(selected.state, "*").state, newest, "*");
    const exited = exitCommitComparison(paired.state, "*");
    expect(exited.state.comparison).toBeNull();
    expect(exited.load).toMatchObject({ kind: "normal", commit: newest });
  });

  it("rejects a stale comparison response after a close or later selection", () => {
    const selected = selectComparisonCommit(createCommitComparisonState(), first, "*");
    const paired = selectComparisonCommit(startCommitComparison(selected.state, "*").state, older, "*");
    const comparisonLoad = paired.load!;
    expect(acceptsDetailLoad(paired.state, comparisonLoad)).toBe(true);
    expect(acceptsDetailLoad(closeCommitComparison(paired.state).state, comparisonLoad)).toBe(false);
    expect(acceptsDetailLoad(selectComparisonCommit(paired.state, newest, "*").state, comparisonLoad)).toBe(false);
  });
});
