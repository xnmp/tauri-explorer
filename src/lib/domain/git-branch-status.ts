/**
 * Branch-status badge presentation for the commit graph (#1081).
 *
 * The backend classifies branches against a resolved trunk; this maps each
 * status to the chip badge. Badges are informational: they never dim rows —
 * the "Mute merge commits" toggle still keys on a commit's parent count.
 */

/** Trunk-aware branch classification (#1081). Mirrors
 *  `src-tauri/src/git_branch_status.rs`; branches with no status are omitted. */
export type BranchStatus = "merged" | "squash_merged" | "stale" | "unknown";

export interface BranchStatusEntry {
  /** Shorthand, e.g. `feature` or `origin/feature`. */
  name: string;
  remote: boolean;
  status: BranchStatus;
}

export interface BranchStatuses {
  /** Resolved trunk shorthand; null when none resolved (statuses is empty). */
  trunk: string | null;
  statuses: BranchStatusEntry[];
}

export interface BranchStatusBadge {
  readonly status: Exclude<BranchStatus, "unknown">;
  readonly label: string;
  readonly title: string;
}

/** Badge for a status; `unknown` (bounded search ran out) shows none. */
export function branchStatusBadge(
  status: BranchStatus | undefined,
  trunk: string | null,
): BranchStatusBadge | null {
  const into = trunk ?? "trunk";
  switch (status) {
    case "merged":
      return { status, label: "merged", title: `Merged into ${into}` };
    case "squash_merged":
      return { status, label: "squashed", title: `Squash-merged into ${into}` };
    case "stale":
      return {
        status,
        label: "stale",
        title: "Behind its tracking counterpart — not merged; pull or push to update it",
      };
    default:
      return null;
  }
}

/** Index statuses by branch shorthand (local and remote names never collide:
 *  remote shorthands carry their `remote/` prefix). */
export function indexBranchStatuses(
  entries: readonly BranchStatusEntry[],
): ReadonlyMap<string, BranchStatus> {
  return new Map(entries.map(({ name, status }) => [name, status]));
}
