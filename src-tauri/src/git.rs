//! Git backend for the Source Control panel (#53).
//!
//! Thin wrapper around `git2` exposing the working-tree / index operations
//! the SCM UI needs: status, stage, unstage, discard, diff, commit, repo-root
//! resolution. A file watcher on `.git/index` and the work tree emits a
//! `git-status-changed` event so the UI can refresh without polling.
//!
//! Every command that touches the filesystem runs under
//! `tokio::task::spawn_blocking` so the Tauri async runtime is never blocked
//! by libgit2. Cancellation is wired through the shared `TaskRegistry`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use git2::{
    DiffFormat, DiffLineType, DiffOptions, ObjectType, Repository, Signature, Status, StatusOptions,
};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::git_common::{open_repo, to_app_err, workdir_key};
use crate::task_registry::TaskRegistry;

static GIT_TASKS: TaskRegistry = TaskRegistry::new();

/// Single-letter status code matching git porcelain conventions.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum GitStatusCode {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Conflicted,
    TypeChange,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitFileEntry {
    /// Repo-relative path (POSIX slashes).
    pub path: String,
    /// Original path for renames / copies.
    pub old_path: Option<String>,
    pub status: GitStatusCode,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusSummary {
    pub is_repo: bool,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub staged: Vec<GitFileEntry>,
    pub changes: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
    pub merge: Vec<GitFileEntry>,
    /// In-progress repo operation, from git2 `repo.state()`. One of
    /// `clean` | `merge` | `rebase` | `cherry_pick` | `revert`. Drives the
    /// SCM panel's in-progress banner (abort / continue). Operations we don't
    /// offer a workflow for (bisect, apply-mailbox, …) collapse to `clean`.
    pub op_state: String,
}

impl Default for GitStatusSummary {
    fn default() -> Self {
        GitStatusSummary {
            is_repo: false,
            repo_root: None,
            branch: None,
            detached: false,
            staged: Vec::new(),
            changes: Vec::new(),
            untracked: Vec::new(),
            merge: Vec::new(),
            op_state: "clean".to_string(),
        }
    }
}

/// Map git2's repository state to the SCM banner's operation vocabulary.
/// Only operations we expose abort/continue for get a distinct value;
/// everything else (clean, bisect, apply-mailbox) reports `clean`.
fn repo_op_state(repo: &Repository) -> &'static str {
    use git2::RepositoryState as S;
    match repo.state() {
        S::Merge => "merge",
        S::Revert | S::RevertSequence => "revert",
        S::CherryPick | S::CherryPickSequence => "cherry_pick",
        S::Rebase | S::RebaseInteractive | S::RebaseMerge => "rebase",
        _ => "clean",
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct GitDiscardOptions {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize, Default)]
pub struct GitDiffOptions {
    #[serde(default)]
    pub staged: bool,
}

#[derive(Debug, Deserialize, Default)]
pub struct GitCommitOptions {
    #[serde(default)]
    pub amend: bool,
}

#[derive(Debug, Serialize)]
pub struct GitCommitResult {
    pub commit_id: String,
    pub summary: String,
}

fn status_code(flags: Status) -> Option<GitStatusCode> {
    use GitStatusCode as C;

    if flags.is_conflicted() {
        return Some(C::Conflicted);
    }
    if flags.contains(Status::INDEX_NEW) || flags.contains(Status::WT_NEW) {
        if flags.contains(Status::WT_NEW)
            && !flags.intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED)
        {
            return Some(C::Untracked);
        }
        return Some(C::Added);
    }
    if flags.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        return Some(C::Deleted);
    }
    if flags.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        return Some(C::Renamed);
    }
    if flags.intersects(Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) {
        return Some(C::TypeChange);
    }
    if flags.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED) {
        return Some(C::Modified);
    }
    if flags.contains(Status::IGNORED) {
        return Some(C::Ignored);
    }
    None
}

#[derive(Default)]
struct Classified {
    staged: Option<GitFileEntry>,
    worktree: Option<GitFileEntry>,
    untracked: Option<GitFileEntry>,
    merge: Option<GitFileEntry>,
}

fn classify(entry: &git2::StatusEntry<'_>, workdir: &Path) -> Classified {
    let _ = workdir; // reserved for future absolute-path mapping
    let flags = entry.status();
    let mut out = Classified::default();

    if flags.is_conflicted() {
        let path = entry
            .index_to_workdir()
            .and_then(|d| d.new_file().path())
            .or_else(|| entry.head_to_index().and_then(|d| d.new_file().path()))
            .or_else(|| entry.path().map(Path::new))
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        if let Some(path) = path {
            out.merge = Some(GitFileEntry {
                path,
                old_path: None,
                status: GitStatusCode::Conflicted,
            });
        }
        return out;
    }

    let index_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE;

    // Untracked: working tree has a new file AND the index has nothing for it.
    if flags.contains(Status::WT_NEW) && !flags.intersects(index_flags) {
        if let Some(p) = entry.path() {
            out.untracked = Some(GitFileEntry {
                path: p.replace('\\', "/"),
                old_path: None,
                status: GitStatusCode::Untracked,
            });
        }
        return out;
    }

    // Staged side (HEAD → index)
    if flags.intersects(index_flags) {
        let code = status_code(flags & index_flags).unwrap_or(GitStatusCode::Modified);
        if let Some(delta) = entry.head_to_index() {
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            if let Some(path) = new_path.clone().or(old_path.clone()) {
                let old_path = match (old_path, &new_path) {
                    (Some(op), Some(np)) if op == *np => None,
                    (Some(op), _) => Some(op),
                    _ => None,
                };
                out.staged = Some(GitFileEntry {
                    path,
                    old_path,
                    status: code,
                });
            }
        }
    }

    let wt_flags =
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE;

    // Worktree side (index → workdir)
    if flags.intersects(wt_flags) {
        let code = status_code(flags & wt_flags).unwrap_or(GitStatusCode::Modified);
        if let Some(delta) = entry.index_to_workdir() {
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            if let Some(path) = new_path.clone().or(old_path.clone()) {
                let old_path = match (old_path, &new_path) {
                    (Some(op), Some(np)) if op == *np => None,
                    (Some(op), _) => Some(op),
                    _ => None,
                };
                out.worktree = Some(GitFileEntry {
                    path,
                    old_path,
                    status: code,
                });
            }
        }
    }

    out
}

/// Whether to hide status entries that have nothing to show.
///
/// On Windows, libgit2's status and diff disagree about the same file, and the
/// panel ends up listing rows the user can click into an empty diff ("No
/// changes to display"). Two ways this happens, both confirmed against real
/// repos:
///
/// - **exec bit** (#392): Windows can't read it — least of all over a
///   `\\wsl.localhost` UNC path — so a repo created under Linux
///   (`core.filemode = true`) reports every `100755` file as modified.
/// - **line endings** (#395): a CRLF working tree against LF blobs is listed
///   as modified by status, while the diff applies the line-ending filter and
///   comes back empty. Windows `git` itself reports the repo clean.
///
/// In both cases the honest answer is that nothing changed. A row that opens
/// onto an empty diff is strictly worse than no row, so drop it. Off Windows
/// none of this applies (a chmod there IS a real change) and the check — which
/// costs two extra diffs — is skipped entirely.
fn hides_empty_diffs() -> bool {
    cfg!(windows)
}

/// Of `candidates` (repo-relative paths flagged modified/typechange), the ones
/// that still show up in an actual diff. Returns the surviving
/// `(staged, worktree)` paths; anything absent has an empty diff and is,
/// as far as the user can act on it, unchanged.
fn content_changed(
    repo: &Repository,
    candidates: &[String],
) -> Result<(HashSet<String>, HashSet<String>), AppError> {
    // A delta is NOT enough: libgit2 reports a delta for a CRLF-vs-LF file
    // whose patch, once the line-ending filter has run, has no hunks at all
    // (#395) — that delta is precisely the dead-end row we're trying to drop.
    // Keep a path only if it has something displayable: at least one hunk, or
    // a binary change (which the preview renders as "Binary file changed").
    let displayable_paths = |diff: git2::Diff<'_>| {
        let mut out = HashSet::new();
        for (i, delta) in diff.deltas().enumerate() {
            let Some(path) = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
            else {
                continue;
            };
            let has_hunks = matches!(
                git2::Patch::from_diff(&diff, i),
                Ok(Some(ref p)) if p.num_hunks() > 0
            );
            if has_hunks || delta.flags().is_binary() {
                out.insert(path);
            }
        }
        out
    };

    // Pathspec-limited so the extra diffs cost work proportional to the number
    // of changed files, not to the size of the tree.
    let mut opts = DiffOptions::new();
    opts.ignore_filemode(true);
    for c in candidates {
        opts.pathspec(c);
    }

    let head_tree = match repo.head() {
        Ok(h) => Some(h.peel_to_tree().map_err(to_app_err)?),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
        Err(e) => return Err(to_app_err(e)),
    };
    let staged = displayable_paths(
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(to_app_err)?,
    );
    let worktree = displayable_paths(
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(to_app_err)?,
    );
    Ok((staged, worktree))
}

/// A status entry that could turn out to have an empty diff. A delete, a
/// rename or an add always has something to show.
fn may_have_empty_diff(entry: &GitFileEntry) -> bool {
    matches!(
        entry.status,
        GitStatusCode::Modified | GitStatusCode::TypeChange
    )
}

// pub: exercised directly by the `git_status` criterion bench
// (src-tauri/benches/git_status.rs).
pub fn collect_status(repo: &Repository) -> Result<GitStatusSummary, AppError> {
    collect_status_inner(repo, hides_empty_diffs())
}

fn collect_status_inner(
    repo: &Repository,
    hide_empty_diffs: bool,
) -> Result<GitStatusSummary, AppError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Other("git: bare repository has no working tree".into()))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(to_app_err)?;

    let mut summary = GitStatusSummary {
        is_repo: true,
        repo_root: workdir_key(repo),
        branch: None,
        detached: false,
        op_state: repo_op_state(repo).to_string(),
        ..Default::default()
    };

    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                summary.branch = head.shorthand().map(|s| s.to_string());
            } else {
                summary.detached = true;
                summary.branch = head.target().map(|oid| format!("{:.7}", oid));
            }
        }
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
            // Freshly init'd repo: no HEAD yet.
            summary.branch = Some("main".into());
        }
        Err(e) => return Err(to_app_err(e)),
    }

    for entry in statuses.iter() {
        let c = classify(&entry, workdir);
        if let Some(m) = c.merge {
            summary.merge.push(m);
            continue;
        }
        if let Some(u) = c.untracked {
            summary.untracked.push(u);
            continue;
        }
        if let Some(s) = c.staged {
            summary.staged.push(s);
        }
        if let Some(w) = c.worktree {
            summary.changes.push(w);
        }
    }

    if hide_empty_diffs {
        let candidates: Vec<String> = summary
            .staged
            .iter()
            .chain(summary.changes.iter())
            .filter(|e| may_have_empty_diff(e))
            .map(|e| e.path.clone())
            .collect();
        if !candidates.is_empty() {
            let (staged_keep, worktree_keep) = content_changed(repo, &candidates)?;
            summary
                .staged
                .retain(|e| !may_have_empty_diff(e) || staged_keep.contains(&e.path));
            summary
                .changes
                .retain(|e| !may_have_empty_diff(e) || worktree_keep.contains(&e.path));
        }
    }

    Ok(summary)
}

fn map_non_repo(path: &Path) -> Result<GitStatusSummary, AppError> {
    Ok(GitStatusSummary {
        is_repo: false,
        repo_root: None,
        branch: None,
        detached: false,
        staged: Vec::new(),
        changes: Vec::new(),
        untracked: Vec::new(),
        merge: Vec::new(),
        op_state: "clean".to_string(),
    })
    .inspect(|_s| {
        let _ = path;
    })
}

async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(Arc<AtomicBool>) -> Result<T, AppError> + Send + 'static,
{
    let (id, cancelled) = GIT_TASKS.start();
    let handle = tokio::task::spawn_blocking(move || f(cancelled));
    let result = handle.await;
    GIT_TASKS.cleanup(id);
    result.map_err(|e| AppError::Other(format!("git task join: {e}")))?
}

/// Initialize a new git repository at `path`. No-op if one already exists.
/// Returns the new (or existing) repo root.
#[tauri::command]
pub async fn git_init(path: String) -> Result<String, AppError> {
    run_blocking(move |_cancel| {
        let p = PathBuf::from(&path);
        if let Ok(existing) = open_repo(&p) {
            if let Some(root) = workdir_key(&existing) {
                return Ok(root);
            }
        }
        let repo = Repository::init(&p).map_err(to_app_err)?;
        let root = workdir_key(&repo)
            .ok_or_else(|| AppError::Other("git: init produced a bare repository".into()))?;
        Ok(root)
    })
    .await
}

/// Append `entry` to `.gitignore` at the repo root, creating the file if
/// missing. Idempotent — does nothing if the entry is already present.
/// Returns the relative path that was written.
#[tauri::command]
pub async fn git_add_to_gitignore(repo_root: String, entry: String) -> Result<String, AppError> {
    run_blocking(move |_cancel| {
        let root = PathBuf::from(&repo_root);
        let normalized = entry
            .trim_start_matches("./")
            .trim_start_matches('/')
            .to_string();
        if normalized.is_empty() {
            return Err(AppError::Other("ignore entry is empty".into()));
        }
        let gitignore_path = root.join(".gitignore");
        let existing = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
        let already_present = existing.lines().map(|l| l.trim()).any(|l| l == normalized);
        if already_present {
            return Ok(normalized);
        }
        let needs_leading_newline = !existing.is_empty() && !existing.ends_with('\n');
        let mut next = existing;
        if needs_leading_newline {
            next.push('\n');
        }
        next.push_str(&normalized);
        next.push('\n');
        std::fs::write(&gitignore_path, next.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write .gitignore: {}", e)))?;
        Ok(normalized)
    })
    .await
}

/// Resolve the repo root that contains `path`, or `None` if outside any repo.
#[tauri::command]
pub async fn git_repo_root(path: String) -> Result<Option<String>, AppError> {
    run_blocking(move |_cancel| {
        let p = PathBuf::from(&path);
        match open_repo(&p) {
            Ok(repo) => Ok(workdir_key(&repo)),
            Err(_) => Ok(None),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusSummary, AppError> {
    run_blocking(move |_cancel| {
        let p = PathBuf::from(&repo_path);
        match open_repo(&p) {
            Ok(repo) => collect_status(&repo),
            Err(_) => map_non_repo(&p),
        }
    })
    .await
}

fn stage_paths_inner(repo: &Repository, paths: &[String]) -> Result<(), AppError> {
    let mut index = repo.index().map_err(to_app_err)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Other("git: bare repository has no working tree".into()))?;
    for p in paths {
        let pp = Path::new(p);
        // Deleted files: remove from index. Others: add.
        let abs = workdir.join(pp);
        if abs.exists() {
            index.add_path(pp).map_err(to_app_err)?;
        } else {
            index.remove_path(pp).map_err(to_app_err)?;
        }
    }
    index.write().map_err(to_app_err)?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        stage_paths_inner(&repo, &paths)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let head_result = repo.head();
        match head_result {
            Ok(head) => {
                let obj = head.peel(ObjectType::Commit).map_err(to_app_err)?;
                let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
                repo.reset_default(Some(&obj), refs).map_err(to_app_err)
            }
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
                let mut index = repo.index().map_err(to_app_err)?;
                for p in &paths {
                    index.remove_path(Path::new(p)).map_err(to_app_err)?;
                }
                index.write().map_err(to_app_err)
            }
            Err(e) => Err(to_app_err(e)),
        }
    })
    .await
}

fn has_staged_changes_for(repo: &Repository, path: &str) -> Result<bool, AppError> {
    let mut opts = StatusOptions::new();
    opts.pathspec(path);
    let statuses = repo.statuses(Some(&mut opts)).map_err(to_app_err)?;
    for s in statuses.iter() {
        let flags = s.status();
        if flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn git_discard(
    repo_path: String,
    paths: Vec<String>,
    options: Option<GitDiscardOptions>,
) -> Result<(), AppError> {
    let opts = options.unwrap_or_default();
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;

        if !opts.force {
            for p in &paths {
                if has_staged_changes_for(&repo, p)? {
                    return Err(AppError::Other(format!(
                        "refusing to discard '{}' with staged changes; pass force=true to override",
                        p
                    )));
                }
            }
        }

        let workdir = repo
            .workdir()
            .ok_or_else(|| AppError::Other("git: bare repository has no working tree".into()))?
            .to_path_buf();

        let index = repo.index().map_err(to_app_err)?;

        // Conflicted paths have NO stage-0 index entry (only stages 1/2/3),
        // so the stage-0 probe below would misclassify them as untracked and
        // DELETE them from disk — silent data loss. Detect them explicitly and
        // refuse: discarding a conflict has no single obviously-correct
        // resolution (ours vs theirs vs base), so the safe action is to make
        // the user resolve the file or abort the whole operation. Never falls
        // into the untracked-delete branch.
        for p in &paths {
            let pp = Path::new(p);
            if index.get_path(pp, 1).is_some()
                || index.get_path(pp, 2).is_some()
                || index.get_path(pp, 3).is_some()
            {
                return Err(AppError::Other(format!(
                    "cannot discard '{}': it has an unresolved merge conflict. \
                     Resolve the conflict (stage the file) or abort the operation.",
                    p
                )));
            }
        }

        // For tracked files, checkout from HEAD / index restores contents.
        // For untracked files (no HEAD/index entry), just delete from disk.
        let mut checkout_paths: Vec<String> = Vec::new();
        let mut delete_paths: Vec<PathBuf> = Vec::new();

        for p in &paths {
            if index.get_path(Path::new(p), 0).is_some() {
                checkout_paths.push(p.clone());
            } else {
                delete_paths.push(workdir.join(p));
            }
        }

        if !checkout_paths.is_empty() {
            let mut co = git2::build::CheckoutBuilder::new();
            co.force();
            for p in &checkout_paths {
                co.path(p);
            }
            repo.checkout_head(Some(&mut co)).map_err(to_app_err)?;
        }
        for p in &delete_paths {
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(p);
            } else if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }

        Ok(())
    })
    .await
}

fn render_diff(diff: git2::Diff<'_>) -> Result<String, AppError> {
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin_value() {
            DiffLineType::Addition => "+",
            DiffLineType::Deletion => "-",
            DiffLineType::Context => " ",
            DiffLineType::FileHeader | DiffLineType::HunkHeader | DiffLineType::Binary => "",
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
pub async fn git_diff(
    repo_path: String,
    path: String,
    options: Option<GitDiffOptions>,
) -> Result<String, AppError> {
    let opts = options.unwrap_or_default();
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let mut diff_opts = DiffOptions::new();
        diff_opts.pathspec(&path);
        diff_opts.context_lines(3);
        // Same policy as the status list: on Windows a mode difference is an
        // artifact, not a change, so it must not render as a diff either (#392).
        diff_opts.ignore_filemode(hides_empty_diffs());

        let diff = if opts.staged {
            let head_tree = match repo.head() {
                Ok(h) => Some(h.peel_to_tree().map_err(to_app_err)?),
                Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
                Err(e) => return Err(to_app_err(e)),
            };
            repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
                .map_err(to_app_err)?
        } else {
            repo.diff_index_to_workdir(None, Some(&mut diff_opts))
                .map_err(to_app_err)?
        };

        render_diff(diff)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    repo_path: String,
    message: String,
    options: Option<GitCommitOptions>,
) -> Result<GitCommitResult, AppError> {
    let opts = options.unwrap_or_default();
    if message.trim().is_empty() && !opts.amend {
        return Err(AppError::Other("commit message cannot be empty".into()));
    }
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let sig = match repo.signature() {
            Ok(s) => s,
            Err(_) => {
                Signature::now("tauri-explorer", "noreply@example.com").map_err(to_app_err)?
            }
        };

        let mut index = repo.index().map_err(to_app_err)?;

        // Guard unresolved merge conflicts up front with a clear message,
        // rather than letting `write_tree` fail with a raw GIT_EUNMERGED. git
        // itself refuses to commit while any path is unmerged.
        if index.has_conflicts() {
            let n = index.conflicts().map(|c| c.count()).unwrap_or(0);
            return Err(AppError::Other(format!(
                "resolve {} conflicted file(s) before committing",
                n.max(1)
            )));
        }

        let tree_oid = index.write_tree().map_err(to_app_err)?;
        let tree = repo.find_tree(tree_oid).map_err(to_app_err)?;

        let head = match repo.head() {
            Ok(h) => Some(h),
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
            Err(e) => return Err(to_app_err(e)),
        };

        let parent_commit = match head.as_ref() {
            Some(h) => Some(h.peel_to_commit().map_err(to_app_err)?),
            None => None,
        };

        let oid = if opts.amend {
            let parent = parent_commit.ok_or_else(|| AppError::Other("nothing to amend".into()))?;
            let msg = if message.trim().is_empty() {
                parent.message().unwrap_or("").to_string()
            } else {
                message.clone()
            };
            parent
                .amend(
                    Some("HEAD"),
                    Some(&sig),
                    Some(&sig),
                    None,
                    Some(&msg),
                    Some(&tree),
                )
                .map_err(to_app_err)?
        } else {
            let parents: Vec<&git2::Commit<'_>> =
                parent_commit.as_ref().map(|p| vec![p]).unwrap_or_default();
            repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
                .map_err(to_app_err)?
        };

        let commit = repo.find_commit(oid).map_err(to_app_err)?;
        Ok(GitCommitResult {
            commit_id: oid.to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
        })
    })
    .await
}

// ----- File watcher ----- //

struct WatcherEntry {
    _watcher: Box<dyn Watcher + Send>,
    /// Refcount (#334): multiple panes (or windows) can watch the same repo;
    /// the OS watcher is dropped only when the last consumer unwatches.
    count: usize,
}

static WATCHERS: OnceLock<Mutex<std::collections::HashMap<String, WatcherEntry>>> = OnceLock::new();

fn watchers_map() -> &'static Mutex<std::collections::HashMap<String, WatcherEntry>> {
    WATCHERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Start watching a repo for index/worktree changes. Emits `git-status-changed`
/// with the repo root path. Idempotent per-repo.
#[tauri::command]
pub async fn git_watch_repo(app: AppHandle, repo_path: String) -> Result<(), AppError> {
    let (repo_root, git_dir) = match open_repo(Path::new(&repo_path)) {
        Ok(r) => {
            let root = r
                .workdir()
                .map(|p| p.to_path_buf())
                .ok_or_else(|| AppError::Other("git: bare repo cannot be watched".into()))?;
            (root, r.path().to_path_buf())
        }
        Err(_) => return Ok(()), // silently no-op when not a repo
    };
    let key = watch_key_for(&repo_path);

    let mut map = watchers_map()
        .lock()
        .map_err(|e| AppError::Other(format!("git watchers lock poisoned: {e}")))?;
    if let Some(entry) = map.get_mut(&key) {
        entry.count += 1;
        return Ok(());
    }

    let app_for_watcher = app.clone();
    let key_for_event = key.clone();
    let last_emit: Arc<Mutex<Instant>> =
        Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let trailing_pending = Arc::new(AtomicBool::new(false));
    let handler = move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Ignore ephemeral lock files; coalesce emits to at most once per 200ms.
            let relevant = event.paths.iter().any(|p| {
                let s = p.to_string_lossy();
                !s.ends_with(".lock") && !s.ends_with("~")
            });
            if !relevant {
                return;
            }
            let mut last = last_emit.lock().unwrap_or_else(|poisoned| {
                log::error!("git watcher last_emit lock poisoned, recovering");
                poisoned.into_inner()
            });
            if last.elapsed() < Duration::from_millis(200) {
                drop(last);
                // Within the quiet window: schedule a single trailing emit so
                // the last change in a burst is not dropped.
                if !trailing_pending.swap(true, Ordering::SeqCst) {
                    let app = app_for_watcher.clone();
                    let key = key_for_event.clone();
                    let last_emit = Arc::clone(&last_emit);
                    let trailing_pending = Arc::clone(&trailing_pending);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(200));
                        let mut last = last_emit.lock().unwrap_or_else(|poisoned| {
                            log::error!("git watcher last_emit lock poisoned, recovering");
                            poisoned.into_inner()
                        });
                        *last = Instant::now();
                        drop(last);
                        trailing_pending.store(false, Ordering::SeqCst);
                        let _ = app.emit("git-status-changed", &key);
                    });
                }
                return;
            }
            *last = Instant::now();
            drop(last);
            let _ = app_for_watcher.emit("git-status-changed", &key_for_event);
        }
    };
    // WSL/network shares (\\wsl$\…, \\wsl.localhost\…) don't deliver native
    // change notifications to Windows — ReadDirectoryChangesW is effectively
    // a no-op over 9P — so a natively-watched repo there never fires and the
    // SCM panel looks frozen until reopened (#387). Poll those instead.
    let is_unc = key.starts_with("\\\\") || key.starts_with("//");
    let mut watcher: Box<dyn Watcher + Send> = if is_unc {
        Box::new(
            notify::PollWatcher::new(
                handler,
                notify::Config::default().with_poll_interval(Duration::from_secs(3)),
            )
            .map_err(|e| AppError::Other(format!("git watch: {e}")))?,
        )
    } else {
        Box::new(
            notify::recommended_watcher(handler)
                .map_err(|e| AppError::Other(format!("git watch: {e}")))?,
        )
    };

    watcher
        .watch(&repo_root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Other(format!("git watch: {e}")))?;
    // The recursive worktree watch above already covers `.git` when it lives
    // inside the work tree; watching it again would double every event. Only
    // watch the git dir separately when it lives elsewhere (linked worktrees).
    if !git_dir.starts_with(&repo_root) {
        let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
    }
    map.insert(
        key,
        WatcherEntry {
            _watcher: watcher,
            count: 1,
        },
    );
    Ok(())
}

/// The watcher-map key for a repo path: the normalized workdir (via
/// `workdir_key`) or the path itself when it isn't a repo. Watch AND unwatch
/// must derive keys identically — unwatch previously kept git2's trailing
/// slash while watch stripped it, so refcounts never decremented and
/// watchers leaked (#387).
fn watch_key_for(repo_path: &str) -> String {
    match open_repo(Path::new(repo_path)) {
        Ok(r) => workdir_key(&r).unwrap_or_else(|| repo_path.to_string()),
        Err(_) => repo_path.to_string(),
    }
}

#[tauri::command]
pub async fn git_unwatch_repo(repo_path: String) -> Result<(), AppError> {
    let key = watch_key_for(&repo_path);
    let mut map = watchers_map()
        .lock()
        .map_err(|e| AppError::Other(format!("git watchers lock poisoned: {e}")))?;
    if let Some(entry) = map.get_mut(&key) {
        if entry.count > 1 {
            entry.count -= 1;
        } else {
            map.remove(&key);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test User").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
            cfg.set_str("commit.gpgsign", "false").unwrap();
        }
        dir
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    fn sync_status(path: &Path) -> GitStatusSummary {
        match open_repo(path) {
            Ok(repo) => collect_status(&repo).unwrap(),
            Err(_) => map_non_repo(path).unwrap(),
        }
    }

    fn commit_all(dir: &Path, msg: &str) {
        Command::new("git")
            .current_dir(dir)
            .args(["add", "-A"])
            .status()
            .unwrap();
        Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .args(["commit", "-m", msg])
            .status()
            .unwrap();
    }

    /// A mode-only change (chmod +x) is what Windows manufactures for every
    /// 0755 file in a Linux-created repo, and it renders as a change with an
    /// empty diff (#392). With the hide-empty-diffs policy on, it must not
    /// reach the SCM panel; with it off (the Linux default), a real chmod
    /// still must.
    #[cfg(unix)]
    #[test]
    fn mode_only_change_is_dropped_only_when_empty_diffs_are_hidden() {
        use std::os::unix::fs::PermissionsExt;

        let dir = init_repo();
        write(dir.path(), "script.sh", "#!/bin/sh\necho hi\n");
        write(dir.path(), "notes.txt", "hello\n");
        commit_all(dir.path(), "init");

        let script = dir.path().join("script.sh");
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();

        let repo = open_repo(dir.path()).unwrap();
        // core.filemode is what makes libgit2 compare modes at all.
        repo.config().unwrap().set_bool("core.filemode", true).unwrap();

        let honoring = collect_status_inner(&repo, false).unwrap();
        assert!(
            honoring.changes.iter().any(|e| e.path == "script.sh"),
            "a real chmod must show as a change when modes are honored: {:?}",
            honoring.changes
        );

        let ignoring = collect_status_inner(&repo, true).unwrap();
        assert!(
            ignoring.changes.is_empty(),
            "mode-only change must not surface when modes are ignored: {:?}",
            ignoring.changes
        );

        // A genuine content edit still surfaces under the ignoring policy.
        write(dir.path(), "notes.txt", "hello\nworld\n");
        let ignoring = collect_status_inner(&repo, true).unwrap();
        assert!(
            ignoring.changes.iter().any(|e| e.path == "notes.txt"),
            "content changes must survive: {:?}",
            ignoring.changes
        );
        assert!(
            !ignoring.changes.iter().any(|e| e.path == "script.sh"),
            "mode-only change must stay dropped: {:?}",
            ignoring.changes
        );
    }

    /// The other way a Windows status entry ends up with nothing behind it
    /// (#395): a CRLF working tree against LF blobs with `core.autocrlf` on.
    /// libgit2's status lists the file, its diff filters the line endings away
    /// and comes back empty — Windows `git` calls the repo clean. The row must
    /// not survive to the panel, because clicking it can only ever say "No
    /// changes to display".
    #[test]
    fn crlf_only_change_with_an_empty_diff_is_dropped() {
        let dir = init_repo();
        write(dir.path(), "script.ahk", "MsgBox\nReturn\n"); // LF in the blob
        commit_all(dir.path(), "init");

        let repo = open_repo(dir.path()).unwrap();
        repo.config().unwrap().set_bool("core.autocrlf", true).unwrap();
        // Rewrite the working tree with CRLF, as a Windows checkout would.
        fs::write(dir.path().join("script.ahk"), "MsgBox\r\nReturn\r\n").unwrap();

        // Precondition: the diff for this file really is empty (this is what
        // makes the panel row a dead end).
        let mut o = DiffOptions::new();
        o.pathspec("script.ahk");
        let patch = render_diff(
            repo.diff_index_to_workdir(None, Some(&mut o)).unwrap(),
        )
        .unwrap();
        assert!(patch.is_empty(), "expected an empty diff, got: {patch:?}");

        let hiding = collect_status_inner(&repo, true).unwrap();
        assert!(
            !hiding.changes.iter().any(|e| e.path == "script.ahk"),
            "a file whose diff is empty must not be listed: {:?}",
            hiding.changes
        );

        // A real edit to the same file still surfaces.
        fs::write(
            dir.path().join("script.ahk"),
            "MsgBox\r\nReturn\r\nExitApp\r\n",
        )
        .unwrap();
        let hiding = collect_status_inner(&repo, true).unwrap();
        assert!(
            hiding.changes.iter().any(|e| e.path == "script.ahk"),
            "a real content change must survive: {:?}",
            hiding.changes
        );
    }

    #[test]
    fn watch_and_unwatch_derive_identical_keys() {
        // Unwatch used git2's raw (trailing-slash) workdir while watch
        // stripped it — refcounts never decremented, watchers leaked (#387).
        let dir = init_repo();
        let plain = dir.path().to_str().unwrap().to_string();
        let slashed = format!("{plain}/");
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let from_subdir = sub.to_str().unwrap().to_string();

        let key = watch_key_for(&plain);
        assert!(!key.ends_with('/') && !key.ends_with('\\'), "key: {key}");
        assert_eq!(watch_key_for(&slashed), key);
        assert_eq!(watch_key_for(&from_subdir), key, "subdir resolves to the same repo key");
        // Non-repo path: passes through unchanged.
        let other = TempDir::new().unwrap();
        let p = other.path().to_str().unwrap().to_string();
        assert_eq!(watch_key_for(&p), p);
    }

    #[test]
    fn repo_root_is_reported_without_trailing_separator() {
        // git2's workdir() keeps a trailing slash; the emitted root must not,
        // or the same repo gets two identities in path-keyed caches (#369).
        let dir = init_repo();
        write(dir.path(), "a.txt", "hello\n");
        commit_all(dir.path(), "init");

        let repo = open_repo(dir.path()).unwrap();
        let key = workdir_key(&repo).unwrap();
        assert!(!key.ends_with('/') && !key.ends_with('\\'), "key: {key}");
        assert!(key.len() > 1);

        let s = sync_status(dir.path());
        let root = s.repo_root.unwrap();
        assert!(!root.ends_with('/') && !root.ends_with('\\'), "root: {root}");
    }

    #[test]
    fn non_repo_path_reports_not_a_repo() {
        let dir = TempDir::new().unwrap();
        let s = sync_status(dir.path());
        assert!(!s.is_repo);
        assert!(s.staged.is_empty());
        assert!(s.changes.is_empty());
    }

    #[test]
    fn clean_repo_has_no_changes() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "hello\n");
        commit_all(dir.path(), "init");

        let s = sync_status(dir.path());
        assert!(s.is_repo);
        assert!(s.staged.is_empty());
        assert!(s.changes.is_empty());
        assert!(s.untracked.is_empty());
    }

    #[test]
    fn untracked_files_appear_in_untracked() {
        let dir = init_repo();
        write(dir.path(), "tracked.txt", "v1\n");
        commit_all(dir.path(), "init");

        write(dir.path(), "new.txt", "x\n");

        let s = sync_status(dir.path());
        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "new.txt");
        assert!(matches!(s.untracked[0].status, GitStatusCode::Untracked));
    }

    #[test]
    fn staged_and_unstaged_mix() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        write(dir.path(), "b.txt", "v1\n");
        commit_all(dir.path(), "init");

        // Stage a modification on a.txt
        write(dir.path(), "a.txt", "v2\n");
        Command::new("git")
            .current_dir(dir.path())
            .args(["add", "a.txt"])
            .status()
            .unwrap();

        // Modify b.txt in the worktree without staging
        write(dir.path(), "b.txt", "v2\n");

        let s = sync_status(dir.path());
        assert_eq!(s.staged.len(), 1, "staged={:?}", s.staged);
        assert_eq!(s.staged[0].path, "a.txt");
        assert_eq!(s.changes.len(), 1, "changes={:?}", s.changes);
        assert_eq!(s.changes[0].path, "b.txt");
    }

    #[test]
    fn detached_head_is_reported() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "v2\n");
        commit_all(dir.path(), "second");

        // Detach HEAD to first commit
        let out = Command::new("git")
            .current_dir(dir.path())
            .args(["rev-list", "--max-parents=0", "HEAD"])
            .output()
            .unwrap();
        let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Command::new("git")
            .current_dir(dir.path())
            .args(["checkout", &root])
            .status()
            .unwrap();

        let s = sync_status(dir.path());
        assert!(s.detached);
    }

    #[test]
    fn merge_conflicts_appear_in_merge() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "root\n");
        commit_all(dir.path(), "root");

        Command::new("git")
            .current_dir(dir.path())
            .args(["checkout", "-b", "feature"])
            .status()
            .unwrap();
        write(dir.path(), "a.txt", "feature\n");
        commit_all(dir.path(), "feature");

        Command::new("git")
            .current_dir(dir.path())
            .args(["checkout", "-"])
            .status()
            .unwrap();
        write(dir.path(), "a.txt", "main\n");
        commit_all(dir.path(), "main");

        let _ = Command::new("git")
            .current_dir(dir.path())
            .args(["merge", "feature"])
            .status();

        let s = sync_status(dir.path());
        assert!(!s.merge.is_empty(), "expected conflicts, got {:?}", s);
        assert!(matches!(s.merge[0].status, GitStatusCode::Conflicted));
    }

    #[test]
    fn stage_moves_file_between_sections() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "v2\n");

        let repo = open_repo(dir.path()).unwrap();
        stage_paths_inner(&repo, &["a.txt".into()]).unwrap();

        let s = sync_status(dir.path());
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "a.txt");
        assert!(s.changes.is_empty());
    }

    #[test]
    fn discard_reverts_worktree_changes() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "original\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "dirty\n");

        let repo = open_repo(dir.path()).unwrap();
        assert!(!has_staged_changes_for(&repo, "a.txt").unwrap());

        // Run the core path (inline rather than tokio) to verify behavior.
        let mut co = git2::build::CheckoutBuilder::new();
        co.force().path("a.txt");
        repo.checkout_head(Some(&mut co)).unwrap();

        let content = fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert_eq!(content, "original\n");
    }

    /// Minimal single-threaded executor for the few async command tests.
    fn tokio_test_block<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }

    /// Build a repo left in a conflicted merge state on `a.txt`.
    fn conflicted_repo() -> TempDir {
        let dir = init_repo();
        write(dir.path(), "a.txt", "root\n");
        commit_all(dir.path(), "root");

        Command::new("git")
            .current_dir(dir.path())
            .args(["checkout", "-b", "feature"])
            .status()
            .unwrap();
        write(dir.path(), "a.txt", "feature\n");
        commit_all(dir.path(), "feature");

        Command::new("git")
            .current_dir(dir.path())
            .args(["checkout", "-"])
            .status()
            .unwrap();
        write(dir.path(), "a.txt", "main\n");
        commit_all(dir.path(), "main");

        let _ = Command::new("git")
            .current_dir(dir.path())
            .args(["merge", "feature"])
            .status();
        dir
    }

    #[test]
    fn conflicted_merge_reports_op_state_merge() {
        let dir = conflicted_repo();
        let s = sync_status(dir.path());
        assert_eq!(s.op_state, "merge");
        assert!(!s.merge.is_empty());
    }

    #[test]
    fn clean_repo_reports_op_state_clean() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "hello\n");
        commit_all(dir.path(), "init");
        let s = sync_status(dir.path());
        assert_eq!(s.op_state, "clean");
    }

    #[test]
    fn commit_while_conflicted_is_blocked() {
        let dir = conflicted_repo();
        let path = dir.path().to_str().unwrap().to_string();
        let err = tokio_test_block(git_commit(path, "resolve merge".into(), None));
        match err {
            Err(AppError::Other(m)) => {
                assert!(
                    m.contains("conflicted") && m.contains("before committing"),
                    "unexpected message: {m}"
                );
            }
            other => panic!("expected guard error, got {other:?}"),
        }
        // HEAD is unchanged: the "main" commit is still the tip (merge not made).
        let tip = Command::new("git")
            .current_dir(dir.path())
            .args(["log", "-1", "--format=%s"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&tip.stdout).trim(), "main");
    }

    #[test]
    fn discard_on_conflicted_file_does_not_delete_it() {
        let dir = conflicted_repo();
        let file = dir.path().join("a.txt");
        assert!(file.exists());
        let path = dir.path().to_str().unwrap().to_string();

        let res = tokio_test_block(git_discard(path, vec!["a.txt".into()], None));
        // Refuses rather than silently deleting.
        assert!(matches!(res, Err(AppError::Other(m)) if m.contains("unresolved merge conflict")));
        // Critically: the file is still on disk (no data loss).
        assert!(file.exists(), "conflicted file must not be deleted");
    }

    /// Contract tests mirroring the mock-side vitest suite in
    /// `tests/contract/git.contract.test.ts`. Both suites drive their backend
    /// (real git2 here, mock-invoke there) through the same scenarios and assert
    /// against the same shared JSON fixtures embedded below. If the mock's
    /// classification / guards drift from real git behavior, one side fails.
    mod contract {
        use super::*;
        use serde_json::{json, Value};

        fn fixture(name: &str) -> Value {
            let raw = match name {
                "git_status.json" => {
                    include_str!("../../tests/contract/fixtures/git_status.json")
                }
                "git_commit.json" => {
                    include_str!("../../tests/contract/fixtures/git_commit.json")
                }
                "git_discard.json" => {
                    include_str!("../../tests/contract/fixtures/git_discard.json")
                }
                other => panic!("unknown fixture {other}"),
            };
            serde_json::from_str(raw).expect("fixture is valid JSON")
        }

        /// { statusCode: count } histogram for one bucket. Mirrors the JS
        /// `counts()` helper — paths are dropped, only classification counts.
        fn bucket_counts(entries: &[GitFileEntry]) -> Value {
            let mut m = serde_json::Map::new();
            for e in entries {
                let key = match serde_json::to_value(e.status).unwrap() {
                    Value::String(s) => s,
                    other => panic!("status did not serialize to a string: {other:?}"),
                };
                let next = m.get(&key).and_then(Value::as_u64).unwrap_or(0) + 1;
                m.insert(key, json!(next));
            }
            Value::Object(m)
        }

        fn normalize(s: &GitStatusSummary) -> Value {
            json!({
                "op_state": s.op_state,
                "staged": bucket_counts(&s.staged),
                "changes": bucket_counts(&s.changes),
                "untracked": bucket_counts(&s.untracked),
                "merge": bucket_counts(&s.merge),
            })
        }

        #[test]
        fn git_status_clean_matches_fixture() {
            let dir = init_repo();
            write(dir.path(), "a.txt", "hello\n");
            commit_all(dir.path(), "init");
            assert_eq!(
                normalize(&sync_status(dir.path())),
                fixture("git_status.json")["clean"]
            );
        }

        #[test]
        fn git_status_dirty_tree_matches_fixture() {
            let dir = init_repo();
            write(dir.path(), "t1.txt", "v1\n");
            write(dir.path(), "t2.txt", "v1\n");
            write(dir.path(), "t3.txt", "v1\n");
            commit_all(dir.path(), "init");

            // One staged modification.
            write(dir.path(), "t1.txt", "v2\n");
            {
                let repo = open_repo(dir.path()).unwrap();
                stage_paths_inner(&repo, &["t1.txt".into()]).unwrap();
            }
            // Two unstaged worktree modifications.
            write(dir.path(), "t2.txt", "v2\n");
            write(dir.path(), "t3.txt", "v2\n");
            // Three untracked files.
            write(dir.path(), "u1.txt", "x\n");
            write(dir.path(), "u2.txt", "x\n");
            write(dir.path(), "u3.txt", "x\n");

            assert_eq!(
                normalize(&sync_status(dir.path())),
                fixture("git_status.json")["dirty_tree"]
            );
        }

        #[test]
        fn git_status_conflicted_merge_matches_fixture() {
            let dir = conflicted_repo();
            assert_eq!(
                normalize(&sync_status(dir.path())),
                fixture("git_status.json")["conflicted_merge"]
            );
        }

        #[test]
        fn git_commit_conflict_guard_matches_fixture() {
            let dir = conflicted_repo();
            let fx = fixture("git_commit.json");
            let sub = fx["commit_while_conflicted"]["error_substring"]
                .as_str()
                .unwrap();
            let path = dir.path().to_str().unwrap().to_string();
            match tokio_test_block(git_commit(path, "resolve merge".into(), None)) {
                Err(AppError::Other(m)) => {
                    assert!(m.contains(sub), "message {m:?} lacks {sub:?}")
                }
                other => panic!("expected guard error, got {other:?}"),
            }
        }

        #[test]
        fn git_discard_conflict_guard_matches_fixture() {
            let dir = conflicted_repo();
            let fx = fixture("git_discard.json");
            let sub = fx["discard_conflicted_refuses"]["error_substring"]
                .as_str()
                .unwrap();
            let file = dir.path().join("a.txt");
            let path = dir.path().to_str().unwrap().to_string();
            match tokio_test_block(git_discard(path, vec!["a.txt".into()], None)) {
                Err(AppError::Other(m)) => {
                    assert!(m.contains(sub), "message {m:?} lacks {sub:?}")
                }
                other => panic!("expected guard error, got {other:?}"),
            }
            // Refusing must not delete the conflicted file.
            assert!(file.exists(), "conflicted file must not be deleted");
        }
    }
}
