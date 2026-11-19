import { describe, expect, it } from "vitest";
import { compareDemoCommits, convertDemoRepo, demoLogHistory, demoMergeBase, expandOid, queryDemoLog } from "$lib/domain/demo-fixture-git";

const NOW = Date.UTC(2026, 9, 18);
const raw = {
  branch: "main",
  changes: [{ path: "notes.md", status: "Modified" }, { path: "new.txt", status: "Untracked" }],
  commits: [
    { hash: "e5e5e5e", msg: "Merge branch 'explore'", author: "Ines", date: "2026-10-05T00:00:00Z", parents: ["d4d4d4d", "c3c3c3c"], refs: ["HEAD -> main", "origin/main", "tag: v1.0"] },
    { hash: "d4d4d4d", msg: "Count 4 Oct", author: "Ines", date: "2026-10-04T00:00:00Z", parents: ["b2b2b2b"], files: [{ path: "counts.csv", status: "M", diff: "@@ -1 +1,2 @@\n a\n+b" }] },
    { hash: "c3c3c3c", msg: "Plot north pool\n\nLonger body.", author: "Ines", date: "2026-10-03T00:00:00Z", parents: ["b2b2b2b"], refs: ["explore"], files: [{ path: "plot.R", status: "A", diff: "@@ -0,0 +1 @@\n+plot()" }] },
    { hash: "b2b2b2b", msg: "Second", author: "Tomas", date: "2026-10-02T00:00:00Z", parents: ["a1a1a1a"], files: [{ path: "counts.csv", status: "A" }] },
    { hash: "a1a1a1a", msg: "Initial", author: "Ines", date: "2026-10-01T00:00:00Z", parents: [] },
  ],
};

function repo() {
  const warnings: string[] = [];
  const converted = convertDemoRepo("/r", raw, NOW, (m) => warnings.push(m))!;
  return { repo: converted, warnings };
}

describe("expandOid", () => {
  it("keeps the fixture hash as the prefix of a stable 40-hex id", () => {
    const oid = expandOid("abc1234");
    expect(oid).toMatch(/^abc1234[0-9a-f]{33}$/);
    expect(expandOid("abc1234")).toBe(oid);
    expect(expandOid("not hex!")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("convertDemoRepo", () => {
  it("converts commits, merges with two parents, refs and working changes", () => {
    const { repo: r, warnings } = repo();
    expect(warnings).toEqual([]);
    expect(r.branch).toBe("main");
    const merge = r.commits[0];
    expect(merge.parents).toHaveLength(2);
    expect(merge.summary).toBe("Merge branch 'explore'");
    expect(r.refs[merge.oid]).toEqual(expect.arrayContaining([
      { name: "HEAD", kind: "Head" }, { name: "main", kind: "LocalBranch" },
      { name: "origin/main", kind: "RemoteBranch" }, { name: "v1.0", kind: "Tag" },
    ]));
    expect(r.head).toBe(merge.oid);
    expect(r.changes).toEqual([{ path: "notes.md", status: "Modified" }, { path: "new.txt", status: "Untracked" }]);
    const plot = r.commits.find((c) => c.summary === "Plot north pool")!;
    expect(plot.message).toBe("Plot north pool\n\nLonger body.");
    expect(plot.files[0].diff).toMatch(/^diff --git a\/plot.R b\/plot.R\n/);
  });

  it("drops duplicate commits and unknown parents with warnings", () => {
    const warnings: string[] = [];
    const r = convertDemoRepo("/r", { commits: [
      { hash: "aa", msg: "x", parents: ["zz"] }, { hash: "aa", msg: "dup" }, null, { msg: "no hash" },
    ] }, NOW, (m) => warnings.push(m))!;
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].parents).toEqual([]);
    expect(warnings.some((w) => /duplicate/.test(w))).toBe(true);
    expect(warnings.some((w) => /unknown parent/.test(w))).toBe(true);
  });

  it("accepts a repository without commits", () => {
    const r = convertDemoRepo("/r", {}, NOW, () => {});
    expect(r?.commits ?? []).toEqual([]);
  });
});

describe("queryDemoLog", () => {
  it("pages newest first and continues from its cursor", () => {
    const { repo: r } = repo();
    const first = queryDemoLog(r, { skip: 0, limit: 2 });
    expect(first.commits.map((c) => c.summary)).toEqual(["Merge branch 'explore'", "Count 4 Oct"]);
    expect(first.has_more).toBe(true);
    const next = queryDemoLog(r, { skip: 2, limit: 10, cursor: first.next_cursor ?? undefined });
    expect(next.commits.map((c) => c.summary)).toEqual(["Plot north pool", "Second", "Initial"]);
    expect(next.has_more).toBe(false);
  });

  it("filters by branch reachability and by file", () => {
    const { repo: r } = repo();
    expect(queryDemoLog(r, { skip: 0, limit: 10, branches: ["explore"] }).commits.map((c) => c.summary))
      .toEqual(["Plot north pool", "Second", "Initial"]);
    expect(queryDemoLog(r, { skip: 0, limit: 10, file_path: "counts.csv" }).commits.map((c) => c.summary))
      .toEqual(["Count 4 Oct", "Second"]);
  });

  it("reports a cursor that no longer matches", () => {
    const { repo: r } = repo();
    expect(queryDemoLog(r, { skip: 1, limit: 1, cursor: "bogus" }).staleCursor).toBe(true);
  });
});

describe("comparison and merge base", () => {
  it("finds the fork point of two branches", () => {
    const { repo: r } = repo();
    const [, count, plot, second] = r.commits;
    expect(demoMergeBase(r, count.oid, plot.oid)).toBe(second.oid);
  });

  it("lists files changed between two commits", () => {
    const { repo: r } = repo();
    const [merge, , , , initial] = r.commits;
    const paths = compareDemoCommits(r, initial.oid, merge.oid).map((f) => f.path).sort();
    expect(paths).toEqual(["counts.csv", "plot.R"]);
  });

  it("keeps an unmerged branch out of HEAD's history but in the graph's", () => {
    const open = convertDemoRepo("/r", { ...raw, commits: [
      { hash: "f6f6f6f", msg: "Unmerged idea", author: "Ines", date: "2026-10-06T00:00:00Z", parents: ["d4d4d4d"], refs: ["idea"] },
      ...raw.commits,
    ] }, NOW, () => {})!;
    const summaries = (commits: readonly { summary: string }[]) => commits.map((c) => c.summary);
    expect(summaries(demoLogHistory(open))).toEqual(["Merge branch 'explore'", "Count 4 Oct", "Plot north pool", "Second", "Initial"]);
    expect(summaries(demoLogHistory(open, true))[0]).toBe("Unmerged idea");
    // The graph's log (no branch filter) shows every branch, and the open
    // branch is its own ref beside the merged one.
    expect(queryDemoLog(open, {}).commits).toHaveLength(6);
    expect(Object.values(open.refs).flat().filter((r) => r.kind === "LocalBranch").map((r) => r.name).sort())
      .toEqual(["explore", "idea", "main"]);
  });
});
