/**
 * Shared mock Git repository state: working-tree status, hunks, the commit graph and refs
 * (including the synthetic load-test repositories) that the Git command families read and mutate.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { GitFileEntry, GitStatusCode, GitStatusSummary } from "$lib/api/git";
import { emitWatcherGitChange } from "$lib/state/git-refresh";
import { getMockControl, type MockGitCommit, type MockGitState } from "./mock-control";
import { dir, file, fullOid, MOCK_GRAPH_REFS, MOCK_GRAPH_SPEC, mockFiles } from "./mock-fixtures";


// ----- Synthetic load-test repositories (high-load stress suite) -----
//
// A pool of git-repo folders under Documents that the load E2E suite navigates
// into and opens the commit graph for. They must exist in the mock filesystem
// so real UI navigation reaches them; their git history is generated on demand
// by git_log/git_refs below (see the synthetic graph generator). Deterministic:
// nothing here uses Math.random.
export const LOAD_REPO_PREFIX = "/home/user/Documents/load-repo-";
const LOAD_REPO_COUNT = 16;
/** Repo index if `path` is inside a synthetic load-repo, else null. */
export function loadRepoIndex(path: string | undefined | null): number | null {
  if (!path || !path.startsWith(LOAD_REPO_PREFIX)) return null;
  const rest = path.slice(LOAD_REPO_PREFIX.length);
  const m = /^(\d+)(?:\/|$)/.exec(rest);
  if (!m) return null;
  const i = parseInt(m[1], 10);
  return i >= 0 && i < LOAD_REPO_COUNT ? i : null;
}
// Load-repos exist ONLY when the page opts in via ?mockGitCommits=N (set by
// the e2e-load suite). Injecting them unconditionally changed the baseline
// Documents listing and broke regular E2E in list/tiles view modes (the
// view-switch beforeEach right-clicks "empty space", which no longer existed).
const loadReposEnabled =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("mockGitCommits");
if (loadReposEnabled) {
  for (let i = 0; i < LOAD_REPO_COUNT; i++) {
    const root = `${LOAD_REPO_PREFIX}${i}`;
    // Visible + navigable under Documents, flagged as a git repo (#463 badge).
    mockFiles["/home/user/Documents"].push(dir(`load-repo-${i}`, root, false, true));
    mockFiles[root] = [
      dir("src", `${root}/src`, false),
      file("README.md", `${root}/README.md`, 2048),
      file("package.json", `${root}/package.json`, 512),
    ];
    mockFiles[`${root}/src`] = [file("index.ts", `${root}/src/index.ts`, 256)];
  }
}

/** Tracks paths added to .gitignore via the mocked git_add_to_gitignore so
 *  the SCM panel can hide newly-ignored entries on next git_status. */
export const mockGitignored = new Set<string>();
export const mockGitArchived = new Set<string>();

// ----- Stateful in-memory git repo (mirrors src-tauri/src/git.rs contract) -----
//
// The SCM E2E tests assert real outcomes (a staged row leaves Changes, commit
// empties the staged section, an external edit shows up on refresh). To make
// those observable, the mock keeps a mutable working-tree/index model and
// moves entries between sections the same way the git2-backed backend would.
export const MOCK_REPO_ROOT = "/home/user/Documents/project";

export const mockGitCommits: MockGitCommit[] = [];

function seedGitState(): MockGitState {
  return {
    branch: "main",
    detached: false,
    staged: [{ path: "src/App.tsx", old_path: null, status: "Modified" }],
    changes: [
      { path: "src/index.css", old_path: null, status: "Modified" },
      { path: "README.md", old_path: null, status: "Modified" },
    ],
    untracked: [
      { path: "src/router.tsx", old_path: null, status: "Untracked" },
      { path: ".env.example", old_path: null, status: "Untracked" },
      { path: "assets/logo.png", old_path: null, status: "Untracked" },
    ],
    // Default seed is a normal dirty tree (no operation in progress). E2E can
    // drive a merge-conflict flow via `window.__mockControl.gitStartMergeConflict()`.
    merge: [],
    op_state: "clean",
  };
}

export let mockGit: MockGitState = seedGitState();

// Per-file hunk state lets browser tests exercise the same partial staging
// outcome as the real `git apply` command rather than pretending a hunk is a
// whole-file operation.
const mockHunkState = new Map<string, { staged: Set<number>; discarded: Set<number> }>();
const MOCK_HUNK_STARTS = [1, 10] as const;

export function hunkState(path: string): { staged: Set<number>; discarded: Set<number> } {
  let state = mockHunkState.get(path);
  if (!state) {
    // Seeded/whole-file staged entries already live entirely in the index.
    // Their diff must therefore expose every mock hunk on the staged side,
    // even before any hunk-level action has initialized this state.
    const fullyStaged =
      mockGit.staged.some((entry) => entry.path === path) &&
      !mockGit.changes.some((entry) => entry.path === path);
    state = {
      staged: new Set(fullyStaged ? MOCK_HUNK_STARTS : []),
      discarded: new Set(),
    };
    mockHunkState.set(path, state);
  }
  return state;
}

export function removeFrom(list: GitFileEntry[], path: string): GitFileEntry | undefined {
  const idx = list.findIndex((e) => e.path === path);
  if (idx < 0) return undefined;
  return list.splice(idx, 1)[0];
}

export function upsert(list: GitFileEntry[], entry: GitFileEntry): void {
  if (!list.some((e) => e.path === entry.path)) list.push(entry);
}

/** Stage one path: untracked→staged(Added), changes/merge→staged(Modified). */
export function mockStagePath(path: string): void {
  const fromUntracked = removeFrom(mockGit.untracked, path);
  if (fromUntracked) {
    upsert(mockGit.staged, { path, old_path: null, status: "Added" });
    const state = hunkState(path);
    state.staged = new Set(MOCK_HUNK_STARTS);
    state.discarded.clear();
    return;
  }
  const fromMerge = removeFrom(mockGit.merge, path);
  const fromChanges = removeFrom(mockGit.changes, path);
  if (fromChanges || fromMerge) {
    upsert(mockGit.staged, { path, old_path: null, status: "Modified" });
    const state = hunkState(path);
    state.staged = new Set(MOCK_HUNK_STARTS);
    state.discarded.clear();
  }
}

/** Unstage one path: Added→untracked, otherwise→changes. */
export function mockUnstagePath(path: string): void {
  const staged = removeFrom(mockGit.staged, path);
  if (!staged) return;
  const state = hunkState(path);
  state.staged.clear();
  state.discarded.clear();
  if (staged.status === "Added") {
    upsert(mockGit.untracked, { path, old_path: null, status: "Untracked" });
  } else {
    upsert(mockGit.changes, { path, old_path: null, status: "Modified" });
  }
}

/** Discard mirrors git.rs: refuses a conflicted (merge) path outright, refuses
 *  a path with staged changes unless forced; otherwise reverts (changes) or
 *  removes (untracked). */
export function mockDiscardPath(path: string, force: boolean): void {
  // Conflicted paths have no single obviously-correct resolution, so git.rs
  // refuses to discard them (never force-bypassed) rather than silently
  // deleting — discarding one here would drop the entry and mask data loss.
  if (mockGit.merge.some((e) => e.path === path)) {
    throw new Error(
      `cannot discard '${path}': it has an unresolved merge conflict. ` +
        `Resolve the conflict (stage the file) or abort the operation.`,
    );
  }
  if (!force && mockGit.staged.some((e) => e.path === path)) {
    throw new Error(
      `refusing to discard '${path}' with staged changes; pass force=true to override`,
    );
  }
  removeFrom(mockGit.changes, path);
  removeFrom(mockGit.untracked, path);
  removeFrom(mockGit.merge, path);
  const state = hunkState(path);
  state.discarded = new Set(MOCK_HUNK_STARTS);
}

export function mockGitSummary(): GitStatusSummary {
  return {
    is_repo: true,
    repo_root: MOCK_REPO_ROOT,
    branch: mockGit.branch,
    detached: mockGit.detached,
    staged: mockGit.staged.map((e) => ({ ...e })),
    changes: mockGit.changes.map((e) => ({ ...e })),
    untracked: mockGit.untracked
      .filter((e) => !mockGitignored.has(e.path))
      .map((e) => ({ ...e })),
    merge: mockGit.merge.map((e) => ({ ...e })),
    op_state: mockGit.op_state,
  };
}

/** Clear any in-progress operation state (mirrors git's abort commands). */
export function mockClearOperation(): void {
  mockGit.merge = [];
  mockGit.op_state = "clean";
}

if (typeof window !== "undefined") {
  const control = getMockControl();
  // Reset the repo to its seed state (mock/browser only).
  control.gitReset = () => {
    mockGit = seedGitState();
    mockHunkState.clear();
    mockGitCommits.length = 0;
    mockGitignored.clear();
    mockGitArchived.clear();
    control.gitArchived = [];
  };
  // Recorded commits, so tests can assert the message that was committed.
  control.gitCommits = mockGitCommits;
  control.gitArchived = [];
  // Simulate an edit made outside the app (e.g. another process): add a
  // modified file to the working tree and fire the watcher change so the
  // SCM store re-fetches, exactly as the real filesystem watcher would.
  control.gitExternalModify = (path: string) => {
    if (
      !mockGit.changes.some((e) => e.path === path) &&
      !mockGit.staged.some((e) => e.path === path)
    ) {
      mockGit.changes.push({ path, old_path: null, status: "Modified" as GitStatusCode });
    }
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  // Simulate the working tree becoming clean (all sections empty) as it would
  // after committing/discarding everything, then fire the watcher change.
  control.gitSetClean = () => {
    mockGit.staged = [];
    mockGit.changes = [];
    mockGit.untracked = [];
    mockGit.merge = [];
    mockGit.op_state = "clean";
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  // Put the mock repo into an in-progress merge with one conflicted file, then
  // fire the watcher change so the SCM panel refreshes into the banner state.
  // Drives the merge-conflict E2E flow.
  control.gitStartMergeConflict = () => {
    mockGit.op_state = "merge";
    if (!mockGit.merge.some((e) => e.path === "src/constants.ts")) {
      mockGit.merge.push({ path: "src/constants.ts", old_path: null, status: "Conflicted" });
    }
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  control.gitState = () => mockGit;
}

// ----- Deterministic commit graph for git_log / git_refs mocks (#57) -----

interface MockCommit {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  author_email: string;
  author_time: number;
  summary: string;
  stash?: string;
}

/**
 * A single, unbroken, far-wider-than-the-panel path, used by commit 11's
 * changed-file list (#500). Deliberately has no separator in its final
 * segment, so a fix that only relies on breaking at `/` still overflows.
 */
export const MOCK_LONG_COMMIT_FILE_PATH =
  "src/lib/components/experimental/deeply/nested/generated/" +
  "AnExtremelyLongGeneratedComponentFileNameThatOverflowsThePanel.svelte";

// Newest-first, topologically ordered. 12 commits, a feature branch (#9,#10)
// merged into main at #12, and tags on #1 and #5. Parents reference lower
// numbers, so the array is a valid topological linearization.
const GRAPH_BASE_TIME = Math.floor(Date.UTC(2024, 5, 1, 9, 0, 0) / 1000);

let mockCommitGraphCache: MockCommit[] | null = null;
export function mockCommitGraph(): MockCommit[] {
  if (mockCommitGraphCache) return mockCommitGraphCache;
  mockCommitGraphCache = MOCK_GRAPH_SPEC.map((c, i) => ({
    oid: fullOid(c.n),
    short_oid: fullOid(c.n).slice(0, 7),
    parents: c.parents.map(fullOid),
    author_name: c.n % 3 === 0 ? "Bob Dev" : "Alice Coder",
    author_email: c.n % 3 === 0 ? "bob@example.com" : "12345+octocat@users.noreply.github.com",
    // The newest three commits are "today" (minutes/hours old) so the
    // graph's relative-time wording is exercised (#389); older commits get
    // fixed historical timestamps.
    author_time:
      i < 3 ? Math.floor(Date.now() / 1000) - [30, 5 * 60, 5 * 3600][i] : GRAPH_BASE_TIME - i * 3600,
    summary: c.summary,
    ...(c.stash ? { stash: c.stash } : {}),
  }));
  // The stash entry sits right before its base commit, like the backend weave.
  const stashIdx = mockCommitGraphCache.findIndex((c) => (c as { stash?: string }).stash);
  if (stashIdx > 0) {
    const [stashRow] = mockCommitGraphCache.splice(stashIdx, 1);
    const basePos = mockCommitGraphCache.findIndex((c) => c.oid === stashRow.parents[0]);
    mockCommitGraphCache.splice(Math.max(0, basePos), 0, stashRow);
  }
  return mockCommitGraphCache;
}

type MockRefKind = "LocalBranch" | "RemoteBranch" | "Tag" | "Head";

/** OID the HEAD ref currently decorates (mock working state). */
export function mockHeadOid(): string {
  for (const [oid, list] of Object.entries(MOCK_GRAPH_REFS)) {
    if (list.some((r) => r.kind === "Head")) return oid;
  }
  return fullOid(12);
}

// ----- Synthetic high-load commit graph generator (load stress suite) -----
//
// For synthetic load-repos, git_log/git_refs serve a deterministic history of
// N commits (N from the `mockGitCommits` URL query, default 300). The topology
// is a main spine with periodic 2-commit feature branches that merge back, so
// the graph has real branch/merge edges — not a flat line. Everything is
// derived from index arithmetic (no Math.random), and each repo's tip summary
// embeds its index so tests can assert the correct repo's graph is shown.

/** Commit count for synthetic repos: `?mockGitCommits=`, default 300, capped. */
export function loadRepoCommitCount(): number {
  if (typeof location === "undefined") return 300;
  const raw = new URLSearchParams(location.search).get("mockGitCommits");
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20000) : 300;
}

/** Deterministic unique 40-char hex OID for synthetic commit number i (>= 1).
 *  8 hex digits (up to ~4.29e9) repeated to fill 40 chars. */
function loadOid(i: number): string {
  return i.toString(16).padStart(8, "0").repeat(5);
}

const LOAD_AUTHORS = ["Alice Coder", "Bob Dev", "Carol Maintainer"];
const LOAD_SUBJECTS = [
  "Refactor module boundaries",
  "Fix off-by-one in parser",
  "Add unit tests",
  "Update dependencies",
  "Improve error messages",
  "Tidy up logging",
  "Optimize hot path",
  "Document public API",
];

interface SyntheticGraph {
  /** Newest-first, topologically ordered (parents always have a lower number). */
  commits: MockCommit[];
  refs: Record<string, Array<{ name: string; kind: MockRefKind }>>;
}

const syntheticGraphCache = new Map<string, SyntheticGraph>();

function buildSyntheticGraph(repoIndex: number, n: number): SyntheticGraph {
  // Chronological pass (1..n). `mainTip` tracks the current main-branch head;
  // every 7th step spawns a 2-commit feature branch off it and merges back,
  // producing commits reachable only via a merge's second parent (real edges).
  const nodes: Array<{ i: number; parents: number[] }> = [];
  const featureTips: number[] = [];
  let mainTip = 0;
  let i = 1;
  while (i <= n) {
    if (i === 1) {
      nodes.push({ i, parents: [] });
      mainTip = 1;
      i++;
      continue;
    }
    if (i % 7 === 0 && i + 2 <= n) {
      const base = mainTip;
      nodes.push({ i, parents: [base] }); // feature commit 1
      nodes.push({ i: i + 1, parents: [i] }); // feature commit 2 (branch tip)
      nodes.push({ i: i + 2, parents: [base, i + 1] }); // merge back into main
      featureTips.push(i + 1);
      mainTip = i + 2;
      i += 3;
    } else {
      nodes.push({ i, parents: [mainTip] });
      mainTip = i;
      i++;
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Newest-first: sort by number descending. Parents (lower numbers) then sit
  // deeper in the array — the topological order git_log/graph layout expects.
  const commits: MockCommit[] = [...nodes]
    .sort((a, b) => b.i - a.i)
    .map((node) => {
      const isMerge = node.parents.length > 1;
      const summary =
        node.i === mainTip
          ? `Release build ${n} [load-repo-${repoIndex}]`
          : isMerge
            ? `Merge feature branch (#${node.i})`
            : `${LOAD_SUBJECTS[node.i % LOAD_SUBJECTS.length]} (#${node.i})`;
      const a = node.i % LOAD_AUTHORS.length;
      return {
        oid: loadOid(node.i),
        short_oid: loadOid(node.i).slice(0, 7),
        parents: node.parents.map(loadOid),
        author_name: LOAD_AUTHORS[a],
        author_email: `${LOAD_AUTHORS[a].split(" ")[0].toLowerCase()}@example.com`,
        // Newest commit ~now, one minute apart going back — deterministic.
        author_time: nowSec - (n - node.i) * 60,
        summary,
      };
    });

  const refs: SyntheticGraph["refs"] = {};
  refs[loadOid(mainTip)] = [
    { name: "HEAD", kind: "Head" },
    { name: "main", kind: "LocalBranch" },
    { name: "origin/main", kind: "RemoteBranch" },
  ];
  // Decorate the most recent few feature tips so the graph has extra chips.
  featureTips.slice(-3).forEach((tip, k) => {
    (refs[loadOid(tip)] ??= []).push({ name: `feature-${k + 1}`, kind: "LocalBranch" });
  });
  // A couple of tags on older commits.
  if (n >= 4) (refs[loadOid(Math.max(1, Math.floor(n / 4)))] ??= []).push({ name: "v1.0", kind: "Tag" });
  (refs[loadOid(1)] ??= []).push({ name: "v0.1", kind: "Tag" });

  return { commits, refs };
}

export function getSyntheticGraph(repoIndex: number, n: number): SyntheticGraph {
  const key = `${repoIndex}|${n}`;
  let g = syntheticGraphCache.get(key);
  if (!g) {
    g = buildSyntheticGraph(repoIndex, n);
    syntheticGraphCache.set(key, g);
  }
  return g;
}

/** git_refs payload for a synthetic repo (mirrors its graph decorations). */
export function syntheticRefs(repoIndex: number, n: number) {
  const g = getSyntheticGraph(repoIndex, n);
  const local: Array<{ name: string; target: string }> = [];
  const remote: Array<{ name: string; target: string }> = [];
  const tags: Array<{ name: string; target: string }> = [];
  let head: string | null = null;
  for (const [oid, list] of Object.entries(g.refs)) {
    for (const r of list) {
      if (r.kind === "Head") head = oid;
      else if (r.kind === "LocalBranch") local.push({ name: r.name, target: oid });
      else if (r.kind === "RemoteBranch") remote.push({ name: r.name, target: oid });
      else if (r.kind === "Tag") tags.push({ name: r.name, target: oid });
    }
  }
  return {
    local_branches: local,
    remote_branches: remote,
    tags,
    head,
    head_branch: "main",
    detached: false,
  };
}

/** Resolve a checkout/merge target (branch/tag name or full OID) to an OID. */
export function mockResolveTarget(target: string): string | null {
  // A 40-hex OID that exists in the graph.
  if (mockCommitGraph().some((c) => c.oid === target)) return target;
  for (const [oid, list] of Object.entries(MOCK_GRAPH_REFS)) {
    if (list.some((r) => r.name === target && r.kind !== "Head")) return oid;
  }
  return null;
}

/** Move a named ref of a given kind to `oid` (removing its old location). */
export function mockMoveRef(name: string, kind: MockRefKind, oid: string): void {
  for (const key of Object.keys(MOCK_GRAPH_REFS)) {
    MOCK_GRAPH_REFS[key] = MOCK_GRAPH_REFS[key].filter(
      (r) => !(r.name === name && r.kind === kind),
    );
    if (MOCK_GRAPH_REFS[key].length === 0) delete MOCK_GRAPH_REFS[key];
  }
  (MOCK_GRAPH_REFS[oid] ??= []).push({ name, kind });
}

/** Add a ref at `oid` (no move — used by create branch/tag). */
export function mockAddRef(name: string, kind: MockRefKind, oid: string): void {
  (MOCK_GRAPH_REFS[oid] ??= []).push({ name, kind });
}

export function mockFindRef(name: string, kind: MockRefKind): string | null {
  for (const [oid, refs] of Object.entries(MOCK_GRAPH_REFS)) {
    if (refs.some((ref) => ref.name === name && ref.kind === kind)) return oid;
  }
  return null;
}

export function mockRemoveRef(name: string, kind: MockRefKind): string | null {
  const oid = mockFindRef(name, kind);
  if (!oid) return null;
  MOCK_GRAPH_REFS[oid] = MOCK_GRAPH_REFS[oid].filter(
    (ref) => ref.name !== name || ref.kind !== kind,
  );
  if (MOCK_GRAPH_REFS[oid].length === 0) delete MOCK_GRAPH_REFS[oid];
  return oid;
}

/** Point HEAD (and, when checking out a branch, follow it) at `oid`. Leaves
 *  the attached/detached mode alone — committing or resetting while detached
 *  keeps HEAD detached, exactly like git. */
export function mockMoveHead(oid: string): void {
  mockMoveRef("HEAD", "Head", oid);
}

/** True while the mock repo's HEAD points straight at a commit rather than a
 *  branch (#524). Flipped only by the checkout mocks, mirroring git. */
export let mockDetached = false;

/** Check out `oid`. `branch` is the local branch HEAD follows, or null for a
 *  detached checkout (a raw OID, a tag, or a remote-tracking branch). */
export function mockCheckout(oid: string, branch: string | null): void {
  mockDetached = branch === null;
  mockMoveHead(oid);
}

/** Is `name` a local branch in the mock graph? */
export function mockIsLocalBranch(name: string): boolean {
  return Object.values(MOCK_GRAPH_REFS).some((list) =>
    list.some((r) => r.name === name && r.kind === "LocalBranch"),
  );
}

/** Append a synthetic commit onto the current HEAD and advance main + HEAD to
 *  it. Used by cherry-pick/revert/merge/rebase mocks so E2E sees history move. */
export function mockAppendCommit(summary: string): string {
  const graph = mockCommitGraph();
  const head = mockHeadOid();
  const n = 200 + graph.length; // avoid colliding with the 1..12 base OIDs
  const oid = fullOid(n);
  graph.unshift({
    oid,
    short_oid: oid.slice(0, 7),
    parents: [head],
    author_name: "Alice Coder",
    author_email: "alice@example.com",
    author_time: GRAPH_BASE_TIME + graph.length * 3600,
    summary,
  });
  // Advance whatever local branch HEAD was on (default: main), then HEAD.
  // While detached, HEAD moves alone — no branch follows it, like git (#524).
  if (!mockDetached) {
    const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
    mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
  }
  mockMoveHead(oid);
  return oid;
}
