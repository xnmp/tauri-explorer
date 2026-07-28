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

export interface GitUndoLedger {
  record(repoPath: string, action: GitUndoAction): void;
  peek(repoPath: string): GitUndoEntry | null;
  take(repoPath: string): GitUndoEntry | null;
  clear(repoPath?: string): void;
}

/** Pure, bounded, per-repository LIFO history. Deliberately has no redo. */
export function createGitUndoLedger(capacity = 50): GitUndoLedger {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("Git undo ledger capacity must be a positive integer");
  }
  const byRepo = new Map<string, GitUndoAction[]>();

  return {
    record(repoPath, action) {
      const entries = byRepo.get(repoPath) ?? [];
      entries.push(action);
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      byRepo.set(repoPath, entries);
    },
    peek(repoPath) {
      const action = byRepo.get(repoPath)?.at(-1);
      return action ? { repoPath, action } : null;
    },
    take(repoPath) {
      const entries = byRepo.get(repoPath);
      const action = entries?.pop();
      if (entries?.length === 0) byRepo.delete(repoPath);
      return action ? { repoPath, action } : null;
    },
    clear(repoPath) {
      if (repoPath === undefined) byRepo.clear();
      else byRepo.delete(repoPath);
    },
  };
}

const shortOid = (oid: string): string => oid.slice(0, 7);

/** Human-readable description used by both confirmation and outcome toast. */
export function gitUndoDescription(action: GitUndoAction): string {
  switch (action.kind) {
    case "branch_delete":
      return `delete branch '${action.name}' at ${shortOid(action.target)}`;
    case "tag_delete":
      return `delete tag '${action.name}' at ${shortOid(action.target)}`;
    case "branch_rename":
      return `rename branch '${action.old_name}' to '${action.new_name}'`;
    case "head_move": {
      const target = action.branch ? ` into '${action.branch}'` : "";
      return `${action.operation}${target} (restore ${shortOid(action.before_oid)})`;
    }
  }
}

/** Structural equality across Svelte's reactive proxy boundary. */
export function sameGitUndoAction(left: GitUndoAction, right: GitUndoAction): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "branch_delete":
    case "tag_delete":
      return right.kind === left.kind && left.name === right.name && left.target === right.target;
    case "branch_rename":
      return (
        right.kind === "branch_rename" &&
        left.old_name === right.old_name &&
        left.new_name === right.new_name &&
        left.target === right.target
      );
    case "head_move":
      return (
        right.kind === "head_move" &&
        left.operation === right.operation &&
        left.branch === right.branch &&
        left.before_oid === right.before_oid &&
        left.after_oid === right.after_oid
      );
  }
}
