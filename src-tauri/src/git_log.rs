//! Git *history* backend for the commit-graph tab (#57).
//!
//! Deliberately separate from `git.rs` (the working-tree / index SCM backend):
//! the concerns are different — this module only reads immutable history
//! (revwalk traversal, refs, topology) and never mutates the repo.
//!
//! ## What the frontend gets
//!
//! `git_log` returns commits in **topological + time order** with each
//! commit's `parents` (full OIDs). The graph renderer computes lane
//! assignment client-side from those parent edges — the backend intentionally
//! does *not* assign lanes or colors. Refs (branches, tags, HEAD) are returned
//! once as a `refs` map keyed by commit OID so the UI can decorate the graph
//! without an extra round-trip.
//!
//! ## Pagination
//!
//! Traversal uses `SORT_TOPOLOGICAL | SORT_TIME` and applies `skip` / `limit`
//! by walking and counting. Tradeoff: skip is O(skip) — libgit2 has no random
//! access into a revwalk — but topological order is *stable* across pages for a
//! fixed tip set, so paging forward (skip = page * limit) yields a consistent,
//! gap-free stream. For very deep repos the cost is dominated by the walk to
//! the current offset, not by decoding commits, and the first page (skip = 0)
//! is cheap. A cursor (last-seen OID) is exposed via `next_cursor` /
//! `has_more` so callers can page without recomputing counts.
//!
//! Every command runs under `spawn_blocking` and is cancellable through the
//! shared `TaskRegistry`, mirroring `git.rs`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::git_common::{open_repo, to_app_err};
use crate::task_registry::TaskRegistry;

static GIT_LOG_TASKS: TaskRegistry = TaskRegistry::new();

/// One entry in the commit log. `oid` is the full 40-char SHA; `short_oid` is
/// the abbreviated form for display. `parents` are full OIDs (0 = root,
/// 1 = normal, 2+ = merge) — the graph renderer uses these as edges.
#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author time, Unix seconds (UTC). Distinct from committer time.
    pub author_time: i64,
    /// First line of the commit message, with leading whitespace/newlines
    /// stripped (#464) — a producer (e.g. `weave_stashes`) may hand this a
    /// raw, un-prettified message, and the detail panel renders it with
    /// `white-space: pre-wrap`, which would otherwise preserve a leading
    /// blank line verbatim.
    pub summary: String,
    /// Stash selector (e.g. `stash@{0}`) when this row is a stash entry
    /// woven into the history (#179). Absent for ordinary commits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stash: Option<String>,
}

/// A decorating ref pointing at a commit.
#[derive(Debug, Clone, Serialize)]
pub struct RefInfo {
    /// Display name, e.g. `main`, `origin/main`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Head,
}

/// Full ref listing for a repo (independent of the log page).
#[derive(Debug, Clone, Default, Serialize)]
pub struct GitRefs {
    pub local_branches: Vec<GitRef>,
    pub remote_branches: Vec<GitRef>,
    pub tags: Vec<GitRef>,
    /// Current HEAD target OID (None on an unborn branch / empty repo).
    pub head: Option<String>,
    /// Shorthand of the checked-out branch, or None when detached / unborn.
    pub head_branch: Option<String>,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitRef {
    pub name: String,
    /// OID the ref resolves to (peeled for annotated tags).
    pub target: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct GitLogOptions {
    /// Number of commits to skip from the tip (page offset). Default 0.
    pub skip: usize,
    /// Max commits to return. Default 500; clamped to a sane ceiling.
    pub limit: Option<usize>,
    /// When set, walk history from only these branch tips (shorthand names,
    /// local like `main` or remote like `origin/main`) instead of HEAD plus
    /// every branch. Names that don't resolve are ignored; if none resolve
    /// the page is empty. `None` = no filter (#342).
    pub branches: Option<Vec<String>>,
    /// Branch shorthands to drop from the seed set, whichever way it was
    /// built (#515). Unlike `branches` this is subtractive, so "every branch
    /// except these" keeps HEAD seeded and keeps honouring `local_only` —
    /// spelling the same thing as an explicit `branches` list would silently
    /// lose both. `None` / empty = drop nothing.
    pub exclude_branches: Option<Vec<String>>,
    /// Seed the walk from HEAD + LOCAL branch tips only, hiding history that
    /// is reachable solely from remote-tracking branches (#381). Ignored when
    /// `branches` is set (an explicit selection wins).
    #[serde(default)]
    pub local_only: bool,
    /// Repository-relative path whose touching commits should be returned.
    /// `None` / blank = no path filter (#529).
    pub file_path: Option<String>,
    /// Resume hint (#431): OID of the last real commit of the previous page
    /// (the previous page's `next_cursor`). When set, the walk seeds from the
    /// same tips but discards every commit up to *and including* this OID, then
    /// collects the next `limit`. This is gap-free and immune to the synthetic
    /// stash rows that a numeric `skip` miscounts (#432): the cursor keys on a
    /// real commit OID, not a returned-row count. `skip` is ignored when a
    /// cursor is present. `None` = page by `skip` (used for filtered queries).
    pub cursor: Option<String>,
}

const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 5000;

/// A page of log results plus decoration and cursor metadata.
#[derive(Debug, Clone, Serialize)]
pub struct GitLogPage {
    pub commits: Vec<CommitInfo>,
    /// OID → refs decorating that commit. Only commits carrying a ref appear.
    pub refs: std::collections::HashMap<String, Vec<RefInfo>>,
    /// True if more commits exist past this page.
    pub has_more: bool,
    /// OID of the last commit in this page — pass as a resume hint / for
    /// display; the next page is fetched with `skip + commits.len()`.
    pub next_cursor: Option<String>,
    /// Shorthand of the checked-out branch (HEAD's symbolic target), or None
    /// when detached / unborn. Lets the graph highlight *only* the checked-out
    /// branch chip when several branches sit on the HEAD commit (#433).
    pub head_branch: Option<String>,
    /// True while HEAD points straight at a commit instead of a branch (#524).
    /// Reported separately from `head_branch` because that is also None on an
    /// unborn branch — the graph's standing detached badge must not fire there.
    pub detached: bool,
}

/// True while HEAD points at a commit rather than a branch. An unborn branch
/// (no commits yet) is attached, not detached.
fn head_detached_in(repo: &Repository) -> bool {
    repo.head_detached().unwrap_or(false)
}

/// Shorthand of the branch HEAD points at, or None when detached / unborn.
fn head_branch_of(repo: &Repository) -> Option<String> {
    if head_detached_in(repo) {
        return None;
    }
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_string))
}

fn short_oid(oid: Oid) -> String {
    // 7 hex chars matches git's default abbreviation.
    let s = oid.to_string();
    s.chars().take(7).collect()
}

/// Build the OID → decorations map for the whole repo. Cheap relative to the
/// walk and keeps the UI from issuing a second call.
fn collect_decorations(
    repo: &Repository,
) -> Result<std::collections::HashMap<String, Vec<RefInfo>>, AppError> {
    use std::collections::HashMap;
    let mut map: HashMap<String, Vec<RefInfo>> = HashMap::new();

    let refs = repo.references().map_err(to_app_err)?;
    for r in refs {
        let r = match r {
            Ok(r) => r,
            Err(_) => continue,
        };
        let name = match r.shorthand() {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Resolve to the underlying commit OID (peel annotated tags).
        let target = match r.peel_to_commit() {
            Ok(c) => c.id(),
            Err(_) => match r.target() {
                Some(t) => t,
                None => continue,
            },
        };

        let kind = if r.is_tag() {
            RefKind::Tag
        } else if r.is_remote() {
            RefKind::RemoteBranch
        } else if r.is_branch() {
            RefKind::LocalBranch
        } else {
            continue;
        };
        // Skip the symbolic remote HEAD (e.g. origin/HEAD) — it duplicates a
        // branch and clutters decoration.
        if kind == RefKind::RemoteBranch && name.ends_with("/HEAD") {
            continue;
        }

        map.entry(target.to_string())
            .or_default()
            .push(RefInfo { name, kind });
    }

    // Mark HEAD.
    if let Ok(head) = repo.head() {
        if let Ok(commit) = head.peel_to_commit() {
            map.entry(commit.id().to_string())
                .or_default()
                .push(RefInfo {
                    name: "HEAD".to_string(),
                    kind: RefKind::Head,
                });
        }
    }

    Ok(map)
}

/// Insert stash entries into the page, each right before its base commit
/// (mirroring how the reference UI splices stashes into the history).
/// Stashes whose base isn't in this page are skipped — they attach on the
/// page that contains their base.
fn weave_stashes(
    commits: &mut Vec<CommitInfo>,
    stashes: Vec<(usize, String, git2::Oid)>,
    repo: &Repository,
) {
    for (idx, message, oid) in stashes {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let Some(base) = commit.parent_id(0).ok().map(|b| b.to_string()) else {
            continue;
        };
        let Some(pos) = commits.iter().position(|c| c.oid == base) else {
            continue;
        };
        let author = commit.author();
        commits.insert(
            pos,
            CommitInfo {
                oid: oid.to_string(),
                short_oid: short_oid(oid),
                // Only the base parent: the stash's index/untracked internals
                // must not appear as graph edges.
                parents: vec![base],
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                author_time: author.when().seconds(),
                summary: message.trim_start().to_string(),
                stash: Some(format!("stash@{{{idx}}}")),
            },
        );
    }
}

fn build_log(
    repo: &Repository,
    opts: &GitLogOptions,
    stashes: Vec<(usize, String, git2::Oid)>,
    cancelled: &AtomicBool,
) -> Result<GitLogPage, AppError> {
    let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let mut walk = repo.revwalk().map_err(to_app_err)?;
    // Topological keeps parents-after-children; time breaks ties by commit date
    // so the ordering is stable and intuitive across pages.
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(to_app_err)?;

    // Seed the walk. Default: every local + remote branch tip plus HEAD so
    // the graph shows all lanes, not just the current branch. With a branch
    // filter (#342): only the selected tips — commits reachable from none of
    // them (including HEAD's, if its branch is deselected) drop out. Falls
    // back gracefully on an empty / unborn repo (push_head errors → no
    // commits).
    let mut seeded = false;
    // Subtractive filter (#515): applies to both seeding paths, so hiding
    // remote-only branches never turns "everything" into an explicit list.
    let excluded: std::collections::HashSet<&str> = opts
        .exclude_branches
        .iter()
        .flatten()
        .map(String::as_str)
        .collect();
    if let Some(names) = &opts.branches {
        for name in names {
            if excluded.contains(name.as_str()) {
                continue;
            }
            let branch = repo
                .find_branch(name, git2::BranchType::Local)
                .or_else(|_| repo.find_branch(name, git2::BranchType::Remote));
            if let Ok(b) = branch {
                if let Some(oid) = b.get().target() {
                    if walk.push(oid).is_ok() {
                        seeded = true;
                    }
                }
            }
        }
    } else {
        if walk.push_head().is_ok() {
            seeded = true;
        }
        // Local-only (#381): hide history reachable solely from remotes.
        let branch_type = if opts.local_only {
            Some(git2::BranchType::Local)
        } else {
            None
        };
        if let Ok(branches) = repo.branches(branch_type) {
            for b in branches.flatten() {
                if matches!(b.0.name(), Ok(Some(n)) if excluded.contains(n)) {
                    continue;
                }
                if let Some(oid) = b.0.get().target() {
                    if walk.push(oid).is_ok() {
                        seeded = true;
                    }
                }
            }
        }
    }
    if !seeded {
        return Ok(GitLogPage {
            commits: Vec::new(),
            refs: std::collections::HashMap::new(),
            has_more: false,
            next_cursor: None,
            head_branch: head_branch_of(repo),
            detached: head_detached_in(repo),
        });
    }

    let mut commits = Vec::with_capacity(limit.min(1024));
    let mut skipped = 0usize;
    let mut has_more = false;

    // Cursor resume (#431): discard every commit up to and including the cursor
    // OID, then collect. `passed_cursor` starts true when there is no cursor, so
    // the numeric-`skip` path below runs unchanged. An unresolvable cursor OID
    // is treated as "no cursor" (fall back to skip) rather than erroring.
    let cursor_oid = opts.cursor.as_deref().and_then(|s| Oid::from_str(s).ok());
    let mut passed_cursor = cursor_oid.is_none();

    for (i, step) in walk.enumerate() {
        // Cooperative cancellation — check periodically to avoid overhead.
        if i % 256 == 0 && cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Other("git log cancelled".into()));
        }
        let oid = step.map_err(to_app_err)?;

        if let Some(cur) = cursor_oid {
            if !passed_cursor {
                // Still walking through the already-returned prefix.
                if oid == cur {
                    passed_cursor = true;
                }
                continue;
            }
        } else if skipped < opts.skip {
            skipped += 1;
            continue;
        }
        if commits.len() == limit {
            // One extra step proves there is a next page without fetching it.
            has_more = true;
            break;
        }

        let commit = repo.find_commit(oid).map_err(to_app_err)?;
        let author = commit.author();
        commits.push(CommitInfo {
            oid: oid.to_string(),
            short_oid: short_oid(oid),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            author_time: author.when().seconds(),
            summary: commit.summary().unwrap_or("").trim_start().to_string(),
            stash: None,
        });
    }

    let next_cursor = commits.last().map(|c| c.oid.clone());
    weave_stashes(&mut commits, stashes, repo);
    let refs = collect_decorations(repo)?;

    Ok(GitLogPage {
        commits,
        refs,
        has_more,
        next_cursor,
        head_branch: head_branch_of(repo),
        detached: head_detached_in(repo),
    })
}

/// A branch and the author who "created" it (#376): the author of the oldest
/// commit reachable from the branch tip but not from HEAD's history — i.e.
/// the first commit unique to the branch. Fully-merged branches (no unique
/// commits) fall back to the tip commit's author.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchAuthor {
    pub name: String,
    pub author: String,
    pub remote: bool,
}

/// Total decode cap for the single author walk (#431). Was applied *per
/// branch* (`O(branches × 2000)` commit decodes on every popover open); it is
/// now a global cap across ONE walk over all tips, so the cost is
/// `O(unique-commits)` once, not per branch.
const AUTHOR_WALK_CAP: usize = 10_000;

/// (branch name, tip OID, is-remote) for every branch, skipping the symbolic
/// remote HEAD. The tip OIDs form the cache key (below): the author map is
/// valid as long as no branch tip moved.
fn gather_branches(repo: &Repository) -> Vec<(String, Oid, bool)> {
    let mut out = Vec::new();
    if let Ok(branches) = repo.branches(None) {
        for (branch, btype) in branches.flatten() {
            let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
                continue;
            };
            if name.ends_with("/HEAD") {
                continue;
            }
            let Some(tip) = branch.get().target() else {
                continue;
            };
            out.push((name, tip, btype == git2::BranchType::Remote));
        }
    }
    out
}

/// Order-independent signature of every branch tip. Cache invalidates when any
/// tip OID changes (a branch moved, was created, or deleted).
fn tips_signature(branches: &[(String, Oid, bool)]) -> String {
    let mut parts: Vec<String> = branches
        .iter()
        .map(|(name, tip, _)| format!("{name}={tip}"))
        .collect();
    parts.sort();
    parts.join("\n")
}

/// Author of the *first* commit unique to a branch (its "creator"), found by an
/// in-memory walk over the pre-decoded `info` map (no libgit2 calls). The first
/// unique commit is the oldest ROOT of the branch-unique set reachable from the
/// tip — a unique commit whose parents all fall outside the set (i.e. in
/// trunk). Ties (equal author time) are broken by OID for determinism. `None`
/// when the branch has no unique commits (fully merged into trunk) — callers
/// then fall back to the tip author. Attribution is topological (root-based),
/// not min-time, so commits sharing a timestamp still resolve correctly.
fn oldest_unique_author(
    info: &std::collections::HashMap<Oid, (String, i64, Vec<Oid>)>,
    tip: Oid,
) -> Option<String> {
    // Commits unique to this branch, reachable from the tip.
    let mut stack = vec![tip];
    let mut reachable = std::collections::HashSet::new();
    while let Some(oid) = stack.pop() {
        if !info.contains_key(&oid) || !reachable.insert(oid) {
            continue;
        }
        for p in &info[&oid].2 {
            stack.push(*p);
        }
    }
    // The creator's commit is the oldest root of that set.
    reachable
        .iter()
        .filter(|oid| info[oid].2.iter().all(|p| !reachable.contains(p)))
        .min_by(|a, b| {
            let (ia, ib) = (&info[*a], &info[*b]);
            ia.1.cmp(&ib.1).then_with(|| a.cmp(b))
        })
        .map(|oid| info[oid].0.clone())
        .filter(|s| !s.is_empty())
}

/// Branch → creator, computed with a SINGLE revwalk (#431). Previously each
/// branch got its own revwalk of up to 2000 commits with a `find_commit` per
/// step. Now one walk seeded from all tips (hiding trunk) decodes every commit
/// unique to some branch exactly once into `info`; per-branch creator
/// attribution is then a cheap in-memory traversal of that map.
fn collect_branch_authors(
    repo: &Repository,
    branches: Vec<(String, Oid, bool)>,
) -> Result<Vec<BranchAuthor>, AppError> {
    let trunk = repo.head().ok().and_then(|h| h.target());

    // One walk over all tips, hiding trunk history so only branch-unique
    // commits are decoded. Topological keeps parents after children.
    let mut walk = repo.revwalk().map_err(to_app_err)?;
    walk.set_sorting(Sort::TOPOLOGICAL).map_err(to_app_err)?;
    for (_, tip, _) in &branches {
        let _ = walk.push(*tip);
    }
    if let Some(t) = trunk {
        let _ = walk.hide(t);
    }
    // oid -> (author name, author time seconds, parent oids)
    let mut info: std::collections::HashMap<Oid, (String, i64, Vec<Oid>)> =
        std::collections::HashMap::new();
    for (i, step) in walk.enumerate() {
        if i >= AUTHOR_WALK_CAP {
            break;
        }
        let Ok(oid) = step else { break };
        if let Ok(commit) = repo.find_commit(oid) {
            let author = commit.author();
            info.insert(
                oid,
                (
                    author.name().unwrap_or("").to_string(),
                    author.when().seconds(),
                    commit.parent_ids().collect(),
                ),
            );
        }
    }

    let mut out = Vec::with_capacity(branches.len());
    for (name, tip, remote) in branches {
        let author = oldest_unique_author(&info, tip)
            .or_else(|| {
                repo.find_commit(tip)
                    .ok()
                    .map(|c| c.author().name().unwrap_or("").to_string())
            })
            .unwrap_or_default();
        out.push(BranchAuthor {
            name,
            author,
            remote,
        });
    }
    Ok(out)
}

/// Per-repo author cache (#431): keyed by repo path, holding the tip signature
/// the entry was computed for. A popover reopen with unchanged tips is served
/// from memory instead of re-walking history.
type AuthorCache = std::sync::Mutex<std::collections::HashMap<String, (String, Vec<BranchAuthor>)>>;
fn author_cache() -> &'static AuthorCache {
    static CACHE: std::sync::OnceLock<AuthorCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Branch → creator map for the branch-filter popover's author filter (#376),
/// cached per repo and invalidated when any branch tip moves (#431).
#[tauri::command]
pub async fn git_branch_authors(repo_path: String) -> Result<Vec<BranchAuthor>, AppError> {
    run_blocking(move |_cancelled| {
        let repo = open_repo(Path::new(&repo_path))?;
        let branches = gather_branches(&repo);
        let sig = tips_signature(&branches);
        if let Ok(cache) = author_cache().lock() {
            if let Some((cached_sig, authors)) = cache.get(&repo_path) {
                if *cached_sig == sig {
                    return Ok(authors.clone());
                }
            }
        }
        let authors = collect_branch_authors(&repo, branches)?;
        if let Ok(mut cache) = author_cache().lock() {
            cache.insert(repo_path.clone(), (sig, authors.clone()));
        }
        Ok(authors)
    })
    .await
}

fn collect_refs(repo: &Repository) -> Result<GitRefs, AppError> {
    let mut out = GitRefs::default();

    if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
        for b in branches.flatten() {
            if let (Ok(Some(name)), Some(target)) = (b.0.name(), b.0.get().target()) {
                out.local_branches.push(GitRef {
                    name: name.to_string(),
                    target: target.to_string(),
                });
            }
        }
    }
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Remote)) {
        for b in branches.flatten() {
            if let (Ok(Some(name)), Some(target)) = (b.0.name(), b.0.get().target()) {
                if name.ends_with("/HEAD") {
                    continue;
                }
                out.remote_branches.push(GitRef {
                    name: name.to_string(),
                    target: target.to_string(),
                });
            }
        }
    }
    if let Ok(names) = repo.tag_names(None) {
        for name in names.iter().flatten() {
            if let Ok(obj) = repo.revparse_single(name) {
                // Peel annotated tags to their commit.
                let target = obj
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or_else(|_| obj.id());
                out.tags.push(GitRef {
                    name: name.to_string(),
                    target: target.to_string(),
                });
            }
        }
    }

    match repo.head() {
        Ok(head) => {
            out.detached = head_detached_in(repo);
            if head.is_branch() && !out.detached {
                out.head_branch = head.shorthand().map(|s| s.to_string());
            }
            out.head = head.peel_to_commit().ok().map(|c| c.id().to_string());
        }
        Err(_) => {
            // Unborn branch / empty repo — leave head as None.
        }
    }

    Ok(out)
}

async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(Arc<AtomicBool>) -> Result<T, AppError> + Send + 'static,
{
    let (id, cancelled) = GIT_LOG_TASKS.start();
    let handle = tokio::task::spawn_blocking(move || f(cancelled));
    let result = handle.await;
    GIT_LOG_TASKS.cleanup(id);
    result.map_err(|e| AppError::Other(format!("git log task join: {e}")))?
}

/// Return a page of commit history in topological order, with refs decoration.
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    options: Option<GitLogOptions>,
) -> Result<GitLogPage, AppError> {
    let opts = options.unwrap_or_default();
    run_blocking(move |cancelled| {
        let mut repo = open_repo(Path::new(&repo_path))?;
        // stash_foreach needs &mut; collect first, weave during page build.
        let mut stashes: Vec<(usize, String, git2::Oid)> = Vec::new();
        let _ = repo.stash_foreach(|idx, message, oid| {
            stashes.push((idx, message.to_string(), *oid));
            true
        });
        build_log(&repo, &opts, stashes, &cancelled)
    })
    .await
}

/// Return all branches (local + remote), tags, and HEAD for a repo.
#[tauri::command]
pub async fn git_refs(repo_path: String) -> Result<GitRefs, AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        collect_refs(&repo)
    })
    .await
}

/// One changed file in a commit (vs its first parent, or the empty tree for
/// a root commit).
#[derive(Debug, Clone, Serialize)]
pub struct CommitFile {
    pub path: String,
    /// Porcelain-style letter: A, M, D, R, C, T.
    pub status: String,
}

/// Files changed by `oid` relative to its first parent (root commits diff
/// against the empty tree). Powers the graph's commit-detail panel (#58).
#[tauri::command]
pub async fn git_commit_files(repo_path: String, oid: String) -> Result<Vec<CommitFile>, AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let commit = repo
            .find_commit(Oid::from_str(&oid).map_err(|e| AppError::Other(e.to_string()))?)
            .map_err(|e| AppError::Other(format!("commit not found: {e}")))?;
        let tree = commit.tree().map_err(|e| AppError::Other(e.to_string()))?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map_err(|e| AppError::Other(e.to_string()))?;

        let mut files = Vec::new();
        for delta in diff.deltas() {
            let status = match delta.status() {
                git2::Delta::Added => "A",
                git2::Delta::Deleted => "D",
                git2::Delta::Modified => "M",
                git2::Delta::Renamed => "R",
                git2::Delta::Copied => "C",
                git2::Delta::Typechange => "T",
                _ => "M",
            };
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            files.push(CommitFile {
                path,
                status: status.to_string(),
            });
        }
        Ok(files)
    })
    .await
}

/// Unified diff of a single file in `oid` relative to its first parent (root
/// commits diff against the empty tree). Powers the commit-detail panel's
/// per-file diff (#221) — VSCode Git Graph behavioral parity.
fn commit_file_diff(repo: &Repository, oid: &str, file_path: &str) -> Result<String, AppError> {
    let commit = repo
        .find_commit(Oid::from_str(oid).map_err(|e| AppError::Other(e.to_string()))?)
        .map_err(|e| AppError::Other(format!("commit not found: {e}")))?;
    let tree = commit.tree().map_err(|e| AppError::Other(e.to_string()))?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    // Rename detection needs the whole diff; a pathspec-limited diff shows a
    // rename as delete+add. Acceptable: the detail panel labels renames from
    // git_commit_files, this view just shows content changes.
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| AppError::Other(e.to_string()))?;

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin_value() {
            git2::DiffLineType::Addition => "+",
            git2::DiffLineType::Deletion => "-",
            git2::DiffLineType::Context => " ",
            _ => "",
        };
        out.push_str(prefix);
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(to_app_err)?;
    Ok(out)
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_path: String,
    oid: String,
    file_path: String,
) -> Result<String, AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        commit_file_diff(&repo, &oid, &file_path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    /// Manual timing probe for page-0 cost on a real repository (#367).
    /// Run with: GIT_LOG_BENCH_REPO=/path/to/big/repo \
    ///   cargo test --release git_log_page0_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn git_log_page0_timing() {
        let Ok(path) = std::env::var("GIT_LOG_BENCH_REPO") else {
            eprintln!("set GIT_LOG_BENCH_REPO");
            return;
        };
        let repo = Repository::open(&path).unwrap();
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let page =
                build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
            eprintln!(
                "build_log page0: {:?} ({} commits, {} decorated)",
                t.elapsed(),
                page.commits.len(),
                page.refs.len()
            );
        }
        let t = std::time::Instant::now();
        let _ = collect_decorations(&repo).unwrap();
        eprintln!("collect_decorations alone: {:?}", t.elapsed());
    }

    #[test]
    fn commit_file_diff_shows_changes_against_first_parent() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        let c1 = commit(&repo, "first", &[]);
        fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        fs::write(dir.path().join("b.txt"), "other\n").unwrap();
        let c2 = commit(&repo, "second", &[c1]);

        let diff = commit_file_diff(&repo, &c2.to_string(), "a.txt").unwrap();
        assert!(diff.contains("-one"), "missing removal: {diff}");
        assert!(diff.contains("+two"), "missing addition: {diff}");
        // Pathspec-limited: the sibling file must not leak in.
        assert!(!diff.contains("b.txt"), "unrelated file leaked: {diff}");

        // Root commit diffs against the empty tree.
        let root_diff = commit_file_diff(&repo, &c1.to_string(), "a.txt").unwrap();
        assert!(root_diff.contains("+one"), "root diff wrong: {root_diff}");

        // Unknown oid errors, unknown path yields an empty diff.
        assert!(commit_file_diff(&repo, "0000", "a.txt").is_err());
        let none = commit_file_diff(&repo, &c2.to_string(), "missing.txt").unwrap();
        assert!(none.trim().is_empty());
    }

    #[test]
    fn stashes_weave_in_before_their_base_commit() {
        let (dir, mut repo) = init_repo();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let c1 = commit(&repo, "first", &[]);
        std::fs::write(dir.path().join("a.txt"), "two").unwrap();
        let _c2 = commit(&repo, "second", &[c1]);

        // Dirty the tree and stash it (base = HEAD = second).
        std::fs::write(dir.path().join("a.txt"), "dirty").unwrap();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        repo.stash_save(&sig, "wip stuff", None).unwrap();

        let mut stashes: Vec<(usize, String, Oid)> = Vec::new();
        repo.stash_foreach(|idx, message, oid| {
            stashes.push((idx, message.to_string(), *oid));
            true
        })
        .unwrap();
        assert_eq!(stashes.len(), 1);

        let page = build_log(&repo, &GitLogOptions::default(), stashes, &no_cancel()).unwrap();
        // stash row sits immediately before its base (second), single parent.
        let stash_pos = page.commits.iter().position(|c| c.stash.is_some()).unwrap();
        let stash_row = &page.commits[stash_pos];
        assert_eq!(stash_row.stash.as_deref(), Some("stash@{0}"));
        assert_eq!(stash_row.parents.len(), 1);
        assert_eq!(page.commits[stash_pos + 1].summary, "second");
        assert_eq!(stash_row.parents[0], page.commits[stash_pos + 1].oid);
    }

    /// #464: a woven stash's `summary` must never carry a leading
    /// newline/whitespace, even though `stash_foreach`'s reflog-backed
    /// message can't produce one in practice (reflog entries are
    /// single-line) — `weave_stashes` is the general seam other producers
    /// (or a future non-reflog message source) could feed a raw string
    /// through, and the detail panel's `white-space: pre-wrap` would render
    /// a leading `\n` as a blank line above the text.
    #[test]
    fn woven_stash_summary_has_no_leading_blank_line() {
        let (dir, repo) = init_repo();
        write(dir.path(), "a.txt", "one");
        let c1 = commit(&repo, "first", &[]);

        // Build a stash commit by hand so its message can carry a leading
        // newline that real `git stash` (reflog-backed) never would.
        write(dir.path(), "a.txt", "two");
        let stash_commit = commit(&repo, "stash body", &[c1]);
        let stashes = vec![(0usize, "\n\nwip stuff".to_string(), stash_commit)];

        let mut commits = vec![CommitInfo {
            oid: c1.to_string(),
            short_oid: short_oid(c1),
            parents: vec![],
            author_name: "Test User".into(),
            author_email: "test@example.com".into(),
            author_time: 0,
            summary: "first".into(),
            stash: None,
        }];
        weave_stashes(&mut commits, stashes, &repo);

        let stash_row = commits.iter().find(|c| c.stash.is_some()).unwrap();
        assert_eq!(stash_row.summary, "wip stuff");
        assert!(
            !stash_row.summary.starts_with('\n'),
            "leading newline survived: {:?}",
            stash_row.summary
        );
    }

    #[test]
    fn branch_filter_walks_only_selected_tips() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "one");
        let c1 = commit(&repo, "base", &[]);
        // Side branch off base, with its own tip; main advances separately.
        repo.branch("side", &repo.find_commit(c1).unwrap(), false)
            .unwrap();
        write(&p, "a.txt", "two");
        let _main_tip = commit(&repo, "main tip", &[c1]);
        repo.set_head("refs/heads/side").unwrap();
        write(&p, "b.txt", "side");
        let _side_tip = commit(&repo, "side tip", &[c1]);

        // Unfiltered: both tips plus the shared base.
        let all = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert_eq!(all.commits.len(), 3);

        // Filtered to main: the side tip drops out — even though HEAD is on
        // side (the filter replaces the HEAD seed, it does not add to it).
        let opts = GitLogOptions {
            branches: Some(vec!["main".into()]),
            ..Default::default()
        };
        let page = build_log(&repo, &opts, Vec::new(), &no_cancel()).unwrap();
        let sums: Vec<_> = page.commits.iter().map(|c| c.summary.as_str()).collect();
        assert!(sums.contains(&"main tip"), "missing main tip: {sums:?}");
        assert!(sums.contains(&"base"), "missing shared base: {sums:?}");
        assert!(
            !sums.contains(&"side tip"),
            "filtered branch leaked: {sums:?}"
        );

        // Unresolvable names are ignored; nothing resolvable → empty page.
        let opts = GitLogOptions {
            branches: Some(vec!["no-such-branch".into()]),
            ..Default::default()
        };
        let empty = build_log(&repo, &opts, Vec::new(), &no_cancel()).unwrap();
        assert!(empty.commits.is_empty());
    }

    #[test]
    fn branch_authors_report_the_branch_creator_not_the_tip_committer() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "one");
        let base = commit(&repo, "base", &[]);

        // Branch created by Creator; a later commit on it by Other. The
        // branch's author must be Creator (first unique commit), not Other.
        repo.branch("topic", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/topic").unwrap();
        let creator = git2::Signature::now("Creator", "c@x").unwrap();
        let other = git2::Signature::now("Other", "o@x").unwrap();
        let tree = repo.find_commit(base).unwrap().tree().unwrap();
        let first = repo
            .commit(
                Some("HEAD"),
                &creator,
                &creator,
                "start topic",
                &tree,
                &[&repo.find_commit(base).unwrap()],
            )
            .unwrap();
        let second = repo
            .commit(
                Some("HEAD"),
                &other,
                &other,
                "continue topic",
                &tree,
                &[&repo.find_commit(first).unwrap()],
            )
            .unwrap();
        let _ = second;
        // Trunk: switch HEAD back to main so topic's commits are "unique".
        repo.set_head("refs/heads/main").unwrap();

        let authors = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
        let topic = authors.iter().find(|b| b.name == "topic").unwrap();
        assert_eq!(topic.author, "Creator");
        // Fully-merged branch (points at trunk history): falls back to tip author.
        let main = authors.iter().find(|b| b.name == "main").unwrap();
        assert_eq!(main.author, "Test User");
    }

    #[test]
    fn branch_authors_cache_invalidates_when_a_tip_moves() {
        // The single-walk author computation is cached per repo, keyed by the
        // tip signature. A new commit on a branch moves its tip → the signature
        // changes → the cache must recompute (not serve the stale author).
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "one");
        let base = commit(&repo, "base", &[]);
        repo.branch("topic", &repo.find_commit(base).unwrap(), false)
            .unwrap();

        let branches = gather_branches(&repo);
        let sig1 = tips_signature(&branches);

        // Advance topic with a commit by a distinct author.
        repo.set_head("refs/heads/topic").unwrap();
        let alice = git2::Signature::now("Alice", "a@x").unwrap();
        let tree = repo.find_commit(base).unwrap().tree().unwrap();
        repo.commit(
            Some("HEAD"),
            &alice,
            &alice,
            "topic work",
            &tree,
            &[&repo.find_commit(base).unwrap()],
        )
        .unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let sig2 = tips_signature(&gather_branches(&repo));
        assert_ne!(sig1, sig2, "moving a tip must change the signature");

        let authors = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
        let topic = authors.iter().find(|b| b.name == "topic").unwrap();
        assert_eq!(topic.author, "Alice", "single walk attributes the creator");
    }

    #[test]
    fn paging_by_cursor_is_gap_free_and_ignores_skip() {
        // Cursor resume walks from the tips, discards up to and including the
        // cursor OID, then collects — gap-free without any numeric skip.
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        let mut oids = Vec::new();
        for i in 0..8 {
            write(&p, "f.txt", &format!("v{i}"));
            let parents: Vec<Oid> = oids.last().copied().into_iter().collect();
            oids.push(commit(&repo, &format!("c{i}"), &parents));
        }

        let page1 = build_log(
            &repo,
            &GitLogOptions {
                limit: Some(3),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(
            page1
                .commits
                .iter()
                .map(|c| c.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["c7", "c6", "c5"],
        );
        let cursor = page1.next_cursor.clone().unwrap();
        assert_eq!(cursor, page1.commits[2].oid);

        // Resume from the cursor; `skip` is deliberately a wrong value to prove
        // the cursor path ignores it.
        let page2 = build_log(
            &repo,
            &GitLogOptions {
                limit: Some(3),
                skip: 999,
                cursor: Some(cursor),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(
            page2
                .commits
                .iter()
                .map(|c| c.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["c4", "c3", "c2"],
            "cursor resumes exactly after the cursor OID, gap-free",
        );
        assert!(page2.has_more);
    }

    #[test]
    fn paging_by_cursor_survives_a_woven_stash() {
        // The #432 numeric-skip off-by-N: a woven stash row inflates the row
        // count. The cursor keys on a REAL commit OID, so resume is immune —
        // no real commit is dropped at the stash page boundary.
        let (dir, mut repo) = init_repo();
        let p = dir.path().to_path_buf();
        let mut oids = Vec::new();
        for i in 0..6 {
            write(&p, "f.txt", &format!("v{i}"));
            let parents: Vec<Oid> = oids.last().copied().into_iter().collect();
            oids.push(commit(&repo, &format!("c{i}"), &parents));
        }
        write(&p, "f.txt", "dirty");
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        repo.stash_save(&sig, "wip", None).unwrap();

        fn stashes(repo: &mut Repository) -> Vec<(usize, String, Oid)> {
            let mut s = Vec::new();
            repo.stash_foreach(|idx, msg, oid| {
                s.push((idx, msg.to_string(), *oid));
                true
            })
            .unwrap();
            s
        }
        let real = |page: &GitLogPage| -> Vec<String> {
            page.commits
                .iter()
                .filter(|c| c.stash.is_none())
                .map(|c| c.summary.clone())
                .collect()
        };

        let s = stashes(&mut repo);
        let page1 = build_log(
            &repo,
            &GitLogOptions {
                limit: Some(3),
                ..Default::default()
            },
            s,
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(real(&page1), vec!["c5", "c4", "c3"]);
        // next_cursor is the last REAL commit (c3), not the woven stash row.
        let cursor = page1.next_cursor.clone().unwrap();

        let s = stashes(&mut repo);
        let page2 = build_log(
            &repo,
            &GitLogOptions {
                limit: Some(3),
                cursor: Some(cursor),
                ..Default::default()
            },
            s,
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(
            real(&page2),
            vec!["c2", "c1", "c0"],
            "cursor resume drops no real commit at the stash boundary",
        );
    }

    #[test]
    fn exclude_branches_drops_a_tip_without_unseeding_head_or_local_only() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "one");
        let base = commit(&repo, "base", &[]);
        write(&p, "a.txt", "two");
        let _tip = commit(&repo, "main tip", &[base]);

        // origin/legacy: a remote-only branch with a commit of its own.
        // origin/main: a remote that local `main` tracks, ALSO ahead by one —
        // local_only is what hides that, and it must keep working.
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let base_commit = repo.find_commit(base).unwrap();
        let tree = base_commit.tree().unwrap();
        let legacy_tip = repo
            .commit(None, &sig, &sig, "remote only", &tree, &[&base_commit])
            .unwrap();
        repo.reference("refs/remotes/origin/legacy", legacy_tip, true, "sim")
            .unwrap();
        let ahead = repo
            .commit(
                None,
                &sig,
                &sig,
                "origin/main ahead",
                &tree,
                &[&base_commit],
            )
            .unwrap();
        repo.reference("refs/remotes/origin/main", ahead, true, "sim")
            .unwrap();

        let summaries = |o: &GitLogOptions| -> Vec<String> {
            build_log(&repo, o, Vec::new(), &no_cancel())
                .unwrap()
                .commits
                .into_iter()
                .map(|c| c.summary)
                .collect()
        };

        // Subtracting the remote-only tip hides its commit and nothing else:
        // HEAD's history and the tracked remote's are still walked.
        let excluded = GitLogOptions {
            exclude_branches: Some(vec!["origin/legacy".into()]),
            ..Default::default()
        };
        let sums = summaries(&excluded);
        assert!(!sums.contains(&"remote only".to_string()), "{sums:?}");
        assert!(sums.contains(&"main tip".to_string()), "{sums:?}");
        assert!(sums.contains(&"origin/main ahead".to_string()), "{sums:?}");

        // Composes with local_only instead of overriding it: an explicit
        // `branches` list would have made "origin/main ahead" reappear.
        let both = GitLogOptions {
            exclude_branches: Some(vec!["origin/legacy".into()]),
            local_only: true,
            ..Default::default()
        };
        let sums = summaries(&both);
        assert!(!sums.contains(&"remote only".to_string()), "{sums:?}");
        assert!(!sums.contains(&"origin/main ahead".to_string()), "{sums:?}");
        assert!(sums.contains(&"main tip".to_string()), "{sums:?}");

        // Subtracts from an explicit selection too (#342 + #515 composed):
        // selecting only the excluded branch walks nothing.
        let selected = GitLogOptions {
            branches: Some(vec!["origin/legacy".into()]),
            exclude_branches: Some(vec!["origin/legacy".into()]),
            ..Default::default()
        };
        assert!(summaries(&selected).is_empty());

        // Excluding an unknown name changes nothing.
        let noop = GitLogOptions {
            exclude_branches: Some(vec!["does/not/exist".into()]),
            ..Default::default()
        };
        assert_eq!(summaries(&noop), summaries(&GitLogOptions::default()));
    }

    #[test]
    fn local_only_hides_remote_only_history() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "one");
        let base = commit(&repo, "base", &[]);
        write(&p, "a.txt", "two");
        let _tip = commit(&repo, "main tip", &[base]);

        // A commit reachable ONLY from a remote-tracking ref: committed with
        // no ref update (HEAD untouched), then pointed to by refs/remotes/….
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let base_commit = repo.find_commit(base).unwrap();
        let tree = base_commit.tree().unwrap();
        let remote_tip = repo
            .commit(None, &sig, &sig, "remote only", &tree, &[&base_commit])
            .unwrap();
        repo.reference("refs/remotes/origin/legacy", remote_tip, true, "sim")
            .unwrap();

        let all = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        let sums: Vec<_> = all.commits.iter().map(|c| c.summary.as_str()).collect();
        assert!(
            sums.contains(&"remote only"),
            "unfiltered must include remote history: {sums:?}"
        );

        let opts = GitLogOptions {
            local_only: true,
            ..Default::default()
        };
        let page = build_log(&repo, &opts, Vec::new(), &no_cancel()).unwrap();
        let sums: Vec<_> = page.commits.iter().map(|c| c.summary.as_str()).collect();
        assert!(
            !sums.contains(&"remote only"),
            "local_only leaked remote-only history: {sums:?}"
        );
        assert!(
            sums.contains(&"main tip"),
            "local history missing: {sums:?}"
        );
    }

    fn init_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
            cfg.set_str("commit.gpgsign", "false").unwrap();
        }
        // Pin the default branch so tests don't depend on the host's
        // init.defaultBranch (master vs main).
        repo.set_head("refs/heads/main").unwrap();
        // Reopen to avoid holding a config borrow.
        let repo = Repository::open(dir.path()).unwrap();
        (dir, repo)
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        fs::write(dir.join(rel), contents).unwrap();
    }

    /// Commit the current worktree; returns the new commit OID. `parents` are
    /// explicit so we can build merges.
    fn commit(repo: &Repository, msg: &str, parents: &[Oid]) -> Oid {
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent_commits: Vec<git2::Commit> = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parent_refs)
            .unwrap()
    }

    /// Linear history: c1 -> c2 -> c3 on HEAD.
    fn linear_repo() -> (TempDir, Repository, Vec<Oid>) {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "a.txt", "1");
        let c1 = commit(&repo, "first", &[]);
        write(&p, "a.txt", "2");
        let c2 = commit(&repo, "second", &[c1]);
        write(&p, "a.txt", "3");
        let c3 = commit(&repo, "third", &[c2]);
        (dir, repo, vec![c1, c2, c3])
    }

    #[test]
    fn linear_history_is_newest_first() {
        let (_dir, repo, oids) = linear_repo();
        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert_eq!(page.commits.len(), 3);
        // Topological + time: newest (c3) first.
        assert_eq!(page.commits[0].oid, oids[2].to_string());
        assert_eq!(page.commits[2].oid, oids[0].to_string());
        assert_eq!(page.commits[0].summary, "third");
        // Root commit has no parents.
        assert!(page.commits[2].parents.is_empty());
        // Each non-root has exactly one parent pointing at its predecessor.
        assert_eq!(page.commits[0].parents, vec![oids[1].to_string()]);
        assert!(!page.has_more);
    }

    #[test]
    fn short_oid_is_seven_chars_and_prefixes_full() {
        let (_dir, repo, _oids) = linear_repo();
        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        for c in &page.commits {
            assert_eq!(c.short_oid.len(), 7);
            assert!(c.oid.starts_with(&c.short_oid));
            assert_eq!(c.author_name, "Test User");
            assert_eq!(c.author_email, "test@example.com");
            assert!(c.author_time > 0);
        }
    }

    #[test]
    fn merge_commit_exposes_two_parents() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        write(&p, "base.txt", "base");
        let base = commit(&repo, "base", &[]);

        // feature branch
        repo.branch("feature", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(&p, "feature.txt", "f");
        let feat = commit(&repo, "feature work", &[base]);

        // back to main, diverge
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(&p, "main.txt", "m");
        let main_c = commit(&repo, "main work", &[base]);

        // merge feature into main
        let merge = commit(&repo, "merge feature", &[main_c, feat]);

        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        let merge_info = page
            .commits
            .iter()
            .find(|c| c.oid == merge.to_string())
            .expect("merge commit present");
        assert_eq!(merge_info.parents.len(), 2, "merge has two parents");
        assert_eq!(merge_info.parents[0], main_c.to_string());
        assert_eq!(merge_info.parents[1], feat.to_string());
        // All four distinct commits are reachable.
        assert_eq!(page.commits.len(), 4);
    }

    #[test]
    fn refs_decoration_marks_head_branches_and_tags() {
        let (dir, repo, oids) = linear_repo();
        let tip = oids[2];
        // Annotated tag on the middle commit.
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let mid = repo.find_object(oids[1], None).unwrap();
        repo.tag("v1.0", &mid, &sig, "release 1.0", false).unwrap();
        let _ = dir;

        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();

        // HEAD + branch on the tip.
        let tip_refs = page.refs.get(&tip.to_string()).expect("tip decorated");
        assert!(tip_refs.iter().any(|r| r.kind == RefKind::Head));
        assert!(tip_refs
            .iter()
            .any(|r| r.kind == RefKind::LocalBranch && r.name == "main"));

        // The page reports the checked-out branch so the graph can highlight
        // only it when several branches share the HEAD commit (#433).
        assert_eq!(page.head_branch.as_deref(), Some("main"));

        // Tag on the middle commit.
        let mid_refs = page.refs.get(&oids[1].to_string()).expect("mid decorated");
        assert!(mid_refs
            .iter()
            .any(|r| r.kind == RefKind::Tag && r.name == "v1.0"));
    }

    #[test]
    fn pagination_boundaries_are_stable_and_gap_free() {
        let (dir, repo) = init_repo();
        let p = dir.path().to_path_buf();
        let mut oids = Vec::new();
        for i in 0..10 {
            write(&p, "f.txt", &format!("v{i}"));
            let parents: Vec<Oid> = oids.last().copied().into_iter().collect();
            oids.push(commit(&repo, &format!("c{i}"), &parents));
        }

        // Page 1: skip 0, limit 4.
        let page1 = build_log(
            &repo,
            &GitLogOptions {
                skip: 0,
                limit: Some(4),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(page1.commits.len(), 4);
        assert!(page1.has_more);
        assert_eq!(
            page1.next_cursor.as_deref(),
            Some(page1.commits[3].oid.as_str())
        );

        // Page 2: skip 4, limit 4.
        let page2 = build_log(
            &repo,
            &GitLogOptions {
                skip: 4,
                limit: Some(4),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(page2.commits.len(), 4);
        assert!(page2.has_more);

        // Page 3: skip 8, limit 4 → only 2 remain, no more pages.
        let page3 = build_log(
            &repo,
            &GitLogOptions {
                skip: 8,
                limit: Some(4),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(page3.commits.len(), 2);
        assert!(!page3.has_more);

        // No overlaps, no gaps: concatenation equals the full ordered walk.
        let full = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        let paged: Vec<String> = page1
            .commits
            .iter()
            .chain(&page2.commits)
            .chain(&page3.commits)
            .map(|c| c.oid.clone())
            .collect();
        let expected: Vec<String> = full.commits.iter().map(|c| c.oid.clone()).collect();
        assert_eq!(paged, expected);
    }

    #[test]
    fn paging_by_real_commit_count_is_gap_free_with_woven_stash() {
        // A stash woven into a page adds a synthetic row, so the frontend must
        // page by the REAL commit count, not the returned row count. Paging by
        // the row count (the #432 off-by-N bug) silently skips a real commit at
        // every page boundary after a stash.
        let (dir, mut repo) = init_repo();
        let p = dir.path().to_path_buf();
        let mut oids = Vec::new();
        for i in 0..6 {
            write(&p, "f.txt", &format!("v{i}"));
            let parents: Vec<Oid> = oids.last().copied().into_iter().collect();
            oids.push(commit(&repo, &format!("c{i}"), &parents));
        }
        // Stash on top of HEAD (base = c5, the tip → woven into page 1).
        write(&p, "f.txt", "dirty");
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        repo.stash_save(&sig, "wip", None).unwrap();

        fn stashes(repo: &mut Repository) -> Vec<(usize, String, Oid)> {
            let mut s = Vec::new();
            repo.stash_foreach(|idx, msg, oid| {
                s.push((idx, msg.to_string(), *oid));
                true
            })
            .unwrap();
            s
        }

        let real = |page: &GitLogPage| -> Vec<String> {
            page.commits
                .iter()
                .filter(|c| c.stash.is_none())
                .map(|c| c.summary.clone())
                .collect()
        };

        // Page 1: limit 3 → 3 real commits (c5,c4,c3) plus the woven stash row.
        let s = stashes(&mut repo);
        let page1 = build_log(
            &repo,
            &GitLogOptions {
                skip: 0,
                limit: Some(3),
                ..Default::default()
            },
            s,
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(real(&page1), vec!["c5", "c4", "c3"]);
        assert!(
            page1.commits.iter().any(|c| c.stash.is_some()),
            "stash woven into page 1"
        );
        // Row count exceeds the real-commit count by exactly the stash row.
        assert_eq!(page1.commits.len(), real(&page1).len() + 1);

        // Correct: skip by the REAL commit count (3) → continues at c2, no gap.
        let s = stashes(&mut repo);
        let page2 = build_log(
            &repo,
            &GitLogOptions {
                skip: real(&page1).len(),
                limit: Some(3),
                ..Default::default()
            },
            s,
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(
            real(&page2),
            vec!["c2", "c1", "c0"],
            "no commit skipped at the stash page boundary"
        );

        // The bug: skipping by the ROW count (4) drops c2.
        let s = stashes(&mut repo);
        let buggy = build_log(
            &repo,
            &GitLogOptions {
                skip: page1.commits.len(),
                limit: Some(3),
                ..Default::default()
            },
            s,
            &no_cancel(),
        )
        .unwrap();
        assert_eq!(
            real(&buggy),
            vec!["c1", "c0"],
            "row-count skip drops c2 (documents the off-by-N)"
        );
    }

    #[test]
    fn skip_past_end_returns_empty() {
        let (_dir, repo, _oids) = linear_repo();
        let page = build_log(
            &repo,
            &GitLogOptions {
                skip: 100,
                limit: Some(10),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        assert!(page.commits.is_empty());
        assert!(!page.has_more);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn non_repo_path_errors() {
        let dir = TempDir::new().unwrap();
        let err = open_repo(dir.path());
        assert!(err.is_err(), "opening a non-repo dir must error");
    }

    #[test]
    fn empty_repo_yields_no_commits() {
        let (dir, repo) = init_repo();
        let _ = dir;
        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert!(page.commits.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn git_refs_lists_branches_and_head() {
        let (_dir, repo, oids) = linear_repo();
        repo.branch("dev", &repo.find_commit(oids[1]).unwrap(), false)
            .unwrap();
        let refs = collect_refs(&repo).unwrap();
        assert!(refs.local_branches.iter().any(|b| b.name == "main"));
        assert!(refs.local_branches.iter().any(|b| b.name == "dev"));
        assert_eq!(refs.head_branch.as_deref(), Some("main"));
        assert_eq!(refs.head.as_deref(), Some(oids[2].to_string().as_str()));
        assert!(!refs.detached);
    }

    // =====================================================================
    // #431 perf-claim VERIFICATION (adversarial). Added by verify/431-perf.
    // These MEASURE the claims that the perf commit argued only by
    // complexity analysis: single-revwalk author scan, tip-keyed author
    // cache invalidation + no-rewalk, and gap-free cursor paging.
    // =====================================================================

    use std::process::Command;
    use std::time::Instant;

    /// Fast commit: constant empty tree, explicit author name + monotonic
    /// author time, explicit parents, optional ref update. Avoids the
    /// worktree add_all round-trip so we can build ~10k-commit repos quickly.
    fn fast_commit(
        repo: &Repository,
        author_name: &str,
        secs: i64,
        tree: &git2::Tree,
        parents: &[Oid],
        update_ref: Option<&str>,
    ) -> Oid {
        let when = git2::Time::new(secs, 0);
        let sig = git2::Signature::new(author_name, &format!("{author_name}@x"), &when).unwrap();
        let parent_commits: Vec<git2::Commit> = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        repo.commit(update_ref, &sig, &sig, "c", tree, &parent_refs)
            .unwrap()
    }

    /// Synthetic repo: a shared trunk of `trunk_n` commits (HEAD = main), then
    /// `branches` feature branches each with `per_branch` UNIQUE commits by a
    /// distinct author, forked off the trunk tip. `feat{i}`'s creator is
    /// `Author{i}` (author of its first unique commit).
    fn build_author_repo(
        trunk_n: usize,
        branches: usize,
        per_branch: usize,
    ) -> (TempDir, Repository) {
        let (dir, repo) = init_repo();
        let empty = {
            let mut idx = repo.index().unwrap();
            idx.clear().unwrap();
            repo.find_tree(idx.write_tree().unwrap()).unwrap()
        };
        let mut t = 1i64;
        // Trunk on main.
        let mut parent: Option<Oid> = None;
        for _ in 0..trunk_n {
            t += 1;
            let ps: Vec<Oid> = parent.into_iter().collect();
            parent = Some(fast_commit(
                &repo,
                "Trunk",
                t,
                &empty,
                &ps,
                Some("refs/heads/main"),
            ));
        }
        let trunk_tip = parent.expect("trunk has commits");
        repo.set_head("refs/heads/main").unwrap();
        // Feature branches, each with distinct unique commits.
        for b in 0..branches {
            let author = format!("Author{b}");
            let mut p = trunk_tip;
            for _ in 0..per_branch {
                t += 1;
                p = fast_commit(&repo, &author, t, &empty, &[p], None);
            }
            repo.reference(&format!("refs/heads/feat{b}"), p, true, "")
                .unwrap();
        }
        drop(empty); // release the borrow of `repo` before moving it out
        (dir, repo)
    }

    // ---- Ported PRE-FIX (39317a9) author scan: per-branch revwalk. ----
    // Kept byte-faithful to the old `branch_creator` / `collect_branch_authors`
    // so we time the OLD algorithm against the NEW one on the SAME repo (no API
    // drift: both use the same git2 surface).
    const OLD_AUTHOR_WALK_CAP: usize = 2000;
    fn old_branch_creator(repo: &Repository, tip: Oid, trunk: Option<Oid>) -> Option<String> {
        let mut walk = repo.revwalk().ok()?;
        walk.push(tip).ok()?;
        if let Some(t) = trunk {
            if t != tip {
                let _ = walk.hide(t);
            }
        }
        let mut last: Option<String> = None;
        for (i, step) in walk.enumerate() {
            if i >= OLD_AUTHOR_WALK_CAP {
                break;
            }
            let Ok(oid) = step else { break };
            if let Ok(commit) = repo.find_commit(oid) {
                last = Some(commit.author().name().unwrap_or("").to_string());
            }
        }
        last.filter(|s| !s.is_empty())
    }
    fn old_collect_branch_authors(repo: &Repository) -> Vec<BranchAuthor> {
        let trunk = repo.head().ok().and_then(|h| h.target());
        let mut out = Vec::new();
        for (branch, btype) in repo.branches(None).unwrap().flatten() {
            let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
                continue;
            };
            if name.ends_with("/HEAD") {
                continue;
            }
            let Some(tip) = branch.get().target() else {
                continue;
            };
            let author = old_branch_creator(repo, tip, trunk).or_else(|| {
                repo.find_commit(tip)
                    .ok()
                    .map(|c| c.author().name().unwrap_or("").to_string())
            });
            out.push(BranchAuthor {
                name,
                author: author.unwrap_or_default(),
                remote: btype == git2::BranchType::Remote,
            });
        }
        out
    }

    /// CORRECTNESS: the ported-old and new author scans must AGREE on creators
    /// (so any timing difference is apples-to-apples, not a behavior change).
    #[test]
    fn old_and_new_author_scans_agree() {
        let (_dir, repo) = build_author_repo(40, 6, 12);
        let mut new = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
        let mut old = old_collect_branch_authors(&repo);
        new.sort_by(|a, b| a.name.cmp(&b.name));
        old.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(new.len(), old.len());
        for (n, o) in new.iter().zip(old.iter()) {
            assert_eq!(n.name, o.name);
            assert_eq!(n.author, o.author, "creator mismatch for {}", n.name);
        }
        // Spot-check a couple of known creators.
        assert_eq!(
            new.iter().find(|b| b.name == "feat0").unwrap().author,
            "Author0"
        );
        assert_eq!(
            new.iter().find(|b| b.name == "feat5").unwrap().author,
            "Author5"
        );
    }

    /// MEASUREMENT (Claim 1). Times the NEW single-walk scan vs the ported OLD
    /// per-branch scan on the prescribed topology (30 branches × 300 unique +
    /// 2000-commit trunk) AND a stacked topology where branches overlap. Run:
    ///   cargo test --release -p tauri-explorer author_scan_timing \
    ///     -- --ignored --nocapture
    #[test]
    #[ignore]
    fn author_scan_timing() {
        for (label, trunk, branches, per) in [(
            "independent 30x300 / trunk 2000",
            2000usize,
            30usize,
            300usize,
        )] {
            let (_dir, repo) = build_author_repo(trunk, branches, per);
            // Warm caches (object db) so both see the same starting state.
            let _ = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
            let _ = old_collect_branch_authors(&repo);

            let reps = 5;
            let t0 = Instant::now();
            for _ in 0..reps {
                let _ = old_collect_branch_authors(&repo);
            }
            let old = t0.elapsed() / reps;
            let t1 = Instant::now();
            for _ in 0..reps {
                let _ = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
            }
            let new = t1.elapsed() / reps;
            eprintln!(
                "[author_scan/{label}] OLD per-branch = {:?} | NEW single-walk = {:?} | speedup = {:.2}x",
                old,
                new,
                old.as_secs_f64() / new.as_secs_f64().max(1e-9)
            );
        }

        // Stacked topology: feat{i} builds on feat{i-1}, so the old per-branch
        // walk re-decodes lower layers O(n^2); the new single walk decodes each
        // once. This is where the complexity win actually bites.
        {
            let (_dir, repo) = init_repo();
            let empty = {
                let mut idx = repo.index().unwrap();
                idx.clear().unwrap();
                repo.find_tree(idx.write_tree().unwrap()).unwrap()
            };
            let mut t = 1i64;
            t += 1;
            let base = fast_commit(&repo, "Trunk", t, &empty, &[], Some("refs/heads/main"));
            repo.set_head("refs/heads/main").unwrap();
            let layers = 40usize;
            let per = 50usize;
            let mut p = base;
            for i in 0..layers {
                for _ in 0..per {
                    t += 1;
                    p = fast_commit(&repo, &format!("Author{i}"), t, &empty, &[p], None);
                }
                repo.reference(&format!("refs/heads/stack{i}"), p, true, "")
                    .unwrap();
            }
            let _ = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
            let _ = old_collect_branch_authors(&repo);
            let reps = 5;
            let t0 = Instant::now();
            for _ in 0..reps {
                let _ = old_collect_branch_authors(&repo);
            }
            let old = t0.elapsed() / reps;
            let t1 = Instant::now();
            for _ in 0..reps {
                let _ = collect_branch_authors(&repo, gather_branches(&repo)).unwrap();
            }
            let new = t1.elapsed() / reps;
            eprintln!(
                "[author_scan/stacked {layers}x{per}] OLD per-branch = {:?} | NEW single-walk = {:?} | speedup = {:.2}x",
                old,
                new,
                old.as_secs_f64() / new.as_secs_f64().max(1e-9)
            );
        }
    }

    fn current_thread_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// CORRECTNESS (Claim 2, staleness attack) via the REAL `git_branch_authors`
    /// command + its process-global tip-keyed cache. First call computes; a
    /// second call with unchanged tips is served from cache (same result);
    /// moving a branch tip (new commit by a new author) must invalidate and
    /// yield the FRESH creator — no stale author served.
    #[test]
    fn author_cache_end_to_end_invalidates_on_tip_move() {
        let (dir, repo) = build_author_repo(5, 2, 3);
        let path = dir.path().to_string_lossy().to_string();
        let rt = current_thread_rt();

        let first = rt.block_on(git_branch_authors(path.clone())).unwrap();
        let second = rt.block_on(git_branch_authors(path.clone())).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|b| (&b.name, &b.author))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|b| (&b.name, &b.author))
                .collect::<Vec<_>>(),
            "unchanged tips → identical (cached) result",
        );
        let feat0_before = first
            .iter()
            .find(|b| b.name == "feat0")
            .unwrap()
            .author
            .clone();
        assert_eq!(feat0_before, "Author0");

        // Move feat0's tip forward — but the *creator* (first unique commit) is
        // unchanged, so instead assert on a NEWLY created branch whose tip did
        // not exist in the first signature: staleness would hide it entirely.
        let empty = {
            let mut idx = repo.index().unwrap();
            idx.clear().unwrap();
            repo.find_tree(idx.write_tree().unwrap()).unwrap()
        };
        let trunk_tip = repo.head().unwrap().target().unwrap();
        let newc = fast_commit(&repo, "Zoe", 10_000, &empty, &[trunk_tip], None);
        repo.reference("refs/heads/fresh", newc, true, "").unwrap();

        let third = rt.block_on(git_branch_authors(path.clone())).unwrap();
        let fresh = third
            .iter()
            .find(|b| b.name == "fresh")
            .expect("new branch must appear — cache was NOT invalidated (STALE) if this fails");
        assert_eq!(
            fresh.author, "Zoe",
            "fresh branch creator served, not stale"
        );
    }

    /// MEASUREMENT (Claim 2, no-rewalk): the second `git_branch_authors` call
    /// with unchanged tips must be dramatically cheaper than the first (cache
    /// hit skips the revwalk). Run with --ignored --nocapture (timing).
    #[test]
    #[ignore]
    fn author_cache_second_call_skips_revwalk_timing() {
        let (dir, _repo) = build_author_repo(2000, 30, 300);
        let path = dir.path().to_string_lossy().to_string();
        let rt = current_thread_rt();
        let t0 = Instant::now();
        let _ = rt.block_on(git_branch_authors(path.clone())).unwrap();
        let first = t0.elapsed();
        let t1 = Instant::now();
        for _ in 0..20 {
            let _ = rt.block_on(git_branch_authors(path.clone())).unwrap();
        }
        let second_avg = t1.elapsed() / 20;
        eprintln!(
            "[author_cache] first (cold, walks) = {:?} | second avg (warm, cache hit) = {:?} | ratio = {:.1}x",
            first,
            second_avg,
            first.as_secs_f64() / second_avg.as_secs_f64().max(1e-9)
        );
        assert!(
            second_avg * 5 < first,
            "cache hit ({second_avg:?}) not materially cheaper than cold walk ({first:?})"
        );
    }

    /// CORRECTNESS (Claim 5): exhaustive cursor paging over a repo with >1 page
    /// (320 commits) and stashes woven in. Walk EVERY page via next_cursor and
    /// assert the set of real (non-stash) commits equals `git rev-list HEAD`
    /// exactly — no gaps, no dupes — and ordering matches the full single walk.
    #[test]
    fn cursor_paging_covers_every_commit_vs_git_rev_list() {
        let (dir, mut repo) = init_repo();
        let p = dir.path().to_path_buf();
        let mut oids = Vec::new();
        for i in 0..320 {
            write(&p, "f.txt", &format!("v{i}"));
            let parents: Vec<Oid> = oids.last().copied().into_iter().collect();
            oids.push(commit(&repo, &format!("c{i}"), &parents));
        }
        // Weave in a couple of stashes at different depths.
        write(&p, "f.txt", "dirty-a");
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        repo.stash_save(&sig, "wip a", None).unwrap();
        write(&p, "f.txt", "dirty-b");
        repo.stash_save(&sig, "wip b", None).unwrap();

        fn stashes(repo: &mut Repository) -> Vec<(usize, String, Oid)> {
            let mut s = Vec::new();
            repo.stash_foreach(|idx, msg, oid| {
                s.push((idx, msg.to_string(), *oid));
                true
            })
            .unwrap();
            s
        }

        // Ground truth: git rev-list HEAD (independent of our walk code).
        let out = Command::new("git")
            .arg("-C")
            .arg(&p)
            .args(["rev-list", "HEAD"])
            .output()
            .expect("git rev-list");
        assert!(out.status.success(), "git rev-list failed");
        let expected: std::collections::HashSet<String> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(expected.len(), 320);

        // Page through with the cursor. limit 100 → 4 pages.
        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            pages += 1;
            assert!(pages < 50, "runaway paging");
            let s = stashes(&mut repo);
            let page = build_log(
                &repo,
                &GitLogOptions {
                    limit: Some(100),
                    cursor: cursor.clone(),
                    ..Default::default()
                },
                s,
                &no_cancel(),
            )
            .unwrap();
            for c in page.commits.iter().filter(|c| c.stash.is_none()) {
                seen.push(c.oid.clone());
            }
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor.clone();
            assert!(cursor.is_some(), "has_more but no cursor");
        }

        // No dupes.
        let unique: std::collections::HashSet<&String> = seen.iter().collect();
        assert_eq!(
            unique.len(),
            seen.len(),
            "cursor paging produced duplicate commits"
        );
        // Exact set equality with git rev-list — no gaps.
        let seen_set: std::collections::HashSet<String> = seen.iter().cloned().collect();
        assert_eq!(seen_set, expected, "cursor paging set != git rev-list set");
        // Ordering matches the single full walk.
        let full = build_log(
            &repo,
            &GitLogOptions {
                limit: Some(5000),
                ..Default::default()
            },
            Vec::new(),
            &no_cancel(),
        )
        .unwrap();
        let full_order: Vec<String> = full
            .commits
            .iter()
            .filter(|c| c.stash.is_none())
            .map(|c| c.oid.clone())
            .collect();
        assert_eq!(seen, full_order, "cursor page order != full-walk order");
    }

    /// #524: the log page reports detached HEAD as its own fact. The standing
    /// indicator can't infer it from `head_branch == None`, which is also the
    /// answer on an unborn branch.
    #[test]
    fn log_page_reports_detached_head() {
        let (dir, repo) = init_repo();
        write(dir.path(), "a.txt", "one\n");
        let c1 = commit(&repo, "first", &[]);
        write(dir.path(), "a.txt", "two\n");
        let c2 = commit(&repo, "second", &[c1]);

        let attached =
            build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert!(!attached.detached, "on a branch, HEAD is not detached");
        assert_eq!(attached.head_branch.as_deref(), Some("main"));

        // Detach onto the older commit, exactly as `git checkout <oid>` does.
        repo.set_head_detached(c1).unwrap();
        let detached =
            build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert!(detached.detached, "checked out an oid → detached HEAD");
        assert_eq!(detached.head_branch, None);

        // Reattaching clears it again (the badge must not stick).
        repo.set_head("refs/heads/main").unwrap();
        let reattached =
            build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert!(!reattached.detached);
        assert_eq!(reattached.head_branch.as_deref(), Some("main"));
        assert!(reattached.commits.iter().any(|c| c.oid == c2.to_string()));
    }

    /// An unborn branch is NOT detached, even though it has no head commit.
    #[test]
    fn unborn_branch_is_not_detached() {
        let (_dir, repo) = init_repo();
        let page = build_log(&repo, &GitLogOptions::default(), Vec::new(), &no_cancel()).unwrap();
        assert!(page.commits.is_empty());
        assert!(!page.detached);
    }
}
