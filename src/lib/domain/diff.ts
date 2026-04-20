/**
 * Unified-diff parser (#55).
 *
 * Pure, framework-free. Consumes the text produced by `git diff` / libgit2's
 * `Diff::print(Patch)` and returns a flat line stream annotated with line
 * kind + side-by-side line numbers so the diff viewer can render each line
 * with +/− gutters without further bookkeeping.
 */

export type DiffLineKind = "header" | "hunk" | "context" | "add" | "remove" | "binary" | "meta";

export interface DiffLine {
  /** Monotonic index in the original stream — useful as a virtual-list key. */
  index: number;
  kind: DiffLineKind;
  /** Raw text content (without leading +/−/' ' marker, except on header lines). */
  text: string;
  /** Old-side (before) line number, or null if the line doesn't exist on the old side. */
  oldLine: number | null;
  /** New-side (after) line number, or null if the line doesn't exist on the new side. */
  newLine: number | null;
}

export interface ParsedDiff {
  /** True if the patch consists only of a "Binary files ... differ" marker. */
  binary: boolean;
  /** True if the patch represents a newly added file (/dev/null → path). */
  added: boolean;
  /** True if the patch represents a deleted file (path → /dev/null). */
  deleted: boolean;
  /** Old path (before rename/copy), when the patch header gives it. */
  oldPath: string | null;
  /** New path (after rename/copy), when the patch header gives it. */
  newPath: string | null;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let binary = false;
  let added = false;
  let deleted = false;
  let oldPath: string | null = null;
  let newPath: string | null = null;

  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;
  let index = 0;

  const raw = text.length === 0 ? [] : text.split("\n");
  // `split` produces a trailing empty string if the text ended in \n — drop it.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  for (const line of raw) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      lines.push({ index: index++, kind: "header", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") added = true;
      else oldPath = stripPrefix(p);
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") deleted = true;
      else newPath = stripPrefix(p);
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = line.slice("rename from ".length);
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("rename to ")) {
      newPath = line.slice("rename to ".length);
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (/^Binary files .* differ$/.test(line) || line.startsWith("GIT binary patch")) {
      binary = true;
      lines.push({ index: index++, kind: "binary", text: line, oldLine: null, newLine: null });
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldCursor = parseInt(m[1], 10);
      newCursor = parseInt(m[2], 10);
      inHunk = true;
      lines.push({ index: index++, kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) {
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    // Hunk body
    if (line.startsWith("+")) {
      lines.push({ index: index++, kind: "add", text: line.slice(1), oldLine: null, newLine: newCursor });
      newCursor += 1;
    } else if (line.startsWith("-")) {
      lines.push({ index: index++, kind: "remove", text: line.slice(1), oldLine: oldCursor, newLine: null });
      oldCursor += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — neither add nor remove
      lines.push({ index: index++, kind: "meta", text: line, oldLine: null, newLine: null });
    } else {
      const body = line.startsWith(" ") ? line.slice(1) : line;
      lines.push({ index: index++, kind: "context", text: body, oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  return { binary, added, deleted, oldPath, newPath, lines };
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
