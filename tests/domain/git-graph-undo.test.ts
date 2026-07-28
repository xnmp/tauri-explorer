import { describe, expect, it } from "vitest";
import {
  createGitUndoLedger,
  gitUndoDescription,
  type GitUndoAction,
} from "$lib/domain/git-graph-undo";

const deletedBranch = (name: string, target = "a".repeat(40)): GitUndoAction => ({
  kind: "branch_delete",
  name,
  target,
});

describe("git graph undo ledger", () => {
  it("keeps a bounded LIFO history independently for each repository", () => {
    const ledger = createGitUndoLedger(2);
    ledger.record("/one", deletedBranch("old"));
    ledger.record("/two", deletedBranch("other"));
    ledger.record("/one", deletedBranch("middle"));
    ledger.record("/one", deletedBranch("latest"));

    expect(ledger.peek("/one")?.action).toEqual(deletedBranch("latest"));
    expect(ledger.take("/one")?.action).toEqual(deletedBranch("latest"));
    expect(ledger.take("/one")?.action).toEqual(deletedBranch("middle"));
    expect(ledger.take("/one")).toBeNull();
    expect(ledger.take("/two")?.action).toEqual(deletedBranch("other"));
  });

  it("describes every reversible operation for the confirmation seam", () => {
    expect(gitUndoDescription(deletedBranch("topic", "1".repeat(40)))).toBe(
      "delete branch 'topic' at 1111111",
    );
    expect(
      gitUndoDescription({ kind: "tag_delete", name: "v1", target: "2".repeat(40) }),
    ).toBe("delete tag 'v1' at 2222222");
    expect(
      gitUndoDescription({
        kind: "branch_rename",
        old_name: "before",
        new_name: "after",
        target: "3".repeat(40),
      }),
    ).toBe("rename branch 'before' to 'after'");
    expect(
      gitUndoDescription({
        kind: "head_move",
        operation: "merge",
        branch: "main",
        before_oid: "4".repeat(40),
        after_oid: "5".repeat(40),
      }),
    ).toBe("merge into 'main' (restore 4444444)");
    expect(
      gitUndoDescription({
        kind: "head_move",
        operation: "pull",
        branch: null,
        before_oid: "6".repeat(40),
        after_oid: "7".repeat(40),
      }),
    ).toBe("pull (restore 6666666)");
  });
});
