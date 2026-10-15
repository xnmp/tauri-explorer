/**
 * Branch-status badge presentation for the commit graph (#1081).
 *
 * The backend classifies branches against a resolved trunk; this maps each
 * status to the chip badge. Badges are informational: they never dim rows —
 * the "Mute merge commits" toggle still keys on a commit's parent count.
 */

import type { BranchStatus, BranchStatusEntry } from "$lib/api/git-log";

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
