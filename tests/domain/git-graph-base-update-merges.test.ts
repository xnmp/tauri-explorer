import { describe, expect, it } from "vitest";
import {
  baseUpdateMergeOids,
  shouldMuteBaseUpdateMerge,
  type GraphCommitLike,
  type OpenPrBaseLike,
} from "$lib/domain/git-graph";

const c = (oid: string, ...parents: string[]): GraphCommitLike => ({ oid, parents });

describe("baseUpdateMergeOids (#527)", () => {
  const commits = [
    c("featureTip", "baseUpdate", "unrelatedMerge"),
    c("baseUpdate", "featureWork", "originMainTip"),
    c("unrelatedMerge", "featureWork", "sideTip"),
    c("featureWork", "shared"),
    c("sideTip", "shared"),
    c("originMainTip", "localMainTip"),
    c("localMainTip", "shared"),
    c("shared"),
  ];
  const refs = {
    featureTip: [{ kind: "LocalBranch", name: "feature" }],
    localMainTip: [{ kind: "LocalBranch", name: "main" }],
    originMainTip: [{ kind: "RemoteBranch", name: "origin/main" }],
  } as const;

  it("uses the selected remote base when local main is stale", () => {
    const prs: OpenPrBaseLike[] = [
      { number: 42, headRef: "feature", baseRef: "main", baseRemote: "origin" },
    ];

    expect(baseUpdateMergeOids(commits, refs, prs)).toEqual(new Set(["baseUpdate"]));
  });

  it("does not classify an unrelated merge and obeys the independent mute preference", () => {
    const prs: OpenPrBaseLike[] = [
      { number: 42, headRef: "feature", baseRef: "main", baseRemote: "origin" },
    ];
    const baseUpdates = baseUpdateMergeOids(commits, refs, prs);

    expect(shouldMuteBaseUpdateMerge("baseUpdate", baseUpdates, true)).toBe(true);
    expect(shouldMuteBaseUpdateMerge("unrelatedMerge", baseUpdates, true)).toBe(false);
    expect(shouldMuteBaseUpdateMerge("baseUpdate", baseUpdates, false)).toBe(false);
  });
});
