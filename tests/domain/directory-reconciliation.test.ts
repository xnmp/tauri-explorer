import { describe, it, expect } from "vitest";
import { reconcileDirectoryEntries, reconcileDirectorySelection } from "../../src/lib/domain/directory-reconciliation";
import type { FileEntry } from "../../src/lib/domain/file";

const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name, path: `/work/${name}`, kind: "file", size: 1, modified: "2026-01-01", ...extra,
});

describe("complete directory reconciliation", () => {
  it("publishes changes to every observable file field", () => {
    const before = [file("item")];
    for (const extra of [{ path: "/other/item" }, { name: "new-name" }, { size: 2 }, { modified: "2026-02-01" }, { kind: "directory" as const }, { is_symlink: true }, { symlink_target: "/new-target" }, { is_empty: true }, { is_git_repo: true }]) {
      const incoming = [file("item", extra)];
      expect(reconcileDirectoryEntries(before, before, incoming)).toEqual({ entries: incoming, needsRefresh: false });
    }
  });

  it("accepts external changes after an equivalent local listing reassignment", () => {
    const before = [file("old")];
    const current = before.map((entry) => ({ ...entry }));
    const incoming = [file("new")];
    expect(reconcileDirectoryEntries(before, current, incoming))
      .toEqual({ entries: incoming, needsRefresh: false });
  });

  it("preserves a concurrent rename without losing an unrelated observed deletion", () => {
    const before = [file("old"), file("external"), file("keep")];
    const current = [file("new"), before[1], before[2]];
    const incoming = [file("old"), file("keep")];
    const reconciled = reconcileDirectoryEntries(before, current, incoming);
    expect(reconciled.entries.map((entry) => entry.name)).toEqual(["keep", "new"]);
    expect(reconciled.needsRefresh).toBe(true);
    // An authoritative read started after the overlap may legitimately show
    // a later external removal of the newly renamed file.
    expect(reconcileDirectoryEntries(reconciled.entries, reconciled.entries, [file("keep")]))
      .toEqual({ entries: [file("keep")], needsRefresh: false });
  });

  it("does not schedule another scan when the incoming listing already covers local changes", () => {
    const before = [file("old")];
    const current = [file("new")];
    const result = reconcileDirectoryEntries(before, current, [file("new")]);
    expect(result.needsRefresh).toBe(false);
    expect(result.entries).toBe(current);
  });

  it("clears vanished identities without selecting another entry or discarding surviving selection", () => {
    const selected = new Set(["/work/gone", "/work/hidden"]);
    expect(reconcileDirectorySelection([file("hidden"), file("other")], { selectedPaths: selected, cursorPath: "/work/gone", anchorPath: "/work/hidden" }))
      .toEqual({ selectedPaths: new Set(["/work/hidden"]), cursorPath: null, anchorPath: "/work/hidden", needsRefresh: false });
    expect([...selected]).toEqual(["/work/gone", "/work/hidden"]);
  });
});
