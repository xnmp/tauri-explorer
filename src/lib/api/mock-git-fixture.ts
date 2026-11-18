/**
 * Fixture repositories for the browser mock backend: any repository a
 * fixture world installs (`setMockFixtureRepos`) is served from its own
 * commit list, per-commit files and diffs, at its own path. Commands about a
 * path outside every fixture repository fall through to the built-in mock
 * repository (`/home/user/Documents/project`) unchanged, so the browser suite
 * is unaffected while no fixture repository is installed.
 *
 * Fixture repositories are read-only: history and status queries answer from
 * the fixture, and every other git command about them is refused by default.
 */
import {
  compareDemoCommits,
  demoMergeBase,
  queryDemoLog,
  type DemoLogOptions,
  type DemoRepo,
} from "$lib/domain/demo-fixture-git";
import { STALE_CURSOR_KIND } from "./git-log";
import type { CommandHandler } from "./mock-dispatch";

let fixtureRepos: readonly DemoRepo[] = [];

/** Replace the installed fixture repositories (empty: built-in mock only). */
export function setMockFixtureRepos(repos: readonly DemoRepo[]): void {
  fixtureRepos = [...repos].sort((a, b) => b.root.length - a.root.length);
}

export const getMockFixtureRepos = (): readonly DemoRepo[] => fixtureRepos;

/** The innermost fixture repository containing `path`, or null. */
export function fixtureRepoFor(path: unknown): DemoRepo | null {
  if (typeof path !== "string" || fixtureRepos.length === 0) return null;
  return fixtureRepos.find((repo) => path === repo.root || path.startsWith(`${repo.root}/`)) ?? null;
}

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

function statusSummary(repo: DemoRepo) {
  const entry = (c: DemoRepo["changes"][number]) => ({ path: c.path, old_path: null, status: c.status });
  return {
    is_repo: true,
    repo_root: repo.root,
    branch: repo.branch,
    detached: false,
    staged: [],
    changes: repo.changes.filter((c) => c.status !== "Untracked").map(entry),
    untracked: repo.changes.filter((c) => c.status === "Untracked").map(entry),
    merge: [],
    op_state: "clean",
  };
}

/** `get_git_status`: per-name status of `dir`'s direct children. */
function directoryStatuses(repo: DemoRepo, dir: string): Record<string, string> {
  const prefix = relativeTo(repo.root, dir);
  const statuses: Record<string, string> = {};
  for (const change of repo.changes) {
    if (prefix && !change.path.startsWith(`${prefix}/`)) continue;
    const rest = prefix ? change.path.slice(prefix.length + 1) : change.path;
    const [first, ...deeper] = rest.split("/");
    statuses[first] = deeper.length ? "Modified" : change.status;
  }
  return statuses;
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

const QUERIES: Record<string, FixtureHandler> = {
  get_git_status: (repo, args) => ({ is_git_repo: true, statuses: directoryStatuses(repo, String(args.path)) }),
  git_repo_root: (repo) => repo.root,
  git_directory_scope: (repo, args) => ({ repo_root: repo.root, relative_directory: relativeTo(repo.root, String(args.path)) }),
  git_status: (repo) => statusSummary(repo),
  git_diff: () => "",
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
    const query = QUERIES[name];
    if (query) {
      routed[name] = (args) => {
        const repo = fixtureRepoFor(repoArgument(args));
        return repo ? query(repo, args) : fallback(args);
      };
    } else if (name.startsWith("git_") && !PASSTHROUGH.has(name)) {
      routed[name] = (args) => {
        if (fixtureRepoFor(repoArgument(args))) throw readOnly();
        return fallback(args);
      };
    }
  }
  return routed;
}
