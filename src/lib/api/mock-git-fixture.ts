/**
 * Fixture repositories for the browser mock backend: any repository a
 * fixture world installs (`setMockFixtureRepos`) is served from its own
 * commit list, per-commit files and diffs, at its own path. Commands about a
 * path outside every fixture repository fall through to the built-in mock
 * repository (`/home/user/Documents/project`) unchanged, so the browser suite
 * is unaffected while no fixture repository is installed.
 *
 * Each fixture repository is a live, in-memory git repository over the mock
 * filesystem (`domain/demo-repo-worktree.ts`): HEAD and the index are seeded
 * from the fixture's `changes`, the working tree is whatever the mock
 * filesystem holds now, so files created, edited, renamed or deleted through
 * the app or the demo terminal show up in status. Stage, unstage, hunk patches,
 * discard and commit work; every other mutating git command (branch switch,
 * merge, push...) is refused as read-only. All of it resets on reload.
 */
import {
  compareDemoCommits,
  demoMergeBase,
  queryDemoLog,
  type DemoLogOptions,
  type DemoRepo,
} from "$lib/domain/demo-fixture-git";
import {
  applyDemoPatch,
  binaryBlob,
  commitDemoRepo,
  demoBadgeStatuses,
  demoStatus,
  demoUnifiedDiff,
  discardPaths,
  seedIndexState,
  stagePaths,
  statusChanges,
  unstagePaths,
  withGitignoreEntry,
  type DemoIndexState,
  type DemoTree,
} from "$lib/domain/demo-repo-worktree";
import { parentDir } from "$lib/domain/path";
import { broadcastFileChange } from "$lib/state/file-events";
import { emitWatcherGitChange } from "$lib/state/git-refresh";
import { STALE_CURSOR_KIND } from "./git-log";
import { invokeMockCommand, type CommandHandler } from "./mock-dispatch";
import { mockWrittenFiles } from "./mock-file-texts";
import { mockFileContent, mockFiles } from "./mock-fixtures";
import { onMockFsChange } from "./mock-fs-changes";

/** One fixture repository: its history plus HEAD/index trees. */
interface LiveRepo {
  repo: DemoRepo;
  state: DemoIndexState;
}

/** Innermost first, so a nested repository wins over the one containing it. */
let liveRepos: LiveRepo[] = [];

const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

/** The working tree of `root` as the mock filesystem holds it now. */
function readWorktree(root: string): DemoTree {
  const nested = liveRepos.map((r) => r.repo.root).filter((other) => other !== root && inside(root, other));
  const tree = new Map<string, string>();
  for (const [dir, entries] of Object.entries(mockFiles)) {
    if (!inside(root, dir) || nested.some((other) => inside(other, dir))) continue;
    for (const entry of entries) {
      if (entry.kind !== "file" || !inside(root, entry.path)) continue;
      const relative = entry.path.slice(root.length + 1);
      if (relative.split("/").includes(".git")) continue;
      const text = mockWrittenFiles[entry.path] ?? mockFileContent[entry.path];
      // An empty file has empty text, not a binary signature.
      tree.set(relative, text ?? (entry.size ? binaryBlob(entry.size, String(entry.modified ?? "")) : ""));
    }
  }
  return tree;
}

/** The repository as git would describe it now: history plus live status. */
function currentRepo(live: LiveRepo): DemoRepo {
  return { ...live.repo, changes: statusChanges(demoStatus(live.state, readWorktree(live.repo.root))) };
}

/** Replace the installed fixture repositories (empty: built-in mock only). */
export function setMockFixtureRepos(repos: readonly DemoRepo[]): void {
  liveRepos = [...repos]
    .sort((a, b) => b.root.length - a.root.length)
    .map((repo) => ({ repo, state: { head: new Map(), index: new Map() } }));
  // Seed after every root is known, so nested repositories stay out of their parent's tree.
  for (const live of liveRepos) live.state = seedIndexState(readWorktree(live.repo.root), live.repo.changes);
}

/** Capture the installed repositories exactly (history, HEAD and index); the returned function puts them back. */
export function snapshotMockFixtureRepos(): () => void {
  const saved = liveRepos.map((live) => ({ ...live }));
  return () => { liveRepos = saved.map((live) => ({ ...live })); };
}

/** The installed repositories, each with its current history and status. */
export const getMockFixtureRepos = (): readonly DemoRepo[] => liveRepos.map(currentRepo);

function liveRepoFor(path: unknown): LiveRepo | null {
  if (typeof path !== "string" || liveRepos.length === 0) return null;
  return liveRepos.find((live) => inside(live.repo.root, path)) ?? null;
}

/** The innermost fixture repository containing `path`, with its current status, or null. */
export function fixtureRepoFor(path: unknown): DemoRepo | null {
  const live = liveRepoFor(path);
  return live ? currentRepo(live) : null;
}

/**
 * Tell git observers that `root` changed, as the native repository watcher
 * does for any write under it, `.git` included: the Source Control panel, the
 * folder badges and an open git graph all reload from it. Coalesced per
 * root, after the change completes.
 */
const pendingRoots = new Set<string>();
function announceRepoChange(live: LiveRepo): void {
  const root = live.repo.root;
  if (pendingRoots.has(root)) return;
  pendingRoots.add(root);
  setTimeout(() => {
    pendingRoots.delete(root);
    emitWatcherGitChange(live.repo.root);
  }, 0);
}

onMockFsChange(({ op, path, from }) => {
  // A renamed or moved folder takes the repositories inside it along.
  if (from && (op === "rename" || op === "move")) {
    let moved = false;
    for (const live of liveRepos) {
      if (!inside(from, live.repo.root)) continue;
      live.repo = { ...live.repo, root: path + live.repo.root.slice(from.length) };
      moved = true;
    }
    if (moved) liveRepos.sort((a, b) => b.repo.root.length - a.repo.root.length);
  }
  for (const changed of [path, from]) {
    const live = liveRepoFor(changed);
    if (live) announceRepoChange(live);
  }
});

const readOnly = () => ({ kind: "other", message: "This demo repository is read-only" });
const relativeTo = (root: string, path: string) => (path === root ? "" : path.slice(root.length + 1));

function commitOf(repo: DemoRepo, oid: unknown) {
  const commit = repo.commits.find((c) => c.oid === oid);
  if (!commit) throw { kind: "not_found", message: `commit ${String(oid)} is not in this repository` };
  return commit;
}

function refTarget(repo: DemoRepo, fullName: unknown): string | null {
  for (const [oid, list] of Object.entries(repo.refs)) {
    for (const ref of list) {
      const full = ref.kind === "RemoteBranch" ? `refs/remotes/${ref.name}`
        : ref.kind === "LocalBranch" ? `refs/heads/${ref.name}` : null;
      if (full === fullName || ref.name === fullName) return oid;
    }
  }
  return null;
}

function statusSummary(live: LiveRepo) {
  const { staged, changes, untracked } = demoStatus(live.state, readWorktree(live.repo.root));
  return {
    is_repo: true,
    repo_root: live.repo.root,
    branch: live.repo.branch,
    detached: false,
    staged,
    changes,
    untracked,
    merge: [],
    op_state: "clean",
  };
}

const pathsArgument = (args: Record<string, unknown>): string[] =>
  Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];

/** `git_diff`: the index against HEAD (staged) or the working tree against the index. */
function fileDiff(live: LiveRepo, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const staged = Boolean((args.options as { staged?: boolean } | null)?.staged);
  const { head, index } = live.state;
  return staged
    ? demoUnifiedDiff(path, head.get(path), index.get(path))
    : demoUnifiedDiff(path, index.get(path), readWorktree(live.repo.root).get(path));
}

const patchTarget = (patch: string) =>
  /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^--- a\/(.+)$/m.exec(patch)?.[1] ?? null;
const isText = (blob: string | undefined) => blob === undefined || !blob.startsWith("\0");

/** `git_apply_patch`: one file's hunks, applied to the index (stage, unstage) or the working tree (discard). */
async function applyPatch(live: LiveRepo, args: Record<string, unknown>): Promise<null> {
  const patch = String(args.patch ?? "");
  const path = patchTarget(patch);
  if (!path) throw new Error("patch is missing its target path");
  const { head, index } = live.state;
  const work = readWorktree(live.repo.root);
  const next = new Map(index);
  const put = (tree: Map<string, string>, text: string | undefined) => {
    if (text === undefined) tree.delete(path);
    else tree.set(path, text);
  };
  if (args.action === "stage") {
    const current = index.get(path);
    put(next, isText(current) ? applyDemoPatch(current ?? "", patch, false) : work.get(path));
    // A hunk that empties a deleted file stages the deletion itself.
    if (work.get(path) === undefined && next.get(path) === "") next.delete(path);
  } else if (args.action === "unstage") {
    const current = index.get(path);
    put(next, isText(current) && current !== undefined ? applyDemoPatch(current, patch, true) : head.get(path));
    if (head.get(path) === undefined && next.get(path) === "") next.delete(path);
  } else if (args.action === "discard") {
    const current = work.get(path);
    if (current === undefined || !isText(current)) throw new Error(`cannot discard part of '${path}'`);
    const absolute = `${live.repo.root}/${path}`;
    await invokeMockCommand("write_text_file", { path: absolute, content: applyDemoPatch(current, patch, true) });
    // Open folders refresh as they would from the native filesystem watcher.
    broadcastFileChange([parentDir(absolute)]);
    return null;
  } else {
    throw new Error(`unknown patch action ${String(args.action)}`);
  }
  live.state = { ...live.state, index: next };
  return null;
}

/** `git_discard`: restore tracked files from HEAD and remove untracked ones, through the mock filesystem. */
async function discard(live: LiveRepo, args: Record<string, unknown>): Promise<null> {
  const force = Boolean((args.options as { force?: boolean } | null)?.force);
  const { state, writes } = discardPaths(live.state, readWorktree(live.repo.root), pathsArgument(args), force);
  live.state = state;
  const absolute = (path: string) => `${live.repo.root}/${path}`;
  const removed = writes.filter((w) => w.text === null).map((w) => absolute(w.path));
  for (const write of writes) {
    if (write.text !== null) await invokeMockCommand("write_text_file", { path: absolute(write.path), content: write.text });
  }
  if (removed.length) await invokeMockCommand("delete_entries", { paths: removed, permanent: true });
  // Open folders refresh as they would from the native filesystem watcher.
  broadcastFileChange([...new Set(writes.map((w) => parentDir(absolute(w.path))))]);
  return null;
}

/** `git_trash_untracked`: untracked files go to the Recycle Bin. */
async function trashUntracked(live: LiveRepo, args: Record<string, unknown>): Promise<null> {
  const paths = pathsArgument(args);
  const untracked = new Set(demoStatus(live.state, readWorktree(live.repo.root)).untracked.map((e) => e.path));
  if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !untracked.has(path))) {
    throw new Error("refusing to operate on non-untracked path");
  }
  const absolute = paths.map((path) => `${live.repo.root}/${path}`);
  await invokeMockCommand("delete_entries", { paths: absolute, permanent: false });
  broadcastFileChange([...new Set(absolute.map(parentDir))]);
  return null;
}

/** `git_add_to_gitignore`: append the entry to the repository's root `.gitignore`. */
async function addToGitignore(live: LiveRepo, args: Record<string, unknown>): Promise<string> {
  const entry = String(args.entry ?? "").replace(/^\.\//, "").replace(/^\//, "");
  if (!entry) throw new Error("gitignore entry is empty");
  const path = `${live.repo.root}/.gitignore`;
  const current = readWorktree(live.repo.root).get(".gitignore");
  const next = withGitignoreEntry(current?.startsWith("\0") ? undefined : current, entry);
  if (next !== current) {
    await invokeMockCommand("write_text_file", { path, content: next });
    broadcastFileChange([live.repo.root]);
  }
  return entry;
}

function commit(live: LiveRepo, args: Record<string, unknown>) {
  const amend = Boolean((args.options as { amend?: boolean } | null)?.amend);
  const result = commitDemoRepo(live.repo, live.state, { message: String(args.message ?? ""), amend, now: Date.now() });
  live.repo = result.repo;
  live.state = result.state;
  return { commit_id: result.commit.oid, summary: result.commit.summary };
}

function refsPayload(repo: DemoRepo) {
  const out = { local_branches: [] as { name: string; target: string }[], remote_branches: [] as { name: string; target: string }[], tags: [] as { name: string; target: string }[] };
  for (const [target, list] of Object.entries(repo.refs)) {
    for (const ref of list) {
      if (ref.kind === "LocalBranch") out.local_branches.push({ name: ref.name, target });
      else if (ref.kind === "RemoteBranch") out.remote_branches.push({ name: ref.name, target });
      else if (ref.kind === "Tag") out.tags.push({ name: ref.name, target });
    }
  }
  return { ...out, head: repo.head, head_branch: repo.branch, detached: false };
}

type FixtureHandler = (repo: DemoRepo, args: Record<string, unknown>) => unknown;
type WorktreeHandler = (live: LiveRepo, args: Record<string, unknown>) => unknown;

/** Commands that read or change the index and working tree. */
const WORKTREE: Record<string, WorktreeHandler> = {
  get_git_status: (live, args) => ({
    is_git_repo: true,
    statuses: demoBadgeStatuses(demoStatus(live.state, readWorktree(live.repo.root)), relativeTo(live.repo.root, String(args.path))),
  }),
  git_status: (live) => statusSummary(live),
  git_diff: fileDiff,
  git_stage: (live, args) => {
    live.state = stagePaths(live.state, readWorktree(live.repo.root), pathsArgument(args));
    return null;
  },
  git_unstage: (live, args) => {
    live.state = unstagePaths(live.state, pathsArgument(args));
    return null;
  },
  git_apply_patch: applyPatch,
  git_discard: discard,
  git_commit: commit,
  git_trash_untracked: trashUntracked,
  git_add_to_gitignore: addToGitignore,
};

/** The worktree commands that write the index, the history or files. */
const MUTATIONS = new Set([
  "git_stage", "git_unstage", "git_apply_patch", "git_discard", "git_commit", "git_trash_untracked", "git_add_to_gitignore",
]);

/** History queries, answered from the repository's commits. */
const QUERIES: Record<string, FixtureHandler> = {
  git_repo_root: (repo) => repo.root,
  git_directory_scope: (repo, args) => ({ repo_root: repo.root, relative_directory: relativeTo(repo.root, String(args.path)) }),
  git_log: (repo, args) => {
    const page = queryDemoLog(repo, (args.options as DemoLogOptions | null) ?? {});
    if (page.staleCursor) throw { kind: STALE_CURSOR_KIND, message: "git log cursor is not in the current history" };
    return {
      commits: page.commits,
      refs: repo.refs,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      head_branch: repo.branch,
      detached: false,
    };
  },
  git_refs: (repo) => refsPayload(repo),
  git_commit_files: (repo, args) => commitOf(repo, args.oid).files.map(({ path, status }) => ({ path, status })),
  git_commit_file_diff: (repo, args) => commitOf(repo, args.oid).files.find((f) => f.path === args.filePath)?.diff ?? "",
  git_compare_commit_files: (repo, args) =>
    compareDemoCommits(repo, String(args.baseOid), String(args.targetOid)).map(({ path, status }) => ({ path, status })),
  git_compare_commit_file_diff: (repo, args) =>
    compareDemoCommits(repo, String(args.baseOid), String(args.targetOid)).find((f) => f.path === args.filePath)?.diff ?? "",
  git_merge_base: (repo, args) => {
    const first = refTarget(repo, args.firstRef);
    const second = refTarget(repo, args.secondRef);
    if (!first || !second) throw new Error("Branch not found");
    return demoMergeBase(repo, first, second);
  },
  git_branch_authors: (repo) => Object.entries(repo.refs).flatMap(([oid, list]) => list
    .filter((r) => r.kind === "LocalBranch" || r.kind === "RemoteBranch")
    .map((r) => ({ name: r.name, author: repo.commits.find((c) => c.oid === oid)?.author_name ?? "", remote: r.kind === "RemoteBranch" }))),
  git_branch_statuses: (repo) => ({ trunk: repo.branch, statuses: [] }),
  git_branch_behind_upstream: () => null,
  git_pr_context: (repo) => ({ repoSlug: "", headBranch: repo.branch }),
  git_open_prs: () => [],
  git_failed_ci_checks: () => [],
  git_issues_url: () => null,
};

/**
 * Git commands that may still reach the built-in handler for a fixture
 * repository: they register or read nothing about it. Every other `git_*`
 * command about a fixture repository that is not a fixture query is refused,
 * so a command added later is read-only for fixtures until someone decides
 * otherwise.
 */
const PASSTHROUGH = new Set(["git_watch_repo", "git_unwatch_repo", "git_author_avatar", "git_failed_ci_check_log"]);

const repoArgument = (args: Record<string, unknown>) => args.repoPath ?? args.repoRoot ?? args.path;

/**
 * Route git commands about a fixture repository to the fixture; leave every
 * other call to the built-in handler it wraps.
 */
export function withFixtureRepos(commands: Record<string, CommandHandler>): Record<string, CommandHandler> {
  const routed: Record<string, CommandHandler> = { ...commands };
  for (const [name, fallback] of Object.entries(commands)) {
    const worktree = WORKTREE[name];
    const query = QUERIES[name];
    if (worktree) {
      routed[name] = (args) => {
        const live = liveRepoFor(repoArgument(args));
        if (!live) return fallback(args);
        if (!MUTATIONS.has(name)) return worktree(live, args);
        // What the native watcher reports after git writes the index or a commit.
        return Promise.resolve(worktree(live, args)).finally(() => announceRepoChange(live));
      };
    } else if (query) {
      routed[name] = (args) => {
        const live = liveRepoFor(repoArgument(args));
        return live ? query(live.repo, args) : fallback(args);
      };
    } else if (name.startsWith("git_") && !PASSTHROUGH.has(name)) {
      routed[name] = (args) => {
        if (liveRepoFor(repoArgument(args))) throw readOnly();
        return fallback(args);
      };
    }
  }
  return routed;
}
