/** Convert a git status string to its single-letter indicator */
export function gitStatusLetter(status: string): string {
  switch (status) {
    case "Modified": return "M";
    case "Untracked": return "U";
    case "Added": return "A";
    case "Deleted": return "D";
    case "Conflict": return "!";
    default: return "R";
  }
}
