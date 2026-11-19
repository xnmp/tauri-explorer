import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mockInvoke } from "$lib/api/mock-invoke";
import { emitMockTerminal, listenMockTerminal, setMockTerminalBackend, type MockTerminalBackend } from "$lib/api/mock-terminal";
import { installMockWorld, type InstalledMockWorld } from "$lib/api/mock-world";
import { getMockFixtureRepos, withFixtureRepos } from "$lib/api/mock-git-fixture";
import { subscribeGitChanges, type GitChange } from "$lib/state/git-refresh";
import { mockTrashCount } from "$lib/api/mock-files";
import { onMockFsChange, type MockFsChange } from "$lib/api/mock-fs-changes";
import { convertDemoFixture } from "$lib/domain/demo-fixture";

const NOW = Date.UTC(2026, 9, 18);

type LogPage = { commits: Array<{ summary: string; parents: string[] }>; has_more: boolean };

describe("mock terminal channel", () => {
  afterEach(() => setMockTerminalBackend(null));

  it("starts a silent terminal when no shell is installed", async () => {
    const id = await mockInvoke<number>("terminal_reserve_id");
    expect(await mockInvoke("terminal_spawn", { id, cwd: "/", cols: 80, rows: 24 })).toMatchObject({ shellKind: "posix" });
    expect(await mockInvoke("terminal_write", { id, seq: 0, data: "ls\r" })).toEqual({ droppedBytes: 0 });
    expect(await mockInvoke("terminal_status", { id })).toEqual({ busy: false, cwd: null });
  });

  it("delivers input to the installed shell in seq order, once", async () => {
    const writes: string[] = [];
    const backend: MockTerminalBackend = {
      spawn: () => {}, resize: () => {}, kill: () => {},
      write: (_id, data) => writes.push(data),
      status: () => ({ busy: true, cwd: "/x" }),
    };
    setMockTerminalBackend(backend);
    const id = await mockInvoke<number>("terminal_reserve_id");
    await mockInvoke("terminal_spawn", { id, cwd: "/", cols: 80, rows: 24 });
    await mockInvoke("terminal_write", { id, seq: 1, data: "b" });
    expect(writes).toEqual([]);
    await mockInvoke("terminal_write", { id, seq: 0, data: "a" });
    await mockInvoke("terminal_write", { id, seq: 0, data: "a-again" });
    await mockInvoke("terminal_write", { id, seq: 2, data: "c" });
    expect(writes).toEqual(["a", "b", "c"]);
    expect(await mockInvoke("terminal_status", { id })).toEqual({ busy: true, cwd: "/x" });
  });

  it("routes output only to that terminal's listeners until unsubscribed", () => {
    const seen: string[] = [];
    const stop = listenMockTerminal<string>("output", 7, (text) => seen.push(text));
    emitMockTerminal("output", 7, "one");
    emitMockTerminal("output", 8, "other");
    emitMockTerminal("cwd", 7, "/tmp");
    stop();
    emitMockTerminal("output", 7, "late");
    expect(seen).toEqual(["one"]);
  });
});

const FIXTURE = {
  title: "Marsh",
  users: [{ id: "ines", home: "/home/ines" }],
  tree: { kids: [{ name: "home", kids: [{ name: "ines", kids: [
    { name: "notes.md", text: "dawn count" },
    { name: "crane.webp", src: "http://assets.test/crane.webp" },
    { name: "Field", kids: [{ name: "day", kids: [{ name: "count.txt", text: "12 cranes" }] }, { name: "heron.webp", src: "http://assets.test/heron.webp" }] },
    { name: "Archive", kids: [] },
    { name: "repo", kids: [{ name: "a.txt", text: "a" }] },
  ] }] }] },
  trash: [{ from: "/home/ines", node: { name: "old.txt", text: "gone" } }],
  repos: { "/home/ines/repo": {
    branch: "main",
    changes: [{ path: "a.txt", status: "Modified", base: "x\n" }],
    commits: [
      { hash: "c3", msg: "Merge", parents: ["b2", "a1"], refs: ["HEAD -> main"] },
      { hash: "b2", msg: "Side", parents: ["a1"], files: [{ path: "a.txt", status: "M", diff: "@@ -1 +1 @@\n-x\n+a" }] },
      { hash: "a1", msg: "Root", parents: [] },
    ],
  } },
};

type Summary = { undoId: number | null; redoId: number | null };
/** Undo the latest file-history entry through the same command the app uses. */
async function undoLast(history: Summary): Promise<void> {
  await mockInvoke("file_history_execute", { direction: "undo", expectedEntryId: history.undoId });
}

describe("fixture world in the mock backend", () => {
  let installed: InstalledMockWorld | null = null;
  const changes: MockFsChange[] = [];
  let stopListening: () => void = () => {};
  const install = () => {
    installed = installMockWorld(convertDemoFixture(FIXTURE, { now: NOW }));
    changes.length = 0;
    stopListening = onMockFsChange((change) => changes.push(change));
    return installed;
  };
  afterEach(() => {
    stopListening();
    installed?.uninstall();
    installed = null;
  });

  it("leaves the built-in repository answering while no fixture repository is installed", async () => {
    const page = await mockInvoke<LogPage>("git_log", { repoPath: "/home/user/Documents/project", options: { skip: 0, limit: 5 } });
    expect(page.commits.length).toBeGreaterThan(0);
  });

  it("serves listings, text, home, trash and per-repository history from the fixture", async () => {
    const { media } = install();

    expect(await mockInvoke("get_home_directory")).toBe("/home/ines");
    const listing = await mockInvoke<ArrayBuffer>("list_directory", { path: "/home/ines" });
    expect(new TextDecoder().decode(listing)).toContain("notes.md");
    expect(await mockInvoke("read_text_file", { path: "/home/ines/notes.md" })).toBe("dawn count");
    expect(media.get("/home/ines/crane.webp")).toMatchObject({ kind: "image", src: "http://assets.test/crane.webp" });

    const trash = await mockInvoke<{ entries: Array<{ id: string; originalPath: string }> }>("list_trash");
    expect(trash.entries.map((e) => e.originalPath)).toEqual(["/home/ines/old.txt"]);
    await mockInvoke("restore_trash_items", { ids: [trash.entries[0].id] });
    expect(await mockInvoke("read_text_file", { path: "/home/ines/old.txt" })).toBe("gone");

    expect(await mockInvoke("git_repo_root", { path: "/home/ines/repo" })).toBe("/home/ines/repo");
    const page = await mockInvoke<LogPage>("git_log", { repoPath: "/home/ines/repo", options: { skip: 0, limit: 10 } });
    expect(page.commits.map((c) => c.summary)).toEqual(["Merge", "Side", "Root"]);
    expect(page.commits[0].parents).toHaveLength(2);
    expect(await mockInvoke("get_git_status", { path: "/home/ines/repo" })).toMatchObject({ is_git_repo: true, statuses: { "a.txt": expect.any(String) } });
  });

  it("has no repository outside the fixture's, so the graph command reports none there", async () => {
    install();
    // ExplorerPane's "Could not load Git history" is only its failed lazy
    // import; outside a repository `git.showGraph` toasts instead, as natively.
    expect(await mockInvoke("git_repo_root", { path: "/home/ines" })).toBeNull();
    expect(await mockInvoke("git_repo_root", { path: "/home/ines/repo/sub" })).toBe("/home/ines/repo");
  });

  it("uninstalling restores the built-in fixtures", async () => {
    install();
    installed!.uninstall();
    installed = null;
    expect(await mockInvoke("get_home_directory")).toBe("/home/user");
    expect(new TextDecoder().decode(await mockInvoke<ArrayBuffer>("list_directory", { path: "/home/user/Documents" }))).toContain("notes.md");
    await expect(mockInvoke("list_directory", { path: "/home/ines" })).rejects.toThrow(/not found/i);
    const page = await mockInvoke<LogPage>("git_log", { repoPath: "/home/user/Documents/project", options: { skip: 0, limit: 5 } });
    expect(page.commits.length).toBeGreaterThan(0);
  });

  describe("every filesystem change is observed, including undo (review B)", () => {
    it("media and fs-change follow a rename and its undo", async () => {
      const { media } = install();
      const renamed = await mockInvoke<{ history: Summary }>("rename_entry", { path: "/home/ines/crane.webp", newName: "egret.webp" });
      expect(media.get("/home/ines/egret.webp")).toMatchObject({ kind: "image" });
      await undoLast(renamed.history);
      expect(media.get("/home/ines/crane.webp")).toMatchObject({ kind: "image", src: "http://assets.test/crane.webp" });
      expect(media.get("/home/ines/egret.webp")).toBeUndefined();
      expect(changes).toEqual([
        { op: "rename", path: "/home/ines/egret.webp", from: "/home/ines/crane.webp" },
        { op: "rename", path: "/home/ines/crane.webp", from: "/home/ines/egret.webp" },
      ]);
    });

    it("moving a folder carries its child listings, text and media, and undo brings them back", async () => {
      const { media } = install();
      const moved = await mockInvoke<{ history: Summary }>("move_entries", {
        request: { requestId: "r1", sources: ["/home/ines/Field"], destDir: "/home/ines/Archive" }, events: () => {},
      });
      expect(new TextDecoder().decode(await mockInvoke<ArrayBuffer>("list_directory", { path: "/home/ines/Archive/Field/day" }))).toContain("count.txt");
      expect(await mockInvoke("read_text_file", { path: "/home/ines/Archive/Field/day/count.txt" })).toBe("12 cranes");
      expect(media.get("/home/ines/Archive/Field/heron.webp")).toMatchObject({ kind: "image" });
      await undoLast(moved.history);
      expect(await mockInvoke("read_text_file", { path: "/home/ines/Field/day/count.txt" })).toBe("12 cranes");
      expect(media.get("/home/ines/Field/heron.webp")).toMatchObject({ kind: "image" });
      expect(changes.map((c) => c.op)).toEqual(["move", "move"]);
    });

    it("reports trash and its undo, symlinks, archives and emptying the Recycle Bin", async () => {
      install();
      const trashed = await mockInvoke<{ history: Summary }>("delete_entries", { paths: ["/home/ines/notes.md"], permanent: false });
      await undoLast(trashed.history);
      await mockInvoke("create_symlink", { targetPath: "/home/ines/repo", linkPath: "/home/ines/repo-link" });
      await mockInvoke("compress_to_zip", { paths: ["/home/ines/Field"] });
      await mockInvoke("extract_archive", { archivePath: "/home/ines/Field.zip", extractHere: false });
      const trash = await mockInvoke<{ entries: Array<{ id: string }> }>("list_trash");
      await mockInvoke("delete_trash_items", { ids: trash.entries.map((e) => e.id) });
      expect(changes).toEqual([
        { op: "trash", path: "/home/ines/notes.md" },
        { op: "restore", path: "/home/ines/notes.md" },
        { op: "symlink", path: "/home/ines/repo-link" },
        { op: "compress", path: "/home/ines/Field.zip" },
        { op: "extract", path: "/home/ines/Field" },
        { op: "purge", path: "/home/ines/old.txt" },
      ]);
    });
  });

  it("a failing observer never changes a command's outcome (review C)", async () => {
    install();
    const stop = onMockFsChange(() => { throw new Error("observer bug"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mockInvoke("create_directory", { parentPath: "/home/ines", name: "New" })).resolves.toMatchObject({ result: { path: "/home/ines/New" } });
      expect(changes).toEqual([{ op: "mkdir", path: "/home/ines/New" }]);
    } finally {
      stop();
      errors.mockRestore();
    }
  });

  it("starts with nothing to recover and gives the built-in recovery records back on uninstall", async () => {
    const before = await mockInvoke<{ items: unknown[] }>("file_recovery_list");
    expect(before.items.length).toBeGreaterThan(0);
    install();
    expect((await mockInvoke<{ items: unknown[] }>("file_recovery_list")).items).toEqual([]);
    installed!.uninstall();
    installed = null;
    expect((await mockInvoke<{ items: unknown[] }>("file_recovery_list")).items).toHaveLength(before.items.length);
  });

  it("counts the Recycle Bin as items are trashed and purged", async () => {
    install();
    expect(mockTrashCount()).toBe(1);
    await mockInvoke("delete_entries", { paths: ["/home/ines/notes.md"], permanent: false });
    expect(mockTrashCount()).toBe(2);
    const trash = await mockInvoke<{ entries: Array<{ id: string }> }>("list_trash");
    await mockInvoke("delete_trash_items", { ids: trash.entries.map((e) => e.id) });
    expect(mockTrashCount()).toBe(0);
  });

  it("searches skip hidden entries below the root, as the real walkers do", async () => {
    installed = installMockWorld(convertDemoFixture({
      users: [{ id: "ines", home: "/home/ines" }],
      tree: { kids: [{ name: "home", kids: [{ name: "ines", kids: [
        { name: "count.txt", text: "Item C" },
        { name: ".not yet", kids: [{ name: "count.txt", text: "Item C" }] },
        { name: ".hidden-count.txt", text: "Item C" },
        { name: ".config", kids: [{ name: "x.txt", text: "Item C" }] },
      ] }] }] },
    }, { now: NOW }));
    const content = await mockInvoke<{ results: Array<{ path: string }> }>("start_content_search", { query: "Item C", root: "/" });
    expect(content.results.map((r) => r.path)).toEqual(["/home/ines/count.txt"]);
    const names = await mockInvoke<{ results: Array<{ path: string }> }>("fuzzy_search", { query: "count", root: "/home/ines", limit: 50 });
    expect(names.results.map((r) => r.path)).toEqual(["/home/ines/count.txt"]);
    // A hidden root is still searched.
    const inside = await mockInvoke<{ results: Array<{ path: string }> }>("start_content_search", { query: "Item C", root: "/home/ines/.config" });
    expect(inside.results.map((r) => r.path)).toEqual(["/home/ines/.config/x.txt"]);
  });

  describe("fixture repositories track the working tree", () => {
    const REPO = "/home/ines/repo";
    type Entry = { path: string; status: string };
    type Status = { branch: string; staged: Entry[]; changes: Entry[]; untracked: Entry[] };
    const status = () => mockInvoke<Status>("git_status", { repoPath: REPO });
    const lists = async () => {
      const s = await status();
      return { staged: s.staged.map((e) => e.path), changes: s.changes.map((e) => e.path), untracked: s.untracked.map((e) => e.path) };
    };

    it("starts from the fixture's changes, with a real diff against the committed text", async () => {
      install();
      expect(await status()).toMatchObject({ branch: "main", staged: [], changes: [{ path: "a.txt", status: "Modified" }], untracked: [] });
      expect(getMockFixtureRepos().map((r) => [r.root, r.changes.length])).toEqual([[REPO, 1]]);
      expect(await mockInvoke("git_diff", { repoPath: REPO, path: "a.txt", options: null })).toContain("-x\n+a\n\\ No newline at end of file");
    });

    it("lists files created, edited, renamed and deleted through the filesystem", async () => {
      install();
      await mockInvoke("write_text_file", { path: `${REPO}/new.md`, content: "fresh\n" });
      expect(await lists()).toEqual({ staged: [], changes: ["a.txt"], untracked: ["new.md"] });
      await mockInvoke("rename_entry", { path: `${REPO}/a.txt`, newName: "b.txt" });
      expect(await lists()).toEqual({ staged: [], changes: ["a.txt"], untracked: ["b.txt", "new.md"] });
      expect((await status()).changes[0].status).toBe("Deleted");
      await mockInvoke("delete_entries", { paths: [`${REPO}/new.md`], permanent: false });
      expect((await lists()).untracked).toEqual(["b.txt"]);
    });

    it("stages, unstages and commits; the commit heads the log and clears the staged list", async () => {
      install();
      await mockInvoke("write_text_file", { path: `${REPO}/new.md`, content: "fresh\n" });
      await mockInvoke("git_stage", { repoPath: REPO, paths: ["a.txt", "new.md"] });
      expect(await lists()).toEqual({ staged: ["a.txt", "new.md"], changes: [], untracked: [] });
      expect(await mockInvoke("git_diff", { repoPath: REPO, path: "new.md", options: { staged: true } })).toContain("new file mode 100644");
      await mockInvoke("git_unstage", { repoPath: REPO, paths: ["new.md"] });
      expect(await lists()).toEqual({ staged: ["a.txt"], changes: [], untracked: ["new.md"] });

      const result = await mockInvoke<{ commit_id: string; summary: string }>("git_commit", { repoPath: REPO, message: "Count the cranes", options: null });
      expect(result.summary).toBe("Count the cranes");
      expect(await lists()).toEqual({ staged: [], changes: [], untracked: ["new.md"] });
      const page = await mockInvoke<LogPage & { commits: Array<{ oid: string; summary: string }> }>("git_log", { repoPath: REPO, options: { skip: 0, limit: 10 } });
      expect(page.commits.map((c) => c.summary)).toEqual(["Count the cranes", "Merge", "Side", "Root"]);
      const files = await mockInvoke<Entry[]>("git_commit_files", { repoPath: REPO, oid: result.commit_id });
      expect(files).toEqual([{ path: "a.txt", status: "M" }]);
      expect(getMockFixtureRepos()[0]).toMatchObject({ head: result.commit_id, branch: "main" });
      await expect(mockInvoke("git_commit", { repoPath: REPO, message: "again", options: null })).rejects.toThrow(/nothing to commit/);
    });

    it("discard restores a tracked file and removes an untracked one", async () => {
      install();
      await mockInvoke("write_text_file", { path: `${REPO}/new.md`, content: "fresh\n" });
      await mockInvoke("git_discard", { repoPath: REPO, paths: ["a.txt", "new.md"], options: null });
      expect(await mockInvoke("read_text_file", { path: `${REPO}/a.txt` })).toBe("x\n");
      expect(await lists()).toEqual({ staged: [], changes: [], untracked: [] });
    });

    it("stages and discards single hunks through patches", async () => {
      install();
      await mockInvoke("write_text_file", { path: `${REPO}/a.txt`, content: "x\ny\n" });
      const patch = await mockInvoke<string>("git_diff", { repoPath: REPO, path: "a.txt", options: null });
      await mockInvoke("git_apply_patch", { repoPath: REPO, patch, action: "stage" });
      expect(await lists()).toEqual({ staged: ["a.txt"], changes: [], untracked: [] });
      const staged = await mockInvoke<string>("git_diff", { repoPath: REPO, path: "a.txt", options: { staged: true } });
      await mockInvoke("git_apply_patch", { repoPath: REPO, patch: staged, action: "unstage" });
      expect(await lists()).toEqual({ staged: [], changes: ["a.txt"], untracked: [] });
      await mockInvoke("git_apply_patch", { repoPath: REPO, patch, action: "discard" });
      expect(await mockInvoke("read_text_file", { path: `${REPO}/a.txt` })).toBe("x\n");
    });

    it("ignores and trashes untracked files", async () => {
      install();
      await mockInvoke("write_text_file", { path: `${REPO}/scratch.log`, content: "" });
      await mockInvoke("write_text_file", { path: `${REPO}/keep.md`, content: "" });
      expect(await mockInvoke("git_add_to_gitignore", { repoRoot: REPO, entry: "scratch.log" })).toBe("scratch.log");
      expect((await lists()).untracked).toEqual([".gitignore", "keep.md"]);
      await mockInvoke("git_trash_untracked", { repoPath: REPO, paths: ["keep.md"] });
      expect((await lists()).untracked).toEqual([".gitignore"]);
      await expect(mockInvoke("git_trash_untracked", { repoPath: REPO, paths: ["a.txt"] })).rejects.toThrow(/non-untracked/);
    });

    it("tells git observers when a file inside a repository changes, as the native watcher does", async () => {
      install();
      // Let announcements from the previous test land first.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const seen: GitChange[] = [];
      const stop = await subscribeGitChanges((change) => seen.push(change));
      try {
        await mockInvoke("write_text_file", { path: `${REPO}/new.md`, content: "1" });
        await mockInvoke("write_text_file", { path: "/home/ines/outside.md", content: "1" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(seen).toEqual([{ repoRoot: REPO, source: "watcher" }]);
      } finally {
        stop();
      }
    });

    it("announces every index or history change as the native .git watcher would, so an open graph reloads (review D1)", async () => {
      install();
      const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
      await settle();
      const seen: GitChange[] = [];
      const stop = await subscribeGitChanges((change) => seen.push(change));
      try {
        for (const [command, args] of [
          ["git_stage", { repoPath: REPO, paths: ["a.txt"] }],
          ["git_unstage", { repoPath: REPO, paths: ["a.txt"] }],
          ["git_stage", { repoPath: REPO, paths: ["a.txt"] }],
          ["git_commit", { repoPath: REPO, message: "m", options: null }],
        ] as const) {
          seen.length = 0;
          await mockInvoke(command, args);
          await settle();
          expect(seen, command).toEqual([{ repoRoot: REPO, source: "watcher" }]);
        }
        // Reads announce nothing.
        seen.length = 0;
        await mockInvoke("git_status", { repoPath: REPO });
        await settle();
        expect(seen).toEqual([]);
      } finally {
        stop();
      }
    });

    it("a file deleted and created again at the same path is new and empty, and its text comes back with a restore (review D4)", async () => {
      install();
      await mockInvoke("delete_entries", { paths: [`${REPO}/a.txt`], permanent: false });
      await mockInvoke("create_empty_file", { parentPath: REPO, name: "a.txt" });
      expect(await mockInvoke("read_text_file", { path: `${REPO}/a.txt` })).toBe("");
      expect(await status()).toMatchObject({ changes: [{ path: "a.txt", status: "Modified" }] });
      expect(await mockInvoke("git_diff", { repoPath: REPO, path: "a.txt", options: null })).toContain("-x\n");
      // Out of the way, then the trashed file comes back with its text.
      await mockInvoke("delete_entries", { paths: [`${REPO}/a.txt`], permanent: true });
      const trash = await mockInvoke<{ entries: Array<{ id: string; originalPath: string }> }>("list_trash");
      const item = trash.entries.find((e) => e.originalPath === `${REPO}/a.txt`)!;
      await mockInvoke("restore_trash_items", { ids: [item.id] });
      expect(await mockInvoke("read_text_file", { path: `${REPO}/a.txt` })).toBe("a");
    });

    it("an empty new file is untracked text, not binary (review D10)", async () => {
      install();
      await mockInvoke("create_empty_file", { parentPath: REPO, name: "empty.md" });
      expect((await lists()).untracked).toEqual(["empty.md"]);
      expect(await mockInvoke("git_diff", { repoPath: REPO, path: "empty.md", options: null })).not.toMatch(/Binary/);
    });

    it("a renamed or moved repository folder stays a repository (review D5)", async () => {
      install();
      await mockInvoke("rename_entry", { path: REPO, newName: "repo2" });
      expect(await mockInvoke("git_repo_root", { path: "/home/ines/repo2" })).toBe("/home/ines/repo2");
      expect(await mockInvoke<Status>("git_status", { repoPath: "/home/ines/repo2" })).toMatchObject({ changes: [{ path: "a.txt", status: "Modified" }] });
      await mockInvoke("move_entries", { request: { requestId: "r2", sources: ["/home/ines/repo2"], destDir: "/home/ines/Archive" }, events: () => {} });
      expect(await mockInvoke("git_repo_root", { path: "/home/ines/Archive/repo2" })).toBe("/home/ines/Archive/repo2");
      const page = await mockInvoke<LogPage>("git_log", { repoPath: "/home/ines/Archive/repo2", options: { skip: 0, limit: 10 } });
      expect(page.commits.map((c) => c.summary)).toEqual(["Merge", "Side", "Root"]);
      expect(await mockInvoke("git_repo_root", { path: REPO })).toBeNull();
    });

    it("folder badges combine staged and unstaged halves and keep untracked-only folders untracked", async () => {
      install();
      await mockInvoke("create_directory", { parentPath: REPO, name: "fresh" });
      await mockInvoke("write_text_file", { path: `${REPO}/fresh/n.txt`, content: "n" });
      await mockInvoke("write_text_file", { path: `${REPO}/a.txt`, content: "x\ny\n" });
      await mockInvoke("git_stage", { repoPath: REPO, paths: ["a.txt"] });
      await mockInvoke("write_text_file", { path: `${REPO}/a.txt`, content: "x\ny\nz\n" });
      const badges = await mockInvoke<{ statuses: Record<string, string> }>("get_git_status", { path: REPO });
      expect(badges.statuses).toEqual({ "a.txt": "Modified", fresh: "Untracked" });
    });

    it("routes fixture repositories only while a world is installed: mock-invoke itself never imports them (review D7)", async () => {
      expect(readFileSync(resolve("src/lib/api/mock-invoke.ts"), "utf8")).not.toMatch(/mock-git-fixture|demo-repo-worktree|demo-fixture-git/);
      install();
      expect(await mockInvoke("git_repo_root", { path: REPO })).toBe(REPO);
      installed!.uninstall();
      installed = null;
      // The built-in mock answers again: its git_repo_root knows only its own repository.
      expect(await mockInvoke("git_repo_root", { path: REPO })).not.toBe(REPO);
    });

    it("leaves the fixture as installed after a reinstall", async () => {
      install();
      await mockInvoke("git_stage", { repoPath: REPO, paths: ["a.txt"] });
      await mockInvoke("git_commit", { repoPath: REPO, message: "m", options: null });
      installed!.uninstall();
      install();
      expect(await lists()).toEqual({ staged: [], changes: ["a.txt"], untracked: [] });
      const page = await mockInvoke<LogPage>("git_log", { repoPath: REPO, options: { skip: 0, limit: 10 } });
      expect(page.commits[0].summary).toBe("Merge");
    });
  });

  describe("fixture repositories are read-only by default (review D)", () => {
    it.each(["git_checkout", "git_merge", "git_archive_untracked", "git_merge_abort", "git_rebase_abort", "git_rebase_continue", "git_revert_abort", "git_cherry_pick_abort"])(
      "%s is refused for a fixture repository", async (command) => {
        install();
        await expect(mockInvoke(command, { repoPath: "/home/ines/repo" })).rejects.toMatchObject({ message: expect.stringMatching(/read-only/) });
      });

    it("refuses a git command it does not know about instead of falling through", () => {
      install();
      const routed = withFixtureRepos({ git_future_mutation: () => "mutated built-in repo" });
      expect(() => routed.git_future_mutation({ repoPath: "/home/ines/repo" })).toThrow();
      expect(routed.git_future_mutation({ repoPath: "/home/user/Documents/project" })).toBe("mutated built-in repo");
    });
  });
});
