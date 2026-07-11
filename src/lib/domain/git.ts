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
