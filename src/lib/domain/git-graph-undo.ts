/**
 * Immutable snapshots returned by successful git-graph mutations.
 *
 * The backend consumes the same shape when undoing and treats every field as
 * an expected-state precondition, not merely as instructions for an inverse.
 */
export type GitUndoAction =
  | {
      kind: "branch_delete";
      name: string;
      target: string;
    }
  | {
      kind: "tag_delete";
      name: string;
      target: string;
    }
  | {
      kind: "branch_rename";
      old_name: string;
      new_name: string;
      target: string;
    }
  | {
      kind: "head_move";
      operation: "merge" | "pull";
      branch: string | null;
      before_oid: string;
      after_oid: string;
    };

/** One session-only undo record, scoped to the repository that produced it. */
export interface GitUndoEntry {
  repoPath: string;
  action: GitUndoAction;
}
