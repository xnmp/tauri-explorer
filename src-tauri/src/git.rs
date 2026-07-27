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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

    let statuses_start = Instant::now();
    let statuses = repo.statuses(Some(&mut opts)).map_err(to_app_err)?;
    let statuses_ms = statuses_start.elapsed().as_millis();
    let root_desc = workdir_key(repo).unwrap_or_default();
    log::info!(
        "gitstat: libgit2 statuses for {root_desc}: {} entries in {statuses_ms}ms",
        statuses.len()
    );

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

// ----- WSL-delegated status / diff (#398) ----- //
//
// On the Windows build, a repo under `\\wsl.localhost\<distro>\…` is served
// over the 9P network filesystem. libgit2's `status` re-reads and re-hashes
// every tracked file across that boundary on every pass, which makes the SCM
// panel take many seconds. The distro's own git, running inside Linux, has an
// accurate stat cache and never crosses 9P, so we delegate the *read-only*
// status/diff there via `wsl.exe`. Stage/unstage/commit stay on libgit2 (they
// mutate the index and are not the hot path). Any spawn/exit failure falls
// back to the libgit2 implementation, so nothing is lost when wsl.exe is
// missing or the distro is down.
//
// The parser below is a pure function over porcelain=v2 `-z` bytes so it can be
// unit-tested on any platform (this dev machine is Linux); only the `wsl.exe`
// invocation is `#[cfg(windows)]`-gated.

/// Porcelain v2 `--branch -z` output, decomposed into the summary's buckets.
/// Compiled on Windows (where the delegation runs) and under `test` (where the
/// pure parser is exercised on this Linux dev machine); elsewhere it would be
/// dead code.
#[cfg(any(windows, test))]
#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedV2 {
    /// Branch name from `# branch.head`, unless detached.
    branch: Option<String>,
    detached: bool,
    /// Commit oid from `# branch.oid` (absent for an unborn branch).
    oid: Option<String>,
    staged: Vec<GitFileEntry>,
    changes: Vec<GitFileEntry>,
    untracked: Vec<GitFileEntry>,
    merge: Vec<GitFileEntry>,
}

/// Map a porcelain v2 XY status letter to a `GitStatusCode`. `'.'` (unmodified)
/// is handled by the caller and never reaches here.
#[cfg(any(windows, test))]
fn v2_code(letter: u8) -> GitStatusCode {
    match letter {
        b'A' => GitStatusCode::Added,
        b'D' => GitStatusCode::Deleted,
        b'R' => GitStatusCode::Renamed,
        b'C' => GitStatusCode::Copied,
        b'T' => GitStatusCode::TypeChange,
        // 'M' and anything unexpected collapse to Modified — the same
        // conservative default the libgit2 path uses.
        _ => GitStatusCode::Modified,
    }
}

/// Split a porcelain v2 changed-entry record into its `XY` field and path.
/// `meta_tokens` is the number of space-separated tokens that precede the
/// path (8 for ordinary "1" entries, 9 for renamed/copied "2" entries). The
/// path is the remainder, so embedded spaces survive. Metadata is ASCII, so
/// splitting the lossy-decoded string on ' ' is safe even for non-UTF-8 paths.
#[cfg(any(windows, test))]
fn v2_xy_path(field: &[u8], meta_tokens: usize) -> Option<([u8; 2], String)> {
    let s = String::from_utf8_lossy(field);
    let mut it = s.splitn(meta_tokens + 1, ' ');
    let _tag = it.next()?;
    let xy = it.next()?.as_bytes();
    let xy: [u8; 2] = [*xy.first()?, *xy.get(1)?];
    // Consume the remaining metadata tokens (already took tag + XY).
    for _ in 0..meta_tokens.saturating_sub(2) {
        it.next()?;
    }
    let path = it.next()?.to_string();
    if path.is_empty() {
        return None;
    }
    Some((xy, path))
}

/// Route one changed entry into the staged / changes buckets. `x` is the index
/// (staged) side, `y` the worktree side; either being `'.'` means "no change on
/// that side". The rename/copy origin path attaches to whichever side carries
/// the R/C code.
#[cfg(any(windows, test))]
fn push_v2_entry(p: &mut ParsedV2, xy: [u8; 2], path: String, orig: Option<String>) {
    let [x, y] = xy;
    if x != b'.' {
        let old_path = matches!(x, b'R' | b'C').then(|| orig.clone()).flatten();
        p.staged.push(GitFileEntry {
            path: path.clone(),
            old_path,
            status: v2_code(x),
        });
    }
    if y != b'.' {
        let old_path = matches!(y, b'R' | b'C').then(|| orig.clone()).flatten();
        p.changes.push(GitFileEntry {
            path,
            old_path,
            status: v2_code(y),
        });
    }
}

/// Parse `git status --porcelain=v2 --branch -z` output into the summary
/// buckets. Records are NUL-terminated; a rename/copy ("2") record is followed
/// by an extra NUL-separated field holding the original path. Header lines
/// start with `#`. Unrecognized records are skipped defensively.
#[cfg(any(windows, test))]
fn parse_status_v2(stdout: &[u8]) -> ParsedV2 {
    let mut p = ParsedV2::default();
    let mut fields = stdout.split(|b| *b == 0);
    while let Some(field) = fields.next() {
        match field.first() {
            None => continue, // trailing empty field after the last NUL
            Some(b'#') => {
                let line = String::from_utf8_lossy(field);
                if let Some(rest) = line.strip_prefix("# branch.head ") {
                    if rest == "(detached)" {
                        p.detached = true;
                    } else {
                        p.branch = Some(rest.to_string());
                    }
                } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
                    // "(initial)" marks an unborn branch — no commit yet.
                    if rest != "(initial)" {
                        p.oid = Some(rest.to_string());
                    }
                }
            }
            Some(b'1') => {
                if let Some((xy, path)) = v2_xy_path(field, 8) {
                    push_v2_entry(&mut p, xy, path, None);
                }
            }
            Some(b'2') => {
                // The origin path is the next NUL-separated field.
                let orig = fields
                    .next()
                    .map(|f| String::from_utf8_lossy(f).to_string());
                if let Some((xy, path)) = v2_xy_path(field, 9) {
                    push_v2_entry(&mut p, xy, path, orig);
                }
            }
            Some(b'u') => {
                // Unmerged: 10 metadata tokens then path. Bucket as conflicted.
                if let Some((_, path)) = v2_xy_path(field, 10) {
                    p.merge.push(GitFileEntry {
                        path,
                        old_path: None,
                        status: GitStatusCode::Conflicted,
                    });
                }
            }
            Some(b'?') => {
                // "? <path>"
                let path = String::from_utf8_lossy(&field[2..]).to_string();
                if !path.is_empty() {
                    p.untracked.push(GitFileEntry {
                        path,
                        old_path: None,
                        status: GitStatusCode::Untracked,
                    });
                }
            }
            // '!' ignored entries and anything else: skip.
            Some(_) => {}
        }
    }
    p
}

/// Build a `GitStatusSummary` from parsed porcelain output. `op_state` comes
/// from libgit2 (`repo.state()` only reads a few marker files, so it is cheap
/// even over 9P — unlike `repo.statuses()`, which hashes the whole tree).
#[cfg(any(windows, test))]
fn summary_from_v2(parsed: ParsedV2, repo_root: String, op_state: String) -> GitStatusSummary {
    let branch = if parsed.detached {
        // Match the libgit2 path: a detached HEAD shows the short oid.
        parsed.oid.as_deref().map(|o| format!("{:.7}", o))
    } else {
        parsed.branch
    };
    GitStatusSummary {
        is_repo: true,
        repo_root: Some(repo_root),
        branch,
        detached: parsed.detached,
        staged: parsed.staged,
        changes: parsed.changes,
        untracked: parsed.untracked,
        merge: parsed.merge,
        op_state,
    }
}

/// Truncate stderr for logging (matches the quickfind diagnostics pattern in
/// search.rs): a chatty child can produce arbitrarily large output, so cap
/// what we log at ~1KB.
#[cfg(windows)]
fn truncate_stderr(stderr: &[u8]) -> String {
    let mut buf = stderr.to_vec();
    buf.truncate(1024);
    String::from_utf8_lossy(&buf).trim_end().to_string()
}

/// Rebuild a `\\wsl.localhost\<distro>\…` UNC path from a distro name and an
/// absolute Linux path — the inverse of `parse_wsl_unc`. Lets `git_repo_root`
/// hand the frontend a repo root it can pass back to path-keyed git commands
/// (#425).
#[cfg(windows)]
fn wsl_unc_from_linux(distro: &str, linux_path: &str) -> String {
    let rel = linux_path.trim_start_matches('/').replace('/', "\\");
    if rel.is_empty() {
        format!("\\\\wsl.localhost\\{distro}")
    } else {
        format!("\\\\wsl.localhost\\{distro}\\{rel}")
    }
}

/// Strip a trailing separator so a UNC repo root matches `workdir_key`'s form
/// (the frontend keys caches on it, #369).
#[cfg(windows)]
fn normalize_root(path: &str) -> String {
    let mut s = path.to_string();
    while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
        s.pop();
    }
    s
}

/// In-progress op state ("merge"/"rebase"/…) for a WSL repo, read by stat-ing
/// the marker files in its `.git` dir over the UNC mount. A handful of
/// single-file stats is cheap over 9P (unlike a tree-wide status), and it lets
/// `git_status` report op state without a libgit2 open just to read
/// `repo.state()` (#425). Degrades to "clean" for linked worktrees where
/// `.git` is a file, not a dir.
#[cfg(windows)]
fn wsl_op_state(unc_root: &str) -> &'static str {
    let git_dir = Path::new(unc_root).join(".git");
    if git_dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if git_dir.join("REVERT_HEAD").exists() {
        "revert"
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "cherry_pick"
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        "rebase"
    } else {
        "clean"
    }
}

#[cfg(windows)]
enum WslRepoRoot {
    /// Authoritative repo root (canonical UNC form).
    Root(String),
    /// Authoritative "not a git repository".
    NotRepo,
    /// Delegation mechanism failed — caller should fall back to libgit2.
    Fallback,
}

/// Resolve the repo root for a WSL UNC path via the distro's native git,
/// avoiding a libgit2 discovery walk over 9P (#425). Uses `--exec` for literal
/// argv (a login shell would mangle args, #423).
#[cfg(windows)]
fn wsl_repo_root(distro: &str, linux_path: &str) -> WslRepoRoot {
    use crate::process_ext::NoConsole;

    let start = Instant::now();
    let output = std::process::Command::new("wsl.exe")
        .no_console()
        .args([
            "-d",
            distro,
            "--exec",
            "git",
            "-C",
            linux_path,
            "rev-parse",
            "--show-toplevel",
        ])
        .output();
    let elapsed_ms = start.elapsed().as_millis();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            log::warn!("gitstat: wsl_repo_root spawn failed for {distro}:{linux_path}: {e}");
            return WslRepoRoot::Fallback;
        }
    };
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let top = stdout.lines().next().unwrap_or("").trim();
        if top.is_empty() {
            return WslRepoRoot::Fallback;
        }
        let root = wsl_unc_from_linux(distro, top);
        log::info!("gitstat: wsl_repo_root {distro}:{linux_path} -> {root} in {elapsed_ms}ms");
        return WslRepoRoot::Root(root);
    }
    // Native Linux git has no dubious-ownership issue, so a clean "not a git
    // repository" is authoritative — no need to re-check over 9P. Anything
    // else (wsl.exe couldn't launch the distro) is a real failure: fall back.
    let stderr = truncate_stderr(&output.stderr);
    let low = stderr.to_ascii_lowercase();
    if low.contains("not a git repository") || low.contains("not a work tree") {
        log::debug!("gitstat: wsl_repo_root {distro}:{linux_path} not a repo in {elapsed_ms}ms");
        return WslRepoRoot::NotRepo;
    }
    log::warn!(
        "gitstat: wsl_repo_root {distro}:{linux_path} exited {:?} in {elapsed_ms}ms, stderr: {stderr}",
        output.status.code()
    );
    WslRepoRoot::Fallback
}

/// Delegate `git status` to the distro's native git for a repo under a WSL UNC
/// path (`root`, its canonical UNC form). Returns `None` (caller falls back to
/// libgit2) when `wsl.exe`/git fails to run or exits non-zero.
#[cfg(windows)]
fn wsl_status(distro: &str, linux_path: &str, root: &str) -> Option<GitStatusSummary> {
    use crate::process_ext::NoConsole;

    let start = Instant::now();
    // `-uall` mirrors libgit2's `recurse_untracked_dirs(true)`: individual
    // untracked files rather than a collapsed directory entry. No filemode
    // override — native Linux git already reports modes correctly (#398, #392).
    // `--exec` passes literal argv (a login shell would mangle a path with
    // spaces / metacharacters, #423).
    let output = std::process::Command::new("wsl.exe")
        .no_console()
        .args([
            "-d",
            distro,
            "--exec",
            "git",
            "-C",
            linux_path,
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "-uall",
        ])
        .output();
    let elapsed_ms = start.elapsed().as_millis();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            log::warn!("gitstat: wsl_status spawn failed for {distro}:{linux_path}: {e}");
            log::warn!("gitstat: falling back to libgit2 over 9P for {root}");
            return None;
        }
    };
    if !output.status.success() {
        log::warn!(
            "gitstat: wsl_status delegation to {distro} for {linux_path} exited {:?} in {elapsed_ms}ms, stderr: {}",
            output.status.code(),
            truncate_stderr(&output.stderr)
        );
        log::warn!("gitstat: falling back to libgit2 over 9P for {root}");
        return None;
    }

    log::info!("gitstat: wsl_status delegated to {distro} for {linux_path}: ok in {elapsed_ms}ms");
    let parsed = parse_status_v2(&output.stdout);
    Some(summary_from_v2(
        parsed,
        root.to_string(),
        wsl_op_state(root).to_string(),
    ))
}

/// Delegate `git diff [--cached] -- <path>` to the distro's native git when
/// `repo` lives under a WSL UNC path. Returns the unified-diff text (which the
/// frontend parses exactly as it parses libgit2's rendered patch). Returns
/// `None` for a non-WSL repo or any spawn/exit failure so the caller falls back
/// to libgit2.
#[cfg(windows)]
fn wsl_diff(distro: &str, linux_path: &str, path: &str, staged: bool) -> Option<String> {
    use crate::process_ext::NoConsole;

    // `--no-color` guards against a user's `color.ui = always`: libgit2's
    // rendered patch carries no ANSI codes, and the frontend's unified-diff
    // parser would choke on them. `--exec` passes literal argv (#423).
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.no_console().args([
        "-d",
        distro,
        "--exec",
        "git",
        "-C",
        linux_path,
        "diff",
        "--no-color",
    ]);
    if staged {
        cmd.arg("--cached");
    }
    cmd.arg("--").arg(path);

    let start = Instant::now();
    let output = cmd.output();
    let elapsed_ms = start.elapsed().as_millis();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            log::warn!("gitstat: wsl_diff spawn failed for {distro}:{linux_path}: {e}");
            log::warn!("gitstat: falling back to libgit2 over 9P for {distro}:{linux_path}");
            return None;
        }
    };
    if !output.status.success() {
        log::warn!(
            "gitstat: wsl_diff delegation to {distro} for {linux_path} exited {:?} in {elapsed_ms}ms, stderr: {}",
            output.status.code(),
            truncate_stderr(&output.stderr)
        );
        log::warn!("gitstat: falling back to libgit2 over 9P for {distro}:{linux_path}");
        return None;
    }

    log::info!("gitstat: wsl_diff delegated to {distro} for {linux_path}: ok in {elapsed_ms}ms");
    Some(String::from_utf8_lossy(&output.stdout).to_string())
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
fn add_to_gitignore(root: &Path, entry: &str) -> Result<String, AppError> {
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
}

#[tauri::command]
pub async fn git_add_to_gitignore(repo_root: String, entry: String) -> Result<String, AppError> {
    run_blocking(move |_cancel| add_to_gitignore(Path::new(&repo_root), &entry)).await
}

/// Validate that every requested path is a repo-relative, currently-untracked
/// working-tree entry. SCM archive/trash actions only ever act on this set.
fn untracked_worktree_paths(
    repo: &Repository,
    paths: &[String],
) -> Result<(PathBuf, Vec<PathBuf>), AppError> {
    if paths.is_empty() {
        return Err(AppError::Other("no untracked paths were selected".into()));
    }
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Other("git: bare repository has no working tree".into()))?
        .to_path_buf();
    let mut relative_paths = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = Path::new(path);
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(AppError::InvalidPath(format!(
                "expected a repo-relative path: {path}"
            )));
        }
        let status = repo.status_file(relative).map_err(to_app_err)?;
        if !status.contains(Status::WT_NEW) {
            return Err(AppError::Other(format!(
                "refusing to operate on non-untracked path: {path}"
            )));
        }
        relative_paths.push(relative.to_path_buf());
    }
    Ok((workdir, relative_paths))
}

/// Move selected untracked files into `.archive`, preserving their paths below
/// the repository root so same-named files from different folders do not clash.
#[tauri::command]
pub async fn git_archive_untracked(repo_path: String, paths: Vec<String>) -> Result<(), AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let (workdir, relative_paths) = untracked_worktree_paths(&repo, &paths)?;
        let archive_root = workdir.join(".archive");
        for relative in &relative_paths {
            let destination = archive_root.join(relative);
            if destination.exists() {
                return Err(AppError::AlreadyExists(destination.display().to_string()));
            }
        }
        add_to_gitignore(&workdir, ".archive")?;
        for relative in relative_paths {
            let source = workdir.join(&relative);
            let destination = archive_root.join(&relative);
            let parent = destination
                .parent()
                .expect("archive destination has a parent");
            std::fs::create_dir_all(parent)?;
            std::fs::rename(source, destination)?;
        }
        Ok(())
    })
    .await
}

/// Move selected untracked files to the operating system trash/recycle bin.
#[tauri::command]
pub async fn git_trash_untracked(repo_path: String, paths: Vec<String>) -> Result<(), AppError> {
    run_blocking(move |_cancel| {
        let repo = open_repo(Path::new(&repo_path))?;
        let (workdir, relative_paths) = untracked_worktree_paths(&repo, &paths)?;
        for relative in relative_paths {
            crate::system::trash_or_remove(&workdir.join(relative))?;
        }
        Ok(())
    })
    .await
}

/// Resolve the repo root that contains `path`, or `None` if outside any repo.
#[tauri::command]
pub async fn git_repo_root(path: String) -> Result<Option<String>, AppError> {
    run_blocking(move |_cancel| {
        // WSL UNC: resolve the root with the distro's native git rather than a
        // libgit2 discovery walk over the 9P mount (#425). Only a delegation
        // *mechanism* failure falls through to libgit2.
        #[cfg(windows)]
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(&path) {
            match wsl_repo_root(&distro, &linux_path) {
                WslRepoRoot::Root(root) => return Ok(Some(root)),
                WslRepoRoot::NotRepo => return Ok(None),
                WslRepoRoot::Fallback => {}
            }
        }
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
        let start = Instant::now();
        // A repo under \\wsl.localhost\… hashes its whole tree over 9P on every
        // libgit2 status pass (157s on a big repo), and `open_repo` is itself a
        // 9P discovery walk. Delegate to native WSL git WITHOUT opening the repo
        // first; fall back to libgit2 only if the delegation fails (#398, #425).
        #[cfg(windows)]
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(&repo_path) {
            let root = normalize_root(&repo_path);
            if let Some(summary) = wsl_status(&distro, &linux_path, &root) {
                log::info!(
                    "gitstat: git_status for {repo_path} served by wsl-delegated in {}ms",
                    start.elapsed().as_millis()
                );
                return Ok(summary);
            }
        }
        let p = PathBuf::from(&repo_path);
        let result = match open_repo(&p) {
            Ok(repo) => collect_status(&repo),
            Err(_) => map_non_repo(&p),
        };
        log::info!(
            "gitstat: git_status for {repo_path} served by libgit2 in {}ms",
            start.elapsed().as_millis()
        );
        result
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
        // Over a \\wsl.localhost\… UNC path, delegate the diff to native WSL
        // git WITHOUT a libgit2 open first (same reason as status, #398/#425).
        // Native Linux git needs no filemode override; on any failure we fall
        // through to libgit2 below.
        #[cfg(windows)]
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(&repo_path) {
            if let Some(diff) = wsl_diff(&distro, &linux_path, &path, opts.staged) {
                return Ok(diff);
            }
        }

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

        // Nothing-staged guard (#466): committing an index identical to HEAD's
        // tree (or an empty tree on an unborn branch) would fabricate a
        // spurious empty commit. git itself refuses this without --allow-empty,
        // and the mock backend already throws "nothing to commit"; a real
        // commit must reject it too rather than silently advancing HEAD. Amend
        // is exempt — amending with nothing newly staged (message-only, or
        // --no-edit) is a legitimate operation.
        if !opts.amend {
            let nothing_staged = match parent_commit.as_ref() {
                Some(parent) => tree_oid == parent.tree_id(),
                None => tree.is_empty(),
            };
            if nothing_staged {
                return Err(AppError::Other(
                    "nothing to commit — stage some changes first".into(),
                ));
            }
        }

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
                        log::debug!("gitstat: emitting trailing git-status-changed for {key}");
                        let _ = app.emit("git-status-changed", &key);
                    });
                }
                return;
            }
            *last = Instant::now();
            drop(last);
            log::debug!("gitstat: emitting git-status-changed for {key_for_event}");
            let _ = app_for_watcher.emit("git-status-changed", &key_for_event);
        }
    };
    // WSL/network shares (\\wsl$\…, \\wsl.localhost\…) don't deliver native
    // change notifications to Windows — ReadDirectoryChangesW is effectively
    // a no-op over 9P — so a natively-watched repo there never fires and the
    // SCM panel looks frozen until reopened (#387). Poll those instead.
    let is_unc = key.starts_with("\\\\") || key.starts_with("//");
    let mut watcher: Box<dyn Watcher + Send> = if is_unc {
        // Each PollWatcher tick re-stats the entire watched tree; over the 9P
        // mount that is the same expensive walk the badge/status paths now
        // delegate away from, so a tight 3s interval reintroduces exactly the
        // 9P load we're trying to shed (#426). A UNC repo only changes from
        // inside WSL (the user isn't editing over the mount at high frequency),
        // so a 15s interval keeps the panel reasonably live at ~1/5th the cost.
        let poll_interval = Duration::from_secs(15);
        log::info!(
            "gitstat: UNC root {key}: native fs events unavailable, using {}s PollWatcher",
            poll_interval.as_secs()
        );
        Box::new(
            notify::PollWatcher::new(
                handler,
                notify::Config::default().with_poll_interval(poll_interval),
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
        repo.config()
            .unwrap()
            .set_bool("core.filemode", true)
            .unwrap();

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
        repo.config()
            .unwrap()
            .set_bool("core.autocrlf", true)
            .unwrap();
        // Rewrite the working tree with CRLF, as a Windows checkout would.
        fs::write(dir.path().join("script.ahk"), "MsgBox\r\nReturn\r\n").unwrap();

        // Precondition: the diff for this file really is empty (this is what
        // makes the panel row a dead end).
        let mut o = DiffOptions::new();
        o.pathspec("script.ahk");
        let patch = render_diff(repo.diff_index_to_workdir(None, Some(&mut o)).unwrap()).unwrap();
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
        assert_eq!(
            watch_key_for(&from_subdir),
            key,
            "subdir resolves to the same repo key"
        );
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
        assert!(
            !root.ends_with('/') && !root.ends_with('\\'),
            "root: {root}"
        );
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
    fn archive_untracked_moves_files_below_archive_and_removes_them_from_status() {
        let dir = init_repo();
        write(dir.path(), ".gitignore", "");
        commit_all(dir.path(), "ignore file");
        write(dir.path(), "src/generated.ts", "export {};\n");
        let path = dir.path().to_str().unwrap().to_string();

        tokio_test_block(git_archive_untracked(path, vec!["src/generated.ts".into()])).unwrap();

        assert!(!dir.path().join("src/generated.ts").exists());
        assert!(dir.path().join(".archive/src/generated.ts").exists());
        assert!(std::fs::read_to_string(dir.path().join(".gitignore"))
            .unwrap()
            .lines()
            .any(|line| line == ".archive"));
        assert!(sync_status(dir.path()).untracked.is_empty());
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

    /// End-to-end of the flow the git-graph inline commit panel drives (#466):
    /// stage a working-tree change through the async command, commit it with a
    /// message, and assert HEAD advanced with that message while the index
    /// emptied — then that unstaging a re-modified file returns it to `changes`.
    #[test]
    fn stage_commit_advances_head_and_empties_index() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "v2\n");
        let path = dir.path().to_str().unwrap().to_string();

        // Stage, then commit with a message.
        tokio_test_block(git_stage(path.clone(), vec!["a.txt".into()])).unwrap();
        let pre = sync_status(dir.path());
        assert_eq!(pre.staged.len(), 1, "file should be staged before commit");

        let res =
            tokio_test_block(git_commit(path.clone(), "feat: land a.txt".into(), None)).unwrap();
        assert!(!res.commit_id.is_empty());

        // HEAD advanced to a commit carrying the message.
        let head_msg = Command::new("git")
            .current_dir(dir.path())
            .args(["log", "-1", "--format=%s"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&head_msg.stdout).trim(),
            "feat: land a.txt"
        );

        // The index is empty afterwards (nothing left staged).
        let post = sync_status(dir.path());
        assert!(post.staged.is_empty(), "index should be empty after commit");
        assert!(post.changes.is_empty() && post.untracked.is_empty());
    }

    #[test]
    fn unstage_returns_file_to_changes() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "v2\n");
        let path = dir.path().to_str().unwrap().to_string();

        tokio_test_block(git_stage(path.clone(), vec!["a.txt".into()])).unwrap();
        assert_eq!(sync_status(dir.path()).staged.len(), 1);

        tokio_test_block(git_unstage(path.clone(), vec!["a.txt".into()])).unwrap();
        let s = sync_status(dir.path());
        assert!(s.staged.is_empty(), "unstaged file must leave the index");
        assert_eq!(s.changes.len(), 1, "and reappear as a working-tree change");
        assert_eq!(s.changes[0].path, "a.txt");
    }

    #[test]
    fn commit_with_empty_message_is_rejected() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        write(dir.path(), "a.txt", "v2\n");
        let path = dir.path().to_str().unwrap().to_string();
        tokio_test_block(git_stage(path.clone(), vec!["a.txt".into()])).unwrap();

        let err = tokio_test_block(git_commit(path, "   ".into(), None));
        assert!(
            matches!(err, Err(AppError::Other(m)) if m.contains("empty")),
            "whitespace-only message must be rejected",
        );
    }

    #[test]
    fn commit_with_nothing_staged_is_rejected_and_head_unchanged() {
        let dir = init_repo();
        write(dir.path(), "a.txt", "v1\n");
        commit_all(dir.path(), "init");
        // Working tree is clean: nothing is staged relative to HEAD.
        let head_before = Command::new("git")
            .current_dir(dir.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let path = dir.path().to_str().unwrap().to_string();

        let err = tokio_test_block(git_commit(path, "spurious empty commit".into(), None));
        assert!(
            matches!(err, Err(AppError::Other(ref m)) if m.contains("nothing to commit")),
            "an empty index must be rejected, got {err:?}",
        );

        // HEAD must not have advanced (no empty commit was created).
        let head_after = Command::new("git")
            .current_dir(dir.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(
            head_before.stdout, head_after.stdout,
            "HEAD must be unchanged"
        );
    }

    #[test]
    fn commit_on_unborn_branch_with_empty_index_is_rejected() {
        // Fresh repo, no commits, nothing staged: the initial commit would be
        // an empty tree — also rejected.
        let dir = init_repo();
        let path = dir.path().to_str().unwrap().to_string();
        let err = tokio_test_block(git_commit(path, "empty initial".into(), None));
        assert!(
            matches!(err, Err(AppError::Other(ref m)) if m.contains("nothing to commit")),
            "empty initial commit must be rejected, got {err:?}",
        );
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

    /// Manual diagnostic for #424: run WSL status delegation directly against
    /// a live WSL UNC directory and compare with the libgit2 fallback timing.
    /// `cargo test wsl_diag_scm_status -- --ignored --nocapture` with
    /// `WSL_GIT_DIAG_PATH` set to e.g. `\\wsl.localhost\Ubuntu\home\me\repo`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn wsl_diag_scm_status() {
        crate::init_test_logger();
        let Ok(path) = std::env::var("WSL_GIT_DIAG_PATH") else {
            println!("WSL_GIT_DIAG_PATH not set; skipping. Example:");
            println!(
                r"  WSL_GIT_DIAG_PATH=\\wsl.localhost\Ubuntu\home\me\repo cargo test wsl_diag_scm_status -- --ignored --nocapture"
            );
            return;
        };
        // Repo-root detection via native git (no libgit2 discovery walk).
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(&path) {
            let start = Instant::now();
            let root = wsl_repo_root(&distro, &linux_path);
            let elapsed = start.elapsed();
            match root {
                WslRepoRoot::Root(r) => {
                    println!("wsl_diag_scm_status: wsl_repo_root -> {r} in {elapsed:?}")
                }
                WslRepoRoot::NotRepo => {
                    println!("wsl_diag_scm_status: wsl_repo_root -> not a repo in {elapsed:?}")
                }
                WslRepoRoot::Fallback => {
                    println!("wsl_diag_scm_status: wsl_repo_root -> fallback in {elapsed:?}")
                }
            }
        }

        // Status delegation by path — no libgit2 open first (#425).
        let (distro, linux_path) = crate::wsl::parse_wsl_unc(&path)
            .expect("WSL_GIT_DIAG_PATH must be a \\\\wsl.localhost\\… path");
        let root = normalize_root(&path);
        let start = Instant::now();
        let delegated = wsl_status(&distro, &linux_path, &root);
        let elapsed = start.elapsed();
        match &delegated {
            Some(summary) => println!(
                "wsl_diag_scm_status: WSL delegation OK in {elapsed:?}: staged={} changes={} untracked={}",
                summary.staged.len(),
                summary.changes.len(),
                summary.untracked.len()
            ),
            None => println!("wsl_diag_scm_status: WSL delegation declined/failed in {elapsed:?}"),
        }

        // For comparison, time the libgit2 open + fallback too.
        let repo = match open_repo(Path::new(&path)) {
            Ok(r) => r,
            Err(e) => {
                println!("wsl_diag_scm_status: libgit2 open failed for {path}: {e:?}");
                return;
            }
        };
        let start = Instant::now();
        let via_libgit2 = collect_status(&repo);
        let elapsed = start.elapsed();
        match via_libgit2 {
            Ok(summary) => println!(
                "wsl_diag_scm_status: libgit2 fallback OK in {elapsed:?}: staged={} changes={} untracked={}",
                summary.staged.len(),
                summary.changes.len(),
                summary.untracked.len()
            ),
            Err(e) => println!("wsl_diag_scm_status: libgit2 fallback ERROR in {elapsed:?}: {e:?}"),
        }
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

    /// Porcelain v2 `-z` parsing that backs the WSL-delegated status (#398).
    /// The `wsl.exe` invocation itself is Windows-only, but the parser is a
    /// pure function, so it is exercised here on Linux against both hand-built
    /// byte fixtures (exact `-z` framing) and the real `git` binary.
    mod v2 {
        use super::*;
        use std::process::Command;

        fn paths(entries: &[GitFileEntry]) -> Vec<&str> {
            entries.iter().map(|e| e.path.as_str()).collect()
        }

        /// Real `git status --porcelain=v2 --branch -z -uall` output for `dir`.
        fn v2_bytes(dir: &Path) -> Vec<u8> {
            Command::new("git")
                .current_dir(dir)
                .args(["status", "--porcelain=v2", "--branch", "-z", "-uall"])
                .output()
                .unwrap()
                .stdout
        }

        #[test]
        fn ordinary_staged_and_worktree_split_by_xy() {
            // "1 M. …" is staged-only; "1 .M …" is worktree-only.
            let raw = b"1 M. N... 100644 100644 100644 aaa bbb staged.txt\0\
                        1 .M N... 100644 100644 100644 ccc ddd work.txt\0";
            let p = parse_status_v2(raw);
            assert_eq!(paths(&p.staged), ["staged.txt"]);
            assert_eq!(p.staged[0].status, GitStatusCode::Modified);
            assert_eq!(paths(&p.changes), ["work.txt"]);
            assert_eq!(p.changes[0].status, GitStatusCode::Modified);
            assert!(p.untracked.is_empty() && p.merge.is_empty());
        }

        #[test]
        fn renamed_entry_carries_old_path_from_second_field() {
            // "2 R. … R100 <new>\0<old>\0" — the origin path is a separate field.
            let raw = b"2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\0old.txt\0\
                        ? untracked.txt\0";
            let p = parse_status_v2(raw);
            assert_eq!(paths(&p.staged), ["renamed.txt"]);
            assert_eq!(p.staged[0].status, GitStatusCode::Renamed);
            assert_eq!(p.staged[0].old_path.as_deref(), Some("old.txt"));
            // The extra field must be consumed, not parsed as its own entry.
            assert_eq!(paths(&p.untracked), ["untracked.txt"]);
        }

        #[test]
        fn unmerged_entry_is_conflicted() {
            let raw = b"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0";
            let p = parse_status_v2(raw);
            assert_eq!(paths(&p.merge), ["conflict.txt"]);
            assert_eq!(p.merge[0].status, GitStatusCode::Conflicted);
            assert!(p.staged.is_empty() && p.changes.is_empty());
        }

        #[test]
        fn untracked_and_ignored() {
            let raw = b"? new.txt\0! build/ignored.o\0";
            let p = parse_status_v2(raw);
            // Untracked kept; ignored ("!") dropped.
            assert_eq!(paths(&p.untracked), ["new.txt"]);
            assert_eq!(p.untracked[0].status, GitStatusCode::Untracked);
            assert!(p.staged.is_empty() && p.changes.is_empty() && p.merge.is_empty());
        }

        #[test]
        fn paths_with_spaces_survive() {
            let raw = b"1 .M N... 100644 100644 100644 aaa bbb my file.txt\0";
            let p = parse_status_v2(raw);
            assert_eq!(paths(&p.changes), ["my file.txt"]);
        }

        #[test]
        fn branch_header_names_the_branch() {
            let raw = b"# branch.oid abcdef1234567890\0# branch.head main\0";
            let p = parse_status_v2(raw);
            assert_eq!(p.branch.as_deref(), Some("main"));
            assert!(!p.detached);
        }

        #[test]
        fn detached_head_reports_short_oid() {
            let raw = b"# branch.oid abcdef1234567890\0# branch.head (detached)\0";
            let p = parse_status_v2(raw);
            assert!(p.detached);
            let s = summary_from_v2(p, "/repo".into(), "clean".into());
            assert!(s.detached);
            assert_eq!(s.branch.as_deref(), Some("abcdef1")); // 7 chars
        }

        #[test]
        fn unborn_branch_has_no_oid() {
            let raw = b"# branch.oid (initial)\0# branch.head main\0";
            let p = parse_status_v2(raw);
            assert_eq!(p.oid, None);
            assert_eq!(p.branch.as_deref(), Some("main"));
        }

        #[test]
        fn empty_output_is_a_clean_tree() {
            assert_eq!(parse_status_v2(b""), ParsedV2::default());
        }

        // ---- Integration against the real git binary (mirrors how this repo
        // tests WSL behavior via a tempdir repo, docs/lessons_learnt.md). ----

        #[test]
        fn real_git_staged_worktree_untracked_and_rename() {
            let dir = init_repo();
            write(dir.path(), "a.txt", "one\ntwo\n");
            write(dir.path(), "b.txt", "keep\n");
            write(dir.path(), "c.txt", "orig\n");
            commit_all(dir.path(), "init");

            // Staged rename a.txt -> renamed.txt
            Command::new("git")
                .current_dir(dir.path())
                .args(["mv", "a.txt", "renamed.txt"])
                .status()
                .unwrap();
            // Staged content edit on c.txt
            write(dir.path(), "c.txt", "changed\n");
            Command::new("git")
                .current_dir(dir.path())
                .args(["add", "c.txt"])
                .status()
                .unwrap();
            // Unstaged worktree edit on b.txt
            write(dir.path(), "b.txt", "keep\nmore\n");
            // Untracked file
            write(dir.path(), "u.txt", "x\n");

            let p = parse_status_v2(&v2_bytes(dir.path()));

            // Staged: the rename and the content edit.
            let rename = p
                .staged
                .iter()
                .find(|e| e.path == "renamed.txt")
                .expect("staged rename present");
            assert_eq!(rename.status, GitStatusCode::Renamed);
            assert_eq!(rename.old_path.as_deref(), Some("a.txt"));
            assert!(p
                .staged
                .iter()
                .any(|e| e.path == "c.txt" && e.status == GitStatusCode::Modified));

            // Worktree: only the unstaged b.txt edit.
            assert_eq!(paths(&p.changes), ["b.txt"]);
            assert_eq!(p.changes[0].status, GitStatusCode::Modified);

            // Untracked.
            assert_eq!(paths(&p.untracked), ["u.txt"]);
            assert!(p.merge.is_empty());
        }

        #[test]
        fn real_git_matches_libgit2_bucketing() {
            // The delegated parse and the libgit2 path must agree on which
            // files land in which bucket for the same tree.
            let dir = init_repo();
            write(dir.path(), "t1.txt", "v1\n");
            write(dir.path(), "t2.txt", "v1\n");
            commit_all(dir.path(), "init");
            write(dir.path(), "t1.txt", "v2\n");
            {
                let repo = open_repo(dir.path()).unwrap();
                stage_paths_inner(&repo, &["t1.txt".into()]).unwrap();
            }
            write(dir.path(), "t2.txt", "v2\n");
            write(dir.path(), "u1.txt", "x\n");

            let parsed = parse_status_v2(&v2_bytes(dir.path()));
            let libgit2 = collect_status_inner(&open_repo(dir.path()).unwrap(), false).unwrap();

            let sorted = |v: &[GitFileEntry]| {
                let mut s: Vec<String> = v.iter().map(|e| e.path.clone()).collect();
                s.sort();
                s
            };
            assert_eq!(sorted(&parsed.staged), sorted(&libgit2.staged));
            assert_eq!(sorted(&parsed.changes), sorted(&libgit2.changes));
            assert_eq!(sorted(&parsed.untracked), sorted(&libgit2.untracked));
        }

        #[test]
        fn real_git_unmerged_conflict_buckets_as_merge() {
            let dir = conflicted_repo();
            let p = parse_status_v2(&v2_bytes(dir.path()));
            assert!(
                p.merge
                    .iter()
                    .any(|e| e.status == GitStatusCode::Conflicted),
                "expected a conflicted entry, got {:?}",
                p.merge
            );
        }

        #[test]
        fn non_wsl_path_declines_delegation() {
            // The fallback gate: only \\wsl$\ / \\wsl.localhost\ roots delegate;
            // every ordinary path yields None so git_status/git_diff stay on
            // libgit2. (The wsl.exe call itself is Windows-only.)
            assert_eq!(crate::wsl::parse_wsl_unc("/home/me/proj"), None);
            assert_eq!(crate::wsl::parse_wsl_unc(r"C:\Users\me\proj"), None);
            assert!(crate::wsl::parse_wsl_unc(r"\\wsl.localhost\Ubuntu\home\me").is_some());
        }
    }
}
