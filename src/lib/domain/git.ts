/**
 * SCM git backend types (#53).
 * Domain-owned so pure tree/formatting logic (e.g. scm-tree.ts) doesn't
 * depend on the api/ layer. `api/git.ts` imports and re-exports these so
 * existing `$lib/api/*` import sites keep working.
 */
import { compactRelativeTime } from "./relative-time";

export type GitStatusCode =
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Untracked"
  | "Ignored"
  | "Conflicted"
  | "TypeChange";

export interface GitFileEntry {
  path: string;
  old_path: string | null;
  status: GitStatusCode;
}

/**
 * In-progress repo operation reported by the backend (`repo.state()`).
 * `clean` means no operation is under way. The others drive the SCM panel's
 * in-progress banner (abort / continue).
 */
export type GitOpState = "clean" | "merge" | "rebase" | "cherry_pick" | "revert";

/** Human-readable label for an in-progress operation banner. */
export function gitOpStateLabel(state: GitOpState): string {
  switch (state) {
    case "merge": return "Merge";
    case "rebase": return "Rebase";
    case "cherry_pick": return "Cherry-pick";
    case "revert": return "Revert";
    case "clean": return "";
  }
}

/** Convert a git status string to its single-letter indicator */
export function gitStatusLetter(status: string): string {
  switch (status) {
    case "Modified": return "M";
    case "Added": return "A";
    case "Deleted": return "D";
    case "Renamed": return "R";
    case "Copied": return "C";
    case "Untracked": return "U";
    case "Ignored": return "I";
    case "Conflicted": return "!";
    case "TypeChange": return "T";
    default: return "?";
  }
}

/**
 * Relative wording for a commit made TODAY (local calendar day), or null so
 * the caller falls back to its date formatting (#389): "just now",
 * "N minutes ago", "N hours ago". Future timestamps (clock skew) read
 * "just now" rather than a negative age.
 */
export function relativeTimeToday(unixSeconds: number, nowMs: number): string | null {
  const then = new Date(unixSeconds * 1000);
  const now = new Date(nowMs);
  if (
    then.getFullYear() !== now.getFullYear() ||
    then.getMonth() !== now.getMonth() ||
    then.getDate() !== now.getDate()
  ) {
    return null;
  }
  const ageSec = Math.max(0, Math.floor((nowMs - unixSeconds * 1000) / 1000));
  if (ageSec < 60) return "just now";
  const minutes = Math.floor(ageSec / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/**
 * Compact form of {@link relativeTimeToday} for the git graph's narrow date
 * column (#458): "now", "5m", "2h" for commits made TODAY, else null so the
 * caller falls back to an absolute date. Same today-only + clock-skew ("now")
 * semantics; malformed input (NaN) reads as a non-today date and returns null.
 */
export function compactRelativeTimeToday(unixSeconds: number, nowMs: number): string | null {
  const then = new Date(unixSeconds * 1000);
  const now = new Date(nowMs);
  if (
    then.getFullYear() !== now.getFullYear() ||
    then.getMonth() !== now.getMonth() ||
    then.getDate() !== now.getDate()
  ) {
    return null;
  }
  return compactRelativeTime(nowMs - unixSeconds * 1000);
}
