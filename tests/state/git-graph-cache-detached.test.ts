/**
 * The detached-HEAD flag survives the graph's data path (#524).
 *
 * The badge must be standing, which means it has to be present on BOTH paints
 * a graph does: the first one driven by the log half of `fetchPage0Snapshot`
 * (before the slow status scan resolves) and the instant one a remount paints
 * from the cached snapshot. A flag that only reaches the view via a fresh
 * fetch would blink out on every tab switch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitLogPage } from "$lib/api/git-log";
import type { GraphSnapshot } from "$lib/state/git-graph-cache";

const gitLogMock = vi.fn<(repoPath: string, options?: unknown) => Promise<GitLogPage>>();

vi.mock("$lib/api/git-log", () => ({
  gitLog: (repoPath: string, options?: unknown) => gitLogMock(repoPath, options),
}));
vi.mock("$lib/state/git-summary-cache", () => ({
  fetchGitSummary: async () => ({ ok: false as const, error: "not a repo" }),
}));

const { fetchPage0Snapshot } = await import("$lib/state/git-graph-cache");

const page = (over: Partial<GitLogPage> = {}): GitLogPage => ({
  commits: [
    {
      oid: "a".repeat(40),
      short_oid: "aaaaaaa",
      parents: [],
      author_name: "A",
      author_email: "a@example.com",
      author_time: 0,
      summary: "root",
    },
  ],
  refs: { ["a".repeat(40)]: [{ name: "HEAD", kind: "Head" }] },
  has_more: false,
  next_cursor: null,
  head_branch: null,
  detached: false,
  ...over,
});

beforeEach(() => {
  gitLogMock.mockReset();
});

describe("fetchPage0Snapshot detached HEAD", () => {
  it("carries a detached HEAD into the snapshot and the first paint", async () => {
    gitLogMock.mockResolvedValue(page({ detached: true, head_branch: null }));
    const paints: Array<Omit<GraphSnapshot, "workingChanges">> = [];

    const snapshot = await fetchPage0Snapshot("/repo", null, (partial) => paints.push(partial));

    expect(paints).toHaveLength(1);
    expect(paints[0].detached).toBe(true);
    expect(snapshot.detached).toBe(true);
    expect(snapshot.headOid).toBe("a".repeat(40));
  });

  it("does not report an unborn branch as detached", async () => {
    // `head_branch` is null on an unborn branch too — the flag has to come
    // from the repository, not from the absence of a branch name.
    gitLogMock.mockResolvedValue(page({ detached: false, head_branch: null }));

    const snapshot = await fetchPage0Snapshot("/repo");

    expect(snapshot.detached).toBe(false);
  });

  it("reports an attached branch as not detached", async () => {
    gitLogMock.mockResolvedValue(page({ detached: false, head_branch: "main" }));

    const snapshot = await fetchPage0Snapshot("/repo");

    expect(snapshot.detached).toBe(false);
    expect(snapshot.headBranch).toBe("main");
  });
});
