/**
 * Site-demo fixture repositories, working-tree half: git's three trees
 * (HEAD, index, working tree) over the demo's in-memory filesystem, so the
 * Source Control panel's status, stage/unstage, discard, per-file diffs, hunk
 * patches and commits behave as git does. Pure: the mock layer
 * (`api/mock-git-fixture.ts`) reads the working tree, keeps the state and
 * performs the file writes a discard returns.
 *
 * A tree maps repo-relative paths to blobs: a file's text, or, for a file the
 * demo has no text for (an image, a recording), a signature that changes
 * whenever its size or date does. A fixture's `changes` say which files differ
 * from HEAD; the committed text is the change's `base` when the fixture gives
 * one, otherwise unknown, and such a file still lists as modified, shows its
 * current text as an unchanged diff, and is committed or discarded as it is.
 */
import { expandOid, type DemoChange, type DemoCommit, type DemoCommitFile, type DemoRef, type DemoRepo } from "./demo-fixture-git";

export type DemoBlob = string;
export type DemoTree = ReadonlyMap<string, DemoBlob>;

/** The committed version of a change the fixture listed without its `base`. */
export const UNKNOWN_BLOB = "\0unknown";
const BINARY_PREFIX = "\0binary:";

/** The blob of a file the demo has no text for. */
export function binaryBlob(size: number, modified: string): DemoBlob {
  return `${BINARY_PREFIX}${size}:${modified}`;
}

const isText = (blob: DemoBlob | undefined): blob is string => blob !== undefined && !blob.startsWith("\0");

export interface DemoIndexState {
  readonly head: DemoTree;
  readonly index: DemoTree;
}

export type DemoStatusCode = "Added" | "Modified" | "Deleted" | "Untracked";
export interface DemoStatusEntry {
  readonly path: string;
  readonly old_path: null;
  readonly status: DemoStatusCode;
}
export interface DemoStatus {
  readonly staged: readonly DemoStatusEntry[];
  readonly changes: readonly DemoStatusEntry[];
  readonly untracked: readonly DemoStatusEntry[];
}

const entry = (path: string, status: DemoStatusCode): DemoStatusEntry => ({ path, old_path: null, status });
const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();

/** HEAD and index for a freshly installed repository whose working tree is `work`. */
export function seedIndexState(work: DemoTree, changes: readonly DemoChange[]): DemoIndexState {
  const head = new Map(work);
  const staged = new Set<string>();
  for (const change of changes) {
    const now = work.get(change.path);
    if (change.status === "Untracked") {
      head.delete(change.path);
      continue;
    }
    if (change.status === "Added") {
      if (now === undefined) continue;
      head.delete(change.path);
      staged.add(change.path);
      continue;
    }
    // Modified, Deleted, Renamed, Conflicted: the committed version differs.
    const base = change.base ?? UNKNOWN_BLOB;
    if (base === now) continue;
    head.set(change.path, base);
    if (change.staged) staged.add(change.path);
  }
  const index = new Map(head);
  for (const path of staged) {
    const now = work.get(path);
    if (now === undefined) index.delete(path);
    else index.set(path, now);
  }
  return { head, index };
}

/** `git status`: HEAD against the index (staged), the index against the working tree. */
export function demoStatus({ head, index }: DemoIndexState, work: DemoTree): DemoStatus {
  const staged: DemoStatusEntry[] = [];
  for (const path of sorted([...head.keys(), ...index.keys()])) {
    const before = head.get(path);
    const after = index.get(path);
    if (before === after) continue;
    staged.push(entry(path, before === undefined ? "Added" : after === undefined ? "Deleted" : "Modified"));
  }
  const changes: DemoStatusEntry[] = [];
  for (const path of sorted(index.keys())) {
    const now = work.get(path);
    if (now === undefined) changes.push(entry(path, "Deleted"));
    else if (now !== index.get(path)) changes.push(entry(path, "Modified"));
  }
  const ignore = work.get(".gitignore");
  const ignored = isText(ignore) ? gitignoreMatcher(ignore) : () => false;
  const untracked = sorted(work.keys())
    .filter((path) => !index.has(path) && !ignored(path))
    .map((path) => entry(path, "Untracked"));
  return { staged, changes, untracked };
}

/**
 * The root `.gitignore`, in the subset the demo needs: names or paths
 * (a trailing `/` for folders, a leading `/` to anchor), `*` and `?`
 * wildcards, `#` comments. Negation and `**` are not modelled.
 */
export function gitignoreMatcher(text: string): (path: string) => boolean {
  const rules = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => {
      const anchored = line.startsWith("/") || line.replace(/\/$/, "").includes("/");
      const body = line.replace(/^\//, "").replace(/\/$/, "");
      const glob = new RegExp(`^${body.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`);
      return { anchored, glob };
    });
  return (path) => {
    const parts = path.split("/");
    return rules.some(({ anchored, glob }) => parts.some((_, i) => {
      // A rule matches the path itself or any folder above it.
      const prefix = parts.slice(0, i + 1).join("/");
      return anchored ? glob.test(prefix) : glob.test(parts[i]);
    }));
  };
}

/** `.gitignore` with `entry` appended, unless an identical line is already there. */
export function withGitignoreEntry(text: string | undefined, entry: string): string {
  const current = text ?? "";
  if (current.split("\n").some((line) => line.trim() === entry)) return current;
  return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`;
}

/** The status as fixture-style changes (what the terminal's `git status` and folder badges read). */
export function statusChanges(status: DemoStatus): DemoChange[] {
  return [
    ...status.staged.map((e) => ({ path: e.path, status: e.status, staged: true })),
    ...status.changes.map((e) => ({ path: e.path, status: e.status })),
    ...status.untracked.map((e) => ({ path: e.path, status: e.status })),
  ];
}

/** A repo-relative path, or a folder covering it ("" or "." is the whole repository). */
function covers(paths: readonly string[], key: string): boolean {
  return paths.some((raw) => {
    const path = raw.replace(/^\.\/?/, "").replace(/\/+$/, "");
    return path === "" || key === path || key.startsWith(`${path}/`);
  });
}

/** `git add`: the index takes the working tree's version (or drops a deleted file). */
export function stagePaths(state: DemoIndexState, work: DemoTree, paths: readonly string[]): DemoIndexState {
  const index = new Map(state.index);
  for (const key of sorted([...index.keys(), ...work.keys()])) {
    if (!covers(paths, key)) continue;
    const now = work.get(key);
    if (now === undefined) index.delete(key);
    else index.set(key, now);
  }
  return { head: state.head, index };
}

/** `git restore --staged`: the index takes HEAD's version back. */
export function unstagePaths(state: DemoIndexState, paths: readonly string[]): DemoIndexState {
  const index = new Map(state.index);
  for (const key of sorted([...index.keys(), ...state.head.keys()])) {
    if (!covers(paths, key)) continue;
    const committed = state.head.get(key);
    if (committed === undefined) index.delete(key);
    else index.set(key, committed);
  }
  return { head: state.head, index };
}

/** A working-tree write a discard needs: new text, or null to remove the file. */
export interface DemoWrite {
  readonly path: string;
  readonly text: string | null;
}

/**
 * Discard, as the native `git_discard`: a tracked file is restored from HEAD,
 * a file the index does not know is removed, and a staged change is refused
 * unless `force` (which resets its index entry too). A committed version the
 * demo cannot write back (unknown text, or no text at all) is accepted as it
 * now is instead, so a discard never fails for want of content.
 */
export function discardPaths(
  state: DemoIndexState,
  work: DemoTree,
  paths: readonly string[],
  force: boolean,
): { state: DemoIndexState; writes: DemoWrite[] } {
  const head = new Map(state.head);
  const index = new Map(state.index);
  const writes: DemoWrite[] = [];
  const keys = sorted([...index.keys(), ...work.keys()]).filter((key) => covers(paths, key));
  if (!force) {
    const staged = keys.find((key) => index.has(key) && head.get(key) !== index.get(key));
    if (staged) throw new Error(`refusing to discard '${staged}' with staged changes; pass force=true to override`);
  }
  for (const key of keys) {
    const now = work.get(key);
    if (!index.has(key)) {
      writes.push({ path: key, text: null });
      continue;
    }
    const committed = head.get(key);
    if (committed === undefined) {
      index.delete(key);
      if (now !== undefined) writes.push({ path: key, text: null });
    } else if (committed === now) {
      index.set(key, committed);
    } else if (isText(committed)) {
      index.set(key, committed);
      writes.push({ path: key, text: committed });
    } else {
      // Nothing to write back: the file as it is becomes the committed version.
      for (const tree of [head, index]) {
        if (now === undefined) tree.delete(key);
        else tree.set(key, now);
      }
    }
  }
  return { state: { head, index }, writes };
}

// ----- Diffs -----

const NO_EOL = "\0noeol";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

/** Lines of a text; a last line without a newline carries a marker so it compares unequal to one with. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

function fromLines(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1];
  return last.endsWith(NO_EOL) ? [...lines.slice(0, -1), last.slice(0, -NO_EOL.length)].join("\n") : `${lines.join("\n")}\n`;
}

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

/** A shortest edit script (LCS), with the common prefix and suffix trimmed first. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: Op[] = [];
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    middle.push(...midA.map((line) => ({ kind: "-" as const, line })), ...midB.map((line) => ({ kind: "+" as const, line })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { middle.push({ kind: " ", line: midA[i] }); i++; j++; }
      else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) { middle.push({ kind: "-", line: midA[i] }); i++; }
      else { middle.push({ kind: "+", line: midB[j] }); j++; }
    }
  }
  return [
    ...a.slice(0, start).map((line) => ({ kind: " " as const, line })),
    ...normaliseOrder(middle),
    ...a.slice(endA).map((line) => ({ kind: " " as const, line })),
  ];
}

/** Within each run of changes, removals before additions, as git prints them. */
function normaliseOrder(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  let removed: Op[] = [];
  let added: Op[] = [];
  const flush = () => { out.push(...removed, ...added); removed = []; added = []; };
  for (const op of ops) {
    if (op.kind === "-") removed.push(op);
    else if (op.kind === "+") added.push(op);
    else { flush(); out.push(op); }
  }
  flush();
  return out;
}

function hunks(ops: readonly Op[]): string[] {
  const changed = ops.flatMap((op, i) => (op.kind === " " ? [] : [i]));
  if (changed.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(ops.length - 1, i + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const out: string[] = [];
  for (const [from, to] of ranges) {
    let oldStart = 1;
    let newStart = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") oldStart++;
      if (op.kind !== "-") newStart++;
    }
    const body = ops.slice(from, to + 1);
    const oldCount = body.filter((op) => op.kind !== "+").length;
    const newCount = body.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
    for (const op of body) {
      const bare = op.line.endsWith(NO_EOL) ? op.line.slice(0, -NO_EOL.length) : op.line;
      out.push(`${op.kind}${bare}`);
      if (bare !== op.line) out.push(NO_NEWLINE_MARKER);
    }
  }
  return out;
}

/**
 * A one-file unified diff in git's format, from `before` to `after` (undefined:
 * the file does not exist on that side). A file without text diffs as binary;
 * an unknown committed version shows the current text as unchanged context.
 */
export function demoUnifiedDiff(path: string, before: DemoBlob | undefined, after: DemoBlob | undefined): string {
  const header = [`diff --git a/${path} b/${path}`];
  if (before === undefined) header.push("new file mode 100644");
  if (after === undefined) header.push("deleted file mode 100644");
  if ((before !== undefined && !isText(before) && before !== UNKNOWN_BLOB) || (after !== undefined && !isText(after))) {
    return [...header, `Binary files ${before === undefined ? "/dev/null" : `a/${path}`} and ${after === undefined ? "/dev/null" : `b/${path}`} differ`, ""].join("\n");
  }
  const newLines = toLines(after ?? "");
  const ops: Op[] = before === UNKNOWN_BLOB
    ? newLines.map((line) => ({ kind: " ", line }))
    : editScript(toLines(before ?? ""), newLines);
  const body = before === UNKNOWN_BLOB ? allContext(ops) : hunks(ops);
  if (body.length === 0) return "";
  return [
    ...header,
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
    ...body,
    "",
  ].join("\n");
}

/** One hunk holding the whole file as context (the committed text is unknown). */
function allContext(ops: readonly Op[]): string[] {
  if (ops.length === 0) return [];
  return [`@@ -1,${ops.length} +1,${ops.length} @@`, ...ops.flatMap((op) => {
    const bare = op.line.endsWith(NO_EOL) ? op.line.slice(0, -NO_EOL.length) : op.line;
    return bare === op.line ? [` ${bare}`] : [` ${bare}`, NO_NEWLINE_MARKER];
  })];
}

/**
 * Apply the hunks of a one-file unified patch to `text` (`reverse`: undo
 * them), as `git apply` does for the panel's per-hunk stage, unstage and
 * discard. Each hunk must match at its line or, failing that, once anywhere.
 */
export function applyDemoPatch(text: string, patch: string, reverse: boolean): string {
  const lines = toLines(text);
  const parsed = parseHunks(patch, reverse);
  if (parsed.length === 0) throw new Error("patch has no hunks");
  let offset = 0;
  for (const hunk of parsed) {
    const matchesAt = (start: number) =>
      start + hunk.from.length <= lines.length && hunk.from.every((line, k) => lines[start + k] === line);
    // A pure insertion's line number is the line it follows.
    const expected = Math.max(0, (hunk.from.length ? hunk.at - 1 : hunk.at) + offset);
    let start = matchesAt(expected) ? expected : -1;
    if (start < 0) {
      const found: number[] = [];
      for (let s = 0; s + hunk.from.length <= lines.length; s++) if (matchesAt(s)) found.push(s);
      if (found.length !== 1) throw new Error("patch does not apply");
      start = found[0];
    }
    lines.splice(start, hunk.from.length, ...hunk.to);
    offset += hunk.to.length - hunk.from.length;
  }
  return fromLines(lines);
}

interface ParsedHunk { at: number; from: string[]; to: string[] }

/** Hunks as line replacements, in the direction the patch is applied. */
function parseHunks(patch: string, reverse: boolean): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  // The sides the previous line went to: a "no newline" marker qualifies it there.
  let lastSides: string[][] = [];
  const removes = reverse ? "+" : "-";
  const adds = reverse ? "-" : "+";
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = { at: Number(reverse ? header[2] : header[1]), from: [], to: [] };
      hunks.push(current);
      lastSides = [];
      continue;
    }
    if (!current) continue;
    if (raw === NO_NEWLINE_MARKER) {
      for (const side of lastSides) side[side.length - 1] += NO_EOL;
      continue;
    }
    const kind = raw[0];
    const line = raw.slice(1);
    if (kind === " ") { current.from.push(line); current.to.push(line); lastSides = [current.from, current.to]; }
    else if (kind === removes) { current.from.push(line); lastSides = [current.from]; }
    else if (kind === adds) { current.to.push(line); lastSides = [current.to]; }
    else lastSides = [];
  }
  return hunks;
}

// ----- Commits -----

/** The files a commit records: HEAD against the index, each with its diff. */
export function stagedFiles({ head, index }: DemoIndexState): DemoCommitFile[] {
  return demoStatus({ head, index }, index).staged.map(({ path, status }) => {
    const diff = demoUnifiedDiff(path, head.get(path), index.get(path));
    return { path, status: status === "Added" ? "A" : status === "Deleted" ? "D" : "M", diff: diff || null };
  });
}

/**
 * Commit the index on the current branch (or amend HEAD's commit): the new
 * commit goes on top of the history, HEAD and the branch move to it, and the
 * index becomes HEAD. Fails as git does on an empty message or nothing staged.
 */
export function commitDemoRepo(
  repo: DemoRepo,
  state: DemoIndexState,
  { message, amend, now }: { message: string; amend: boolean; now: number },
): { repo: DemoRepo; state: DemoIndexState; commit: DemoCommit } {
  const previous = repo.commits.find((c) => c.oid === repo.head) ?? null;
  const files = stagedFiles(state);
  if (amend && !previous) throw new Error("nothing to amend");
  const text = message.trim() ? message.trim() : amend && previous ? previous.message : "";
  if (!text) throw new Error("commit message cannot be empty");
  if (files.length === 0 && !amend) throw new Error("nothing to commit");

  const parents = amend && previous ? previous.parents : previous ? [previous.oid] : [];
  const time = Math.floor(now / 1000);
  const oid = expandOid(`demo-commit\n${parents.join(" ")}\n${time}\n${text}`);
  const recorded = amend && previous
    ? [...files, ...previous.files.filter((f) => !files.some((g) => g.path === f.path))]
    : files;
  const commit: DemoCommit = {
    oid,
    short_oid: oid.slice(0, 7),
    parents,
    author_name: previous?.author_name ?? "You",
    author_email: previous?.author_email ?? "you@example.invalid",
    author_time: time,
    summary: text.split("\n")[0],
    message: text,
    files: recorded,
  };

  // HEAD and its branch move to the new commit; other refs stay where they are.
  const refs: Record<string, DemoRef[]> = {};
  for (const [target, list] of Object.entries(repo.refs)) {
    const kept = target === repo.head
      ? list.filter((r) => r.kind !== "Head" && !(r.kind === "LocalBranch" && r.name === repo.branch))
      : [...list];
    if (kept.length) refs[target] = kept;
  }
  refs[oid] = [{ name: "HEAD", kind: "Head" }, ...(repo.branch ? [{ name: repo.branch, kind: "LocalBranch" as const }] : [])];
  // An amended commit leaves the history unless another ref still names it.
  const dropped = amend && previous && !refs[previous.oid] ? previous.oid : null;
  const commits = [commit, ...repo.commits.filter((c) => c.oid !== dropped)];
  return {
    repo: { ...repo, head: oid, commits, refs },
    state: { head: new Map(state.index), index: state.index },
    commit,
  };
}
