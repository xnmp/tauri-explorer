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
