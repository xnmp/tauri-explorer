import { afterEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "$lib/api/mock-invoke";
import { emitMockTerminal, listenMockTerminal, setMockTerminalBackend, type MockTerminalBackend } from "$lib/api/mock-terminal";
import { installMockWorld, type InstalledMockWorld } from "$lib/api/mock-world";
import { withFixtureRepos } from "$lib/api/mock-git-fixture";
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
    changes: [{ path: "a.txt", status: "Modified" }],
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

  describe("fixture repositories are read-only by default (review D)", () => {
    it.each(["git_commit", "git_merge_abort", "git_rebase_abort", "git_rebase_continue", "git_revert_abort", "git_cherry_pick_abort"])(
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
