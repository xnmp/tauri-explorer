/**
 * Snapshot-cache keying for the bulk "hide remote-only branches" toggle
 * (#515): the toggle changes what the walk seeds from, so a remount must
 * never paint the other variant's rows (#416).
 */
import { describe, it, expect } from "vitest";
import { snapshotKey } from "$lib/state/git-graph-cache";

describe("snapshotKey with the hide-remote-only toggle", () => {
  const repo = "/home/user/project";

  it("keys distinctly on the toggle", () => {
    expect(snapshotKey(repo, null, false, true)).not.toBe(snapshotKey(repo, null, false, false));
    expect(snapshotKey(repo, ["main"], false, true)).not.toBe(snapshotKey(repo, ["main"], false));
    expect(snapshotKey(repo, null, false, true)).toBe(snapshotKey(repo, null, false, true));
  });

  it("stays orthogonal to the local-only axis", () => {
    expect(snapshotKey(repo, null, true, true)).not.toBe(snapshotKey(repo, null, true, false));
    expect(snapshotKey(repo, null, true, true)).not.toBe(snapshotKey(repo, null, false, true));
  });
});
