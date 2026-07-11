/**
 * SCM git backend types (#53).
 * Domain-owned so pure tree/formatting logic (e.g. scm-tree.ts) doesn't
 * depend on the api/ layer. `api/git.ts` imports and re-exports these so
 * existing `$lib/api/*` import sites keep working.
 */
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
