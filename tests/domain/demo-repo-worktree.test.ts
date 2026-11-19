import { describe, expect, it } from "vitest";
import type { DemoRepo } from "$lib/domain/demo-fixture-git";
import {
  applyDemoPatch,
  binaryBlob,
  commitDemoRepo,
  demoStatus,
  demoUnifiedDiff,
  discardPaths,
  seedIndexState,
  stagePaths,
  statusChanges,
  unstagePaths,
  UNKNOWN_BLOB,
  type DemoTree,
} from "$lib/domain/demo-repo-worktree";

const tree = (entries: Record<string, string>): DemoTree => new Map(Object.entries(entries));
const paths = (list: readonly { path: string }[]) => list.map((e) => e.path);

const WORK = tree({
  "notes.md": "line 1\nline 2 edited\nline 3\n",
  "flags.csv": "a,b\n1,2\n",
  "draft.md": "half written\n",
  "new.py": "print('hi')\n",
});

describe("seedIndexState / demoStatus", () => {
  it("derives HEAD and the index from the fixture's changes", () => {
    const state = seedIndexState(WORK, [
      { path: "notes.md", status: "Modified", base: "line 1\nline 2\nline 3\n" },
      { path: "draft.md", status: "Untracked" },
      { path: "new.py", status: "Added" },
      { path: "gone.txt", status: "Deleted", base: "old\n" },
    ]);
    const status = demoStatus(state, WORK);
    expect(status.staged).toEqual([{ path: "new.py", old_path: null, status: "Added" }]);
    expect(status.changes.map((e) => [e.path, e.status])).toEqual([["gone.txt", "Deleted"], ["notes.md", "Modified"]]);
    expect(paths(status.untracked)).toEqual(["draft.md"]);
  });

  it("lists a change without a base as modified (its committed text is unknown)", () => {
    const state = seedIndexState(WORK, [{ path: "flags.csv", status: "Modified" }]);
    expect(demoStatus(state, WORK).changes).toEqual([{ path: "flags.csv", old_path: null, status: "Modified" }]);
  });

  it("puts a staged fixture change in the index", () => {
    const state = seedIndexState(WORK, [{ path: "flags.csv", status: "Modified", base: "a,b\n", staged: true }]);
    const status = demoStatus(state, WORK);
    expect(paths(status.staged)).toEqual(["flags.csv"]);
    expect(status.changes).toEqual([]);
  });

  it("ignores a fixture change that names no difference", () => {
    const state = seedIndexState(WORK, [{ path: "flags.csv", status: "Modified", base: "a,b\n1,2\n" }, { path: "nope", status: "Added" }]);
    expect(demoStatus(state, WORK)).toEqual({ staged: [], changes: [], untracked: [] });
  });

  it("sees working-tree edits made after seeding", () => {
    const state = seedIndexState(WORK, []);
    const edited = new Map(WORK);
    edited.set("flags.csv", "a,b\n1,3\n");
    edited.delete("draft.md");
    edited.set("fresh.txt", "x");
    const status = demoStatus(state, edited);
    expect(status.changes.map((e) => [e.path, e.status])).toEqual([["draft.md", "Deleted"], ["flags.csv", "Modified"]]);
    expect(paths(status.untracked)).toEqual(["fresh.txt"]);
  });

  it("flattens the status into staged-flagged changes", () => {
    const state = stagePaths(seedIndexState(WORK, [{ path: "draft.md", status: "Untracked" }]), WORK, ["draft.md"]);
    expect(statusChanges(demoStatus(state, WORK))).toEqual([{ path: "draft.md", status: "Added", staged: true }]);
  });
});

describe("stage / unstage", () => {
  const seeded = seedIndexState(WORK, [
    { path: "notes.md", status: "Modified", base: "line 1\nline 2\nline 3\n" },
    { path: "draft.md", status: "Untracked" },
  ]);

  it("moves files between the lists and back", () => {
    const staged = stagePaths(seeded, WORK, ["notes.md", "draft.md"]);
    let status = demoStatus(staged, WORK);
    expect(status.staged.map((e) => [e.path, e.status])).toEqual([["draft.md", "Added"], ["notes.md", "Modified"]]);
    expect(status.changes).toEqual([]);
    expect(status.untracked).toEqual([]);

    status = demoStatus(unstagePaths(staged, ["notes.md", "draft.md"]), WORK);
    expect(status.staged).toEqual([]);
    expect(paths(status.changes)).toEqual(["notes.md"]);
    expect(paths(status.untracked)).toEqual(["draft.md"]);
  });

  it("stages a deletion and a whole folder", () => {
    const work = tree({ "a/x.txt": "1", "a/y.txt": "2" });
    const base = seedIndexState(tree({ "a/x.txt": "1", "a/y.txt": "2", "a/z.txt": "3" }), []);
    const staged = stagePaths(base, work, ["a/"]);
    expect(demoStatus(staged, work).staged).toEqual([{ path: "a/z.txt", old_path: null, status: "Deleted" }]);
  });

  it("does nothing for paths outside the repository's files", () => {
    expect(demoStatus(stagePaths(seeded, WORK, ["missing.md"]), WORK)).toEqual(demoStatus(seeded, WORK));
    expect(demoStatus(stagePaths(seeded, WORK, []), WORK)).toEqual(demoStatus(seeded, WORK));
  });
});

describe("discardPaths", () => {
  const seeded = seedIndexState(WORK, [
    { path: "notes.md", status: "Modified", base: "line 1\nline 2\nline 3\n" },
    { path: "draft.md", status: "Untracked" },
    { path: "flags.csv", status: "Modified" },
  ]);

  it("restores tracked files from HEAD and removes untracked ones", () => {
    const { writes } = discardPaths(seeded, WORK, ["notes.md", "draft.md"], false);
    expect(writes).toEqual([
      { path: "draft.md", text: null },
      { path: "notes.md", text: "line 1\nline 2\nline 3\n" },
    ]);
  });

  it("refuses a staged change unless forced, as the native command does", () => {
    const staged = stagePaths(seeded, WORK, ["notes.md"]);
    expect(() => discardPaths(staged, WORK, ["notes.md"], false)).toThrow(/staged changes/);
    const { state, writes } = discardPaths(staged, WORK, ["notes.md"], true);
    expect(writes).toEqual([{ path: "notes.md", text: "line 1\nline 2\nline 3\n" }]);
    const after = new Map(WORK);
    after.set("notes.md", "line 1\nline 2\nline 3\n");
    expect(demoStatus(state, after).staged).toEqual([]);
  });

  it("accepts the current version when the committed text is unknown", () => {
    const { state, writes } = discardPaths(seeded, WORK, ["flags.csv"], false);
    expect(writes).toEqual([]);
    expect(paths(demoStatus(state, WORK).changes)).toEqual(["notes.md"]);
  });

  it("restores a deleted file", () => {
    const work = new Map(WORK);
    work.delete("notes.md");
    const { writes } = discardPaths(seeded, work, ["notes.md"], false);
    expect(writes).toEqual([{ path: "notes.md", text: "line 1\nline 2\nline 3\n" }]);
  });
});

describe("demoUnifiedDiff", () => {
  it("shows a modification as git does", () => {
    expect(demoUnifiedDiff("notes.md", "line 1\nline 2\nline 3\n", "line 1\nline 2 edited\nline 3\n")).toBe([
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-line 2",
      "+line 2 edited",
      " line 3",
      "",
    ].join("\n"));
  });

  it("splits distant changes into separate hunks with three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    const diff = demoUnifiedDiff("f", before, after);
    expect(diff.match(/^@@.*@@$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  });

  it("marks new and deleted files", () => {
    expect(demoUnifiedDiff("n.txt", undefined, "a\nb\n")).toContain("new file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(demoUnifiedDiff("d.txt", "a\n", undefined)).toContain("deleted file mode 100644\n--- a/d.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n");
  });

  it("notes a missing final newline", () => {
    expect(demoUnifiedDiff("f", "a\n", "a\nb")).toContain("@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n");
  });

  it("is empty when nothing differs", () => {
    expect(demoUnifiedDiff("f", "same\n", "same\n")).toBe("");
  });

  it("reports binary files without hunks", () => {
    expect(demoUnifiedDiff("photo.jpg", binaryBlob(10, "a"), binaryBlob(12, "b"))).toBe(
      "diff --git a/photo.jpg b/photo.jpg\nBinary files a/photo.jpg and b/photo.jpg differ\n",
    );
  });

  it("shows the current text as context when the committed text is unknown", () => {
    expect(demoUnifiedDiff("f", UNKNOWN_BLOB, "a\nb\n")).toContain("@@ -1,2 +1,2 @@\n a\n b\n");
  });

  it("handles a large rewrite without the quadratic table", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
    const diff = demoUnifiedDiff("big", before, after);
    expect(diff.split("\n").filter((l) => l.startsWith("-old")).length).toBe(3000);
    expect(diff.split("\n").filter((l) => l.startsWith("+new")).length).toBe(3000);
  });
});

describe("applyDemoPatch", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const after = before.replace("l2\n", "L2\n").replace("l18\n", "L18\nextra\n");
  const diff = demoUnifiedDiff("f", before, after);
  const [head, first, second] = diff.split(/(?=^@@)/m);

  it("applies all hunks forward and reverses them", () => {
    expect(applyDemoPatch(before, diff, false)).toBe(after);
    expect(applyDemoPatch(after, diff, true)).toBe(before);
  });

  it("applies one hunk at a time, in either order", () => {
    expect(applyDemoPatch(before, head + second, false)).toBe(before.replace("l18\n", "L18\nextra\n"));
    const once = applyDemoPatch(before, head + second, false);
    expect(applyDemoPatch(once, head + first, false)).toBe(after);
  });

  it("round-trips new files and missing final newlines", () => {
    const created = demoUnifiedDiff("n", undefined, "a\nb");
    expect(applyDemoPatch("", created, false)).toBe("a\nb");
    const noEol = demoUnifiedDiff("n", "a\nb", "a\nb\nc\n");
    expect(applyDemoPatch("a\nb", noEol, false)).toBe("a\nb\nc\n");
    expect(applyDemoPatch("a\nb\nc\n", noEol, true)).toBe("a\nb");
  });

  it("refuses a patch that does not match", () => {
    expect(() => applyDemoPatch("unrelated\n", diff, false)).toThrow(/does not apply/);
    expect(() => applyDemoPatch(before, "not a patch", false)).toThrow(/no hunks/);
  });
});

describe("commitDemoRepo", () => {
  const repo: DemoRepo = {
    root: "/r",
    branch: "main",
    head: "a".repeat(40),
    commits: [{
      oid: "a".repeat(40), short_oid: "aaaaaaa", parents: [], author_name: "Tamsin", author_email: "t@example.invalid",
      author_time: 100, summary: "first", message: "first", files: [],
    }],
    refs: { ["a".repeat(40)]: [{ name: "HEAD", kind: "Head" }, { name: "main", kind: "LocalBranch" }, { name: "v1", kind: "Tag" }] },
    changes: [],
  };
  const seeded = seedIndexState(WORK, [
    { path: "notes.md", status: "Modified", base: "line 1\nline 2\nline 3\n" },
    { path: "draft.md", status: "Untracked" },
  ]);

  it("commits the index on the current branch and clears the staged list", () => {
    const staged = stagePaths(seeded, WORK, ["notes.md"]);
    const { repo: next, state, commit } = commitDemoRepo(repo, staged, { message: "Tidy notes\n\nbody", amend: false, now: 5_000_000 });
    expect(next.head).toBe(commit.oid);
    expect(next.commits[0]).toBe(commit);
    expect(commit.parents).toEqual([repo.head]);
    expect(commit.summary).toBe("Tidy notes");
    expect(commit.author_name).toBe("Tamsin");
    expect(commit.author_time).toBe(5000);
    expect(commit.files.map((f) => [f.path, f.status])).toEqual([["notes.md", "M"]]);
    expect(commit.files[0].diff).toContain("+line 2 edited");
    expect(next.refs[commit.oid]).toEqual([{ name: "HEAD", kind: "Head" }, { name: "main", kind: "LocalBranch" }]);
    expect(next.refs[repo.head!]).toEqual([{ name: "v1", kind: "Tag" }]);
    const after = demoStatus(state, WORK);
    expect(after.staged).toEqual([]);
    expect(after.changes).toEqual([]);
  });

  it("leaves unstaged edits in the working tree", () => {
    const { state } = commitDemoRepo(repo, stagePaths(seeded, WORK, ["draft.md"]), { message: "m", amend: false, now: 0 });
    expect(paths(demoStatus(state, WORK).changes)).toEqual(["notes.md"]);
  });

  it("refuses an empty message or an empty index", () => {
    const staged = stagePaths(seeded, WORK, ["notes.md"]);
    expect(() => commitDemoRepo(repo, staged, { message: "   ", amend: false, now: 0 })).toThrow(/message cannot be empty/);
    expect(() => commitDemoRepo(repo, seeded, { message: "m", amend: false, now: 0 })).toThrow(/nothing to commit/);
  });

  it("amends HEAD's commit in place of the old one", () => {
    const first = commitDemoRepo(repo, stagePaths(seeded, WORK, ["notes.md"]), { message: "one", amend: false, now: 1000 });
    const amended = commitDemoRepo(first.repo, stagePaths(first.state, WORK, ["draft.md"]), { message: "", amend: true, now: 2000 });
    expect(amended.repo.commits.map((c) => c.summary)).toEqual(["one", "first"]);
    expect(amended.commit.parents).toEqual([repo.head]);
    expect(amended.commit.files.map((f) => f.path).sort()).toEqual(["draft.md", "notes.md"]);
  });
});
