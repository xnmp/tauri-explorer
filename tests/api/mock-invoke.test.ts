import { describe, it, expect } from "vitest";
import { mockInvoke } from "../../src/lib/api/mock-invoke";
import { decodeDirectoryListing, type CompactDirectoryListing } from "$lib/api/directory-wire";
import { MOCK_LOCAL_KEYS } from "../../src/lib/api/mock-control";

describe("mockInvoke — clipboard file round-trip", () => {
  type Snapshot = { revision: number; paths: string[]; operation: string | null };

  it("publishes entries that a later snapshot reads back", async () => {
    const entries = [{ name: "notes.md", path: "/home/user/notes.md" }, { name: "readme.txt", path: "/home/user/readme.txt" }];
    const published = await mockInvoke<Snapshot>("clipboard_publish", { entries, operation: "copy" });
    const snapshot = await mockInvoke<Snapshot>("clipboard_snapshot");
    expect(snapshot).toMatchObject({ revision: published.revision, operation: "copy", paths: entries.map((e) => e.path) });
  });

  it("returns an independent copy so callers cannot mutate the clipboard", async () => {
    await mockInvoke("clipboard_publish", { entries: [{ name: "a", path: "/a" }, { name: "b", path: "/b" }], operation: "copy" });
    const read = await mockInvoke<Snapshot>("clipboard_snapshot");
    read.paths.push("/hacked");
    expect((await mockInvoke<Snapshot>("clipboard_snapshot")).paths).toEqual(["/a", "/b"]);
  });
});

describe("mockInvoke — clipboard image paste", () => {
  it("creates the pasted image entry in the target directory listing", async () => {
    const directory = "/home/user/Pictures";
    const path = await mockInvoke<string>("clipboard_paste_image", { directory });

    expect(path).toBe(`${directory}/clipboard-image.png`);

    const listing = decodeDirectoryListing(await mockInvoke<CompactDirectoryListing>("list_directory", {
      path: directory,
    }));
    expect(listing.entries.some((e) => e.path === path)).toBe(true);
  });
});

describe("mockInvoke — no-op external process commands", () => {
  it("resolves the previously-unmocked commands without throwing", async () => {
    await expect(mockInvoke("open_file_with", { path: "/x", app: "vim" })).resolves.toBeUndefined();
    await expect(mockInvoke("open_in_terminal", { path: "/x" })).resolves.toBeUndefined();
    await expect(mockInvoke("set_as_wallpaper", { path: "/x.png" })).resolves.toBeUndefined();
    await expect(mockInvoke<string>("get_log_dir")).resolves.toMatch(/logs/);
    await expect(mockInvoke<number>("start_nano_banana_job", {})).resolves.toBeTypeOf("number");
  });
});

describe("mockInvoke — revisioned clipboard", () => {
  it("rekeys the native file list and rejects a stale clear", async () => {
    const initial = await mockInvoke<{ revision: number }>("clipboard_publish", {
      entries: [{ name: "old.txt", path: "/old.txt" }], operation: "cut",
    });
    const renamed = await mockInvoke<{ revision: number; paths: string[] }>("clipboard_rekey", {
      revision: initial.revision, oldPath: "/old.txt", entry: { name: "new.txt", path: "/new.txt" },
    });
    expect(renamed.paths).toEqual(["/new.txt"]);
    expect(await mockInvoke<boolean>("clipboard_compare_and_clear", { revision: initial.revision })).toBe(false);
    expect((await mockInvoke<{ paths: string[] }>("clipboard_snapshot")).paths).toEqual(["/new.txt"]);
  });

  it("can simulate a platform without native Cut ownership", async () => {
    localStorage.setItem(MOCK_LOCAL_KEYS.cutOwnershipUnavailable, "1");
    try {
      await expect(mockInvoke("clipboard_publish", {
        entries: [{ name: "a.txt", path: "/a.txt" }], operation: "cut",
      })).rejects.toThrow(/Cut requires native clipboard ownership/);
      await expect(mockInvoke("clipboard_publish", {
        entries: [{ name: "a.txt", path: "/a.txt" }], operation: "copy",
      })).resolves.toMatchObject({ paths: ["/a.txt"], operation: "copy" });
    } finally {
      localStorage.removeItem(MOCK_LOCAL_KEYS.cutOwnershipUnavailable);
    }
  });
});

describe("mockInvoke — file history undo of a copy whose file is gone (PR #917 review)", () => {
  it("reports an error and does not create a redo entry, matching the real backend's settled_copy rejection", async () => {
    const copiedPath = "/home/user/does-not-exist.txt";
    const pushed = await mockInvoke<{ summary: { undoId: number | null } }>("file_history_push", {
      action: { type: "copy", copiedPath, parentDir: "/home/user" },
    });
    const undoId = pushed.summary.undoId;
    expect(undoId).not.toBeNull();

    const result = await mockInvoke<{ summary: { undoId: number | null; redoId: number | null }; error?: string }>(
      "file_history_execute",
      { direction: "undo", expectedEntryId: undoId },
    );

    // The real backend's file_history/execution.rs settled_copy rejects an
    // undo whose copied_path isn't in `succeeded`; the mock must agree
    // instead of silently treating a per-path delete_entries failure as
    // success (#869 review finding).
    expect(result.error).toBeTruthy();
    expect(result.summary.redoId).toBeNull();
    // The failed undo stays on the undo stack (as a fresh "remaining" entry)
    // so it can be retried, rather than being dropped or turned into a redo.
    expect(result.summary.undoId).not.toBeNull();
  });
});
