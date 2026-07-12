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
    /// First line of the commit message.
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
                summary: message,
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
    if let Some(names) = &opts.branches {
        for name in names {
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
        if let Ok(branches) = repo.branches(None) {
            for b in branches.flatten() {
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
        });
    }

    let mut commits = Vec::with_capacity(limit.min(1024));
    let mut skipped = 0usize;
    let mut has_more = false;

    for (i, step) in walk.enumerate() {
        // Cooperative cancellation — check periodically to avoid overhead.
        if i % 256 == 0 && cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Other("git log cancelled".into()));
        }
        let oid = step.map_err(to_app_err)?;

        if skipped < opts.skip {
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
            summary: commit.summary().unwrap_or("").to_string(),
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
    })
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
            out.detached = repo.head_detached().unwrap_or(false);
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
}
