/**
 * Mock Git history commands: log, refs, branches/tags, checkout/merge/rebase/reset, undo,
 * commit comparisons and the GitHub PR/CI surfaces.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { OpenPr, PrAction } from "./git-log";
import { getMockControl } from "./mock-control";
import { daysAgo, MOCK_GRAPH_REFS } from "./mock-fixtures";
import type { CommandHandler } from "./mock-dispatch";
import { holdGitNetworkOperation } from "./mock-git";
import { getSyntheticGraph, loadRepoCommitCount, loadRepoIndex, MOCK_LONG_COMMIT_FILE_PATH, mockAddRef, mockAppendCommit, mockCheckout, mockCommitGraph, mockDetached, mockFindRef, mockHeadOid, mockIsLocalBranch, mockMoveHead, mockMoveRef, mockRemoveRef, mockResolveTarget, syntheticRefs } from "./mock-git-state";

let mockCreatedPr: OpenPr | null = null;
const mockMergedPrs = new Set<number>();
const mockApprovedPrs = new Set<number>();

export const gitHistoryCommands: Record<string, CommandHandler> = {

  git_commit_files: (args) => {
    const oid = args.oid as string;
    // Deterministic per-commit file list keyed off the mock graph's OIDs.
    const n = parseInt(oid.slice(0, 4), 16);
    if (Number.isNaN(n)) return [];
    if (n === 12) {
      return [
        { path: "src/feature-x.ts", status: "A" },
        { path: "src/index.ts", status: "M" },
      ];
    }
    // Commit 11 carries a deliberately over-long path so the changed-files
    // list's overflow behaviour is exercisable end-to-end (#500). No other
    // spec asserts on this commit's file list.
    if (n === 11) {
      return [{ path: MOCK_LONG_COMMIT_FILE_PATH, status: "M" }];
    }
    // A deliberately long list for the changed-files overflow contract (#510).
    // Keep the paths distinct and ordered so browser tests can scroll to the
    // final row rather than merely asserting an implementation detail.
    if (n === 10) {
      return Array.from({ length: 24 }, (_, index) => ({
        path: `src/generated/many-files/file-${String(index + 1).padStart(2, "0")}.ts`,
        status: index % 2 === 0 ? "M" : "A",
      }));
    }
    return [{ path: `src/file-${n}.ts`, status: n % 2 === 0 ? "M" : "A" }];
  },
  git_compare_commit_files: () => [
    { path: "src/compared.ts", status: "M" },
    { path: "src/introduced-in-comparison.ts", status: "A" },
  ],
  git_commit_file_diff: (args) => {
    // Deterministic tiny patch so E2E can assert the inline diff (#221).
    const filePath = args.filePath as string;
    return [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,3 +1,3 @@",
      " unchanged line",
      "-old line",
      "+new line",
      "",
    ].join("\n");
  },
  git_compare_commit_file_diff: (args) => {
    const filePath = args.filePath as string;
    const baseOid = args.baseOid as string;
    const targetOid = args.targetOid as string;
    return [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1 +1 @@",
      `-older ${baseOid.slice(0, 7)}`,
      `+newer ${targetOid.slice(0, 7)}`,
      "",
    ].join("\n");
  },
  // Mock: pretend 'hotfix' is 2 behind its remote so the pull offer shows.
  git_branch_behind_upstream: (args: Record<string, unknown>) =>
    args.name === "hotfix" ? 2 : args.name === "main" ? 0 : null,
  // Branch-status badges (#1081): none unless a spec sets
  // `__mockControl.branchStatuses`. Classification itself is proven by the
  // Rust temp-repo tests in git_branch_status.rs.
  git_branch_statuses: () => getMockControl().branchStatuses ?? { trunk: "main", statuses: [] },
  git_branch_authors: () => [
    { name: "main", author: "Alice Coder", remote: false },
    { name: "hotfix", author: "Alice Coder", remote: false },
    { name: "experiment", author: "Bob Dev", remote: false },
    { name: "feature", author: "Alice Coder", remote: false },
    { name: "origin/main", author: "Alice Coder", remote: true },
    { name: "origin/hotfix", author: "Alice Coder", remote: true },
    { name: "origin/legacy-import", author: "Bob Dev", remote: true },
  ],
  git_delete_branch: (args: Record<string, unknown>) => {
    const name = (args.name as string) ?? "";
    const target = mockRemoveRef(name, "LocalBranch");
    if (!target) throw new Error(`branch '${name}' does not exist`);
    return { kind: "branch_delete", name, target };
  },
  git_delete_tag: (args: Record<string, unknown>) => {
    const name = (args.name as string) ?? "";
    const target = mockRemoveRef(name, "Tag");
    if (!target) throw new Error(`tag '${name}' does not exist`);
    return { kind: "tag_delete", name, target };
  },
  git_rename_branch: (args: Record<string, unknown>) => {
    const old_name = (args.oldName as string) ?? "";
    const new_name = (args.newName as string) ?? "";
    const target = mockRemoveRef(old_name, "LocalBranch");
    if (!target) throw new Error(`branch '${old_name}' does not exist`);
    if (mockFindRef(new_name, "LocalBranch")) {
      mockAddRef(old_name, "LocalBranch", target);
      throw new Error(`branch '${new_name}' already exists`);
    }
    mockAddRef(new_name, "LocalBranch", target);
    return { kind: "branch_rename", old_name, new_name, target };
  },
  git_undo: (args: Record<string, unknown>) => {
    const action = args.action as {
      kind: string;
      name?: string;
      target?: string;
      old_name?: string;
      new_name?: string;
      branch?: string | null;
      before_oid?: string;
      after_oid?: string;
    };
    if (action.kind === "branch_delete") {
      if (mockFindRef(action.name!, "LocalBranch")) {
        throw new Error(`branch '${action.name}' already exists; undo is no longer safe`);
      }
      mockAddRef(action.name!, "LocalBranch", action.target!);
      return null;
    }
    if (action.kind === "tag_delete") {
      if (mockFindRef(action.name!, "Tag")) {
        throw new Error(`tag '${action.name}' already exists; undo is no longer safe`);
      }
      mockAddRef(action.name!, "Tag", action.target!);
      return null;
    }
    if (action.kind === "branch_rename") {
      if (
        mockFindRef(action.old_name!, "LocalBranch") ||
        mockFindRef(action.new_name!, "LocalBranch") !== action.target
      ) {
        throw new Error("branch state changed; undo is no longer safe");
      }
      mockRemoveRef(action.new_name!, "LocalBranch");
      mockAddRef(action.old_name!, "LocalBranch", action.target!);
      return null;
    }
    if (action.kind === "head_move") {
      if (mockHeadOid() !== action.after_oid) {
        throw new Error("HEAD moved since the operation; undo is no longer safe");
      }
      if (action.branch) mockMoveRef(action.branch, "LocalBranch", action.before_oid!);
      mockMoveHead(action.before_oid!);
      return null;
    }
    throw new Error("unknown git undo action");
  },
  git_delete_remote_branch: (args) =>
    holdGitNetworkOperation("git_delete_remote_branch", args),

  // Tracking checkout (#432): create a local branch tracking <remote>/<name>
  // at the remote branch's current tip, then move HEAD onto it.
  git_checkout_tracking: (args: Record<string, unknown>) => {
    const remote = (args.remote as string) ?? "";
    const name = ((args.name as string) ?? "").trim();
    if (name.length === 0) throw new Error("branch name must not be empty");
    // Already-existing local branch → plain checkout.
    const existing = mockResolveTarget(name);
    if (existing) {
      mockCheckout(existing, name);
      return null;
    }
    const oid = mockResolveTarget(`${remote}/${name}`);
    if (!oid) throw new Error(`no remote branch '${remote}/${name}'`);
    mockAddRef(name, "LocalBranch", oid);
    mockCheckout(oid, name);
    return null;
  },

  // F5-sync (#432): deterministic result so the divergence toast and the
  // fast-forward path can be exercised in E2E. Pretend `experiment` diverged
  // and `hotfix` fast-forwarded.
  git_sync_local_branches: () => ({
    fast_forwarded: ["hotfix"],
    diverged: ["experiment"],
    skipped: [],
  }),

  // ----- Git history / commit graph (#57) -----

  git_author_avatar: (args: Record<string, unknown>) => {
    localStorage.setItem("mock-avatar-lookups", String(Number(localStorage.getItem("mock-avatar-lookups") ?? "0") + 1));
    if (new URLSearchParams(location.search).get("mockAvatarFailure") === "1") return null;
    const email = String(args.email ?? "").toLowerCase();
    if (!email.endsWith("@users.noreply.github.com") && args.gravatarEnabled !== true) return null;
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='%232563eb'/%3E%3Ccircle cx='10' cy='8' r='4' fill='white'/%3E%3Cpath d='M3 20c1-6 13-6 14 0' fill='white'/%3E%3C/svg%3E";
  },

  git_log: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
    // Synthetic load-repo: deterministic N-commit history, paginated by
    // skip/cursor/limit exactly like the real backend.
    const loadIdx = loadRepoIndex(repoPath);
    if (loadIdx !== null) {
      const opts =
        (args.options as { skip?: number; limit?: number; cursor?: string } | null) ?? {};
      const all = getSyntheticGraph(loadIdx, loadRepoCommitCount()).commits;
      const skip = Math.max(0, opts.skip ?? 0);
      const limit = Math.max(1, opts.limit ?? 500);
      let start = skip;
      if (opts.cursor) {
        const idx = all.findIndex((c) => c.oid === opts.cursor);
        start = idx >= 0 ? idx + 1 : all.length; // unknown cursor → empty page
      }
      const page = all.slice(start, start + limit);
      const refs = getSyntheticGraph(loadIdx, loadRepoCommitCount()).refs;
      return {
        commits: page,
        refs,
        has_more: start + limit < all.length,
        next_cursor: page.length > 0 ? page[page.length - 1].oid : null,
        head_branch: "main",
        detached: false,
      };
    }
    if (!repoPath.startsWith("/home/user/Documents/project")) {
      return {
        commits: [],
        refs: {},
        has_more: false,
        next_cursor: null,
        head_branch: null,
        detached: false,
      };
    }
    const options =
      (args.options as {
        skip?: number;
        limit?: number;
        branches?: string[];
        exclude_branches?: string[];
        cursor?: string;
        file_path?: string;
      } | null) ?? {};
    const skip = Math.max(0, options.skip ?? 0);
    const limit = Math.max(1, options.limit ?? 500);

    let all = mockCommitGraph();
    // Branch filter (#342): mirror the backend's seeded revwalk — keep only
    // commits reachable from the selected branch tips; stash rows survive
    // only when their base commit does. An EMPTY selection seeds nothing and
    // yields no commits (#413), exactly like the backend.
    //
    // `exclude_branches` (#515) is subtractive and applies to BOTH seed sets:
    // with no selection the seeds are HEAD + every branch minus the excluded
    // ones, so dropping a remote-only branch never unseeds HEAD.
    const excluded = new Set(options.exclude_branches ?? []);
    if (options.branches || excluded.size > 0) {
      const tips = new Map<string, string>();
      for (const [oid, refList] of Object.entries(MOCK_GRAPH_REFS)) {
        for (const r of refList) {
          if (r.kind === "LocalBranch" || r.kind === "RemoteBranch") tips.set(r.name, oid);
        }
      }
      const seeds = options.branches ?? [...tips.keys()];
      const byOid = new Map(all.filter((c) => !("stash" in c)).map((c) => [c.oid, c]));
      const reachable = new Set<string>();
      const queue = seeds
        .filter((n) => !excluded.has(n))
        .map((n) => tips.get(n))
        .filter((o): o is string => o !== undefined);
      // HEAD is always seeded when there is no explicit selection.
      if (!options.branches) queue.push(mockHeadOid());
      while (queue.length > 0) {
        const oid = queue.pop()!;
        if (reachable.has(oid)) continue;
        reachable.add(oid);
        const c = byOid.get(oid);
        if (c) queue.push(...c.parents);
      }
      all = all.filter((c) =>
        "stash" in c ? reachable.has(c.parents[0]) : reachable.has(c.oid),
      );
    }
    if (options.file_path?.trim()) {
      const path = options.file_path.trim();
      all = all.filter((commit) => {
        if ("stash" in commit) return false;
        const n = parseInt(commit.oid.slice(0, 4), 16);
        if (n === 12) return path === "src/feature-x.ts" || path === "src/index.ts" || path === "src/index.css";
        if (n === 11) return path === MOCK_LONG_COMMIT_FILE_PATH;
        return path === `src/file-${n}.ts`;
      });
    }
    // Cursor resume (#431): mirror the backend — discard up to and including
    // the cursor OID (a real commit), then take `limit`. Falls back to `skip`
    // when no cursor is given (filtered queries).
    let start = skip;
    if (options.cursor) {
      const idx = all.findIndex((c) => !("stash" in c) && c.oid === options.cursor);
      start = idx >= 0 ? idx + 1 : all.length; // unknown cursor → empty page
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    // next_cursor is the last REAL commit (never a woven stash row).
    let nextCursor: string | null = null;
    for (let i = page.length - 1; i >= 0; i--) {
      if (!("stash" in page[i])) {
        nextCursor = page[i].oid;
        break;
      }
    }
    // Checked-out branch: the first local branch decorating HEAD's commit —
    // matches the convention used by the mutating mocks (#433 highlight).
    const headOid = mockHeadOid();
    // Detached HEAD has no symbolic target even when branches decorate the
    // same commit (#524).
    const headBranch = mockDetached
      ? null
      : ((MOCK_GRAPH_REFS[headOid] ?? []).find((r) => r.kind === "LocalBranch")?.name ?? null);
    // Test hook (like `latency`/`failures`): force `has_more` so the infinite-
    // scroll loading row (#433) is reachable/observable with a small history.
    const forceHasMore = getMockControl().graphForceHasMore === true;
    return {
      commits: page,
      refs: MOCK_GRAPH_REFS,
      has_more: hasMore || forceHasMore,
      next_cursor: nextCursor,
      head_branch: headBranch,
      detached: mockDetached,
    };
  },

  git_merge_base: (args: Record<string, unknown>) => {
    const resolve = (name: string) => Object.entries(MOCK_GRAPH_REFS).find(([, refs]) =>
      refs.some((ref) => `refs/${ref.kind === "RemoteBranch" ? "remotes" : "heads"}/${ref.name}` === name),
    )?.[0];
    const first = resolve(args.firstRef as string);
    const second = resolve(args.secondRef as string);
    if (!first || !second) throw new Error("Branch not found");
    const graph = mockCommitGraph();
    const ancestors = (tip: string) => {
      const seen = new Set<string>();
      const pending = [tip];
      while (pending.length) {
        const oid = pending.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        pending.push(...(graph.find((commit) => commit.oid === oid)?.parents ?? []));
      }
      return seen;
    };
    const left = ancestors(first);
    const right = ancestors(second);
    return graph.find((commit) => left.has(commit.oid) && right.has(commit.oid))?.oid ?? null;
  },

  git_refs: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
    const loadIdx = loadRepoIndex(repoPath);
    if (loadIdx !== null) {
      return syntheticRefs(loadIdx, loadRepoCommitCount());
    }
    if (!repoPath.startsWith("/home/user/Documents/project")) {
      return {
        local_branches: [],
        remote_branches: [],
        tags: [],
        head: null,
        head_branch: null,
        detached: false,
      };
    }
    // Tips mirror MOCK_GRAPH_REFS (the git_log decorations) so the branch
    // filter's list and the graph's chips can't drift (#342).
    const local_branches: Array<{ name: string; target: string }> = [];
    const remote_branches: Array<{ name: string; target: string }> = [];
    const tags: Array<{ name: string; target: string }> = [];
    for (const [target, refList] of Object.entries(MOCK_GRAPH_REFS)) {
      for (const ref of refList) {
        if (ref.kind === "LocalBranch") local_branches.push({ name: ref.name, target });
        else if (ref.kind === "RemoteBranch") remote_branches.push({ name: ref.name, target });
        else if (ref.kind === "Tag") tags.push({ name: ref.name, target });
      }
    }
    return {
      local_branches,
      remote_branches,
      tags,
      // HEAD tracks the mutating checkout mocks, so the refs payload agrees
      // with git_log's about the detached state (#524).
      head: mockHeadOid(),
      head_branch: mockDetached
        ? null
        : ((MOCK_GRAPH_REFS[mockHeadOid()] ?? []).find((r) => r.kind === "LocalBranch")?.name ??
          null),
      detached: mockDetached,
    };
  },

  // Open GitHub PRs (#448/#459): synthetic PRs on branches that exist in
  // MOCK_GRAPH_REFS so the graph's PR badges have something to render against
  // in e2e. #7 exercises a passing/approved/commented PR, #12 a failing draft
  // (draft styling wins over CI color), #15 the tokenless case (all status
  // fields null → plain purple badge, pending kept for label coverage).
  git_pr_context: () => ({ repoSlug: "mock/project", headBranch: mockDetached ? null : (MOCK_GRAPH_REFS[mockHeadOid()] ?? []).find(ref => ref.kind === "LocalBranch")?.name ?? null }),

  git_pr_action: (args: Record<string, unknown>) => {
    const request = args.request as PrAction;
    if (request.action === "create") {
      mockCreatedPr = { number: 99, title: request.title, headRef: request.headBranch, baseRef: request.base, htmlUrl: "https://github.com/mock/project/pull/99", draft: false, ciStatus: null, reviewDecision: null, commentCount: 0, body: request.body };
      return mockCreatedPr.htmlUrl;
    }
    if (request.action === "merge" && !new URLSearchParams(window.location.search).has("gitPrMergeQueued")) mockMergedPrs.add(request.prNumber);
    else if (request.action === "approve") mockApprovedPrs.add(request.prNumber);
    return "";
  },

  git_issues_url: (args: Record<string, unknown>) => {
    const repoRoot = (args.repoRoot as string) ?? "";
    return repoRoot.startsWith("/home/user/Documents/project")
      ? "https://github.com/mock/project/issues"
      : null;
  },

  git_open_prs: (args: Record<string, unknown>) => {
    const repoRoot = (args.repoRoot as string) ?? "";
    if (!repoRoot.startsWith("/home/user/Documents/project")) return [];
    // Isolated graph fixture for #527's browser regression test. It is opt-in
    // by URL so the shared default graph keeps its established PR topology.
    const baseUpdateFixture = new URLSearchParams(window.location.search).has(
      "gitGraphBaseUpdateFixture",
    );
    return [
      ...(baseUpdateFixture
        ? [{
            number: 27,
            title: "Keep release branch current",
            headRef: "release",
            baseRef: "hotfix",
            baseRemote: "origin",
            htmlUrl: "https://github.com/mock/project/pull/27",
            draft: false,
            ciStatus: null,
            reviewDecision: null,
            commentCount: null,
          }]
        : []),
      {
        number: 7,
        title: "Add feature X",
        headRef: "feature",
        htmlUrl: "https://github.com/mock/project/pull/7",
        draft: false,
        ciStatus: "success",
        reviewDecision: "approved",
        commentCount: 3,
        body:
          "Implements feature X end to end.\n\n" +
          "- Adds the domain logic and its unit tests\n" +
          "- Wires the new command through the IPC layer\n" +
          "- Updates the mock backend so the UI can be exercised offline",
        comments: [
          {
            author: "octocat",
            createdAt: daysAgo(150),
            body: "Nice work! Left a couple of small notes on the diff.",
          },
          {
            author: "reviewer-bot",
            createdAt: daysAgo(35),
            body: "CI is green. Approving once the naming nit is addressed.",
          },
          {
            author: null,
            createdAt: daysAgo(5),
            body: "Thanks for the review — pushed a fixup.",
          },
        ],
        reviewThreads: [
          {
            resolved: true,
            comments: [
              {
                author: "octocat",
                createdAt: daysAgo(120),
                body: "Please use the shared parser here.",
                path: "src/lib/parser.ts",
                line: 42,
              },
            ],
          },
          {
            resolved: false,
            comments: [
              {
                author: "reviewer-bot",
                createdAt: daysAgo(2),
                body: "Could this retain the previous error context?",
                path: "src/lib/parser.ts",
                line: 87,
              },
            ],
          },
        ],
      },
      {
        number: 12,
        title: "Experimental parser rewrite",
        headRef: "experiment",
        htmlUrl: "https://github.com/mock/project/pull/12",
        draft: true,
        ciStatus: "failure",
        reviewDecision: "changes_requested",
        commentCount: 0,
        // Draft PR with no description and no comments yet — exercises the
        // empty-body / zero-comment path.
        body: null,
        comments: [],
        reviewThreads: [],
      },
      {
        number: 15,
        title: "Hotfix login redirect",
        headRef: "hotfix",
        htmlUrl: "https://github.com/mock/project/pull/15",
        draft: false,
        ciStatus: "pending",
        reviewDecision: null,
        // Tokenless REST path: description present, comments count unknown.
        commentCount: null,
        body: "Restores the post-login redirect that regressed in 2.3.1.",
        comments: [],
        reviewThreads: null,
      },
      ...(mockCreatedPr ? [mockCreatedPr] : []),
    ].filter(pr => !mockMergedPrs.has(pr.number)).map(pr => mockApprovedPrs.has(pr.number) ? { ...pr, reviewDecision: "approved" } : pr);
  },

  git_failed_ci_checks: (args: Record<string, unknown>) => {
    if (args.prNumber !== 12) return [];
    return [{ name: "Unit tests", runId: 1201, jobId: 9001 }];
  },

  git_failed_ci_check_log: (args: Record<string, unknown>) => {
    const check = args.check as { name?: string; runId?: number; jobId?: number };
    if (check.runId !== 1201 || check.jobId !== 9001) throw new Error("Unknown CI check");
    return {
      checkName: check.name ?? "Unit tests",
      log: "tests/unit/parser.test.ts > parser rejects invalid input\nAssertionError: expected true to be false",
    };
  },

  // ----- Git graph mutating actions (VSCode Git Graph parity) -----

  git_checkout: (args: Record<string, unknown>) => {
    const target = (args.target as string) ?? "";
    const oid = mockResolveTarget(target);
    if (!oid) throw new Error(`pathspec '${target}' did not match any file(s) known to git`);
    // Only a local branch name reattaches HEAD; an OID, a tag or a remote
    // branch detaches it, like git (#524).
    mockCheckout(oid, mockIsLocalBranch(target) ? target : null);
    return null;
  },
  git_create_branch: (args: Record<string, unknown>) => {
    const name = ((args.name as string) ?? "").trim();
    const oid = (args.oid as string) ?? "";
    const checkout = Boolean(args.checkout);
    if (name.length === 0) throw new Error("branch name must not be empty");
    mockAddRef(name, "LocalBranch", oid);
    if (checkout) mockCheckout(oid, name);
    return null;
  },
  git_create_tag: (args: Record<string, unknown>) => {
    const name = ((args.name as string) ?? "").trim();
    const oid = (args.oid as string) ?? "";
    if (name.length === 0) throw new Error("tag name must not be empty");
    mockAddRef(name, "Tag", oid);
    return null;
  },
  git_cherry_pick: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const src = mockCommitGraph().find((c) => c.oid === oid);
    mockAppendCommit(src ? src.summary : "Cherry-picked commit");
    return null;
  },
  git_revert: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const src = mockCommitGraph().find((c) => c.oid === oid);
    mockAppendCommit(`Revert "${src ? src.summary : oid.slice(0, 7)}"`);
    return null;
  },
  git_merge: (args: Record<string, unknown>) => {
    const target = (args.target as string) ?? "";
    const before_oid = mockHeadOid();
    const branch =
      mockDetached
        ? null
        : (MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
          null;
    const after_oid = mockAppendCommit(`Merge ${target} into current branch`);
    return { kind: "head_move", operation: "merge", branch, before_oid, after_oid };
  },
  git_rebase: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    mockAppendCommit(`Rebased onto ${oid.slice(0, 7)}`);
    return null;
  },
  git_stash_apply: (args: Record<string, unknown>) => {
    const stash = (args.stash as string) ?? "";
    if (!mockCommitGraph().some((commit) => commit.stash === stash)) {
      throw new Error(`stash '${stash}' not found`);
    }
    return null;
  },
  git_stash_pop: (args: Record<string, unknown>) => {
    const stash = (args.stash as string) ?? "";
    const graph = mockCommitGraph();
    const index = graph.findIndex((commit) => commit.stash === stash);
    if (index < 0) throw new Error(`stash '${stash}' not found`);
    graph.splice(index, 1);
    return null;
  },
  git_reset: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const mode = (args.mode as string) ?? "mixed";
    if (!["soft", "mixed", "hard"].includes(mode)) {
      throw new Error(`invalid reset mode: ${mode}`);
    }
    // Move the branch HEAD is on (default main) and HEAD to the target commit.
    // A detached reset moves HEAD only (#524).
    const head = mockHeadOid();
    if (!mockDetached) {
      const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
      mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
    }
    mockMoveHead(oid);
    return null;
  },
};
