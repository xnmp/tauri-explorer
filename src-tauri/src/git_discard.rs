//! Working-tree discard for the SCM panel (`git_discard`).
//!
//! A tracked path is restored from HEAD; a path the index does not know is
//! removed from disk (the UI's "Remove" for untracked files). Every path is
//! validated and planned before anything is written, and the operation
//! refuses — naming the path — whenever it would destroy content the user was
//! not shown:
//!
//! - a staged change (unless `force`) or an unresolved conflict;
//! - a non-empty directory now standing where a tracked file was (#1606);
//! - a file or symlink standing where a tracked path's parent directory was:
//!   restoring would delete that file, or write through the link (git itself
//!   refuses paths "beyond a symbolic link");
//! - a tracked file inside a directory requested for removal;
//! - another repository: a `.git` directory or file (nested repository,
//!   linked worktree) at any depth of, or above, a path requested for
//!   removal (#1615);
//! - an ignored file inside a directory requested for removal: ignored files
//!   are never listed as untracked, so the user was not shown them (#1615).
//!
//! Index lookups are exact-case whatever `core.ignorecase` says, as git's
//! literal paths are. Paths are literal, never pathspecs (#1589), and must be
//! normalised repo-relative paths.
//!
//! Effects run removals first, then restores (#1618). Each effect re-checks
//! its path immediately before acting. On Unix every removal (an untracked
//! entry, or a symlink / empty directory in a tracked file's way) is made
//! through directory handles opened without following links from the
//! repository root (`files::contained_removal`), and re-admits every entry —
//! kind, `.git`, ignored — from the observation it acts on. What remains
//! path-based: libgit2's checkout of the restored files, after a path-based
//! re-check of their ancestors and of the path itself; and on Windows the
//! removals too, after the same re-check.
//!
//! libgit2 applies the built-in conversions (eol, `ident`) but not external
//! filter drivers, so a restored file that `git checkout` would smudge (Git
//! LFS, #1616) is written by the git CLI instead, with literal pathspecs,
//! after the same re-checks. Everything else runs under our `index.lock`
//! (#1617); the CLI, which takes that lock itself, runs after our index is
//! committed and the lock released, still within this process's turn.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use git2::{Index, Repository};

use crate::error::AppError;
use crate::git_common::{literal_repo_path, to_app_err, LiteralRepoPath};
use crate::git_index_lock::{with_locked_index_mapped, IndexCase, IndexUpdate};
use crate::git_index_reset::{head_tree, index_differs_from_tree};

const GITLINK_MODE: u32 = 0o160000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    File,
    Symlink,
    Directory,
}

fn kind_of(meta: &Metadata) -> Kind {
    if meta.file_type().is_symlink() {
        Kind::Symlink
    } else if meta.is_dir() {
        Kind::Directory
    } else {
        Kind::File
    }
}

/// What must leave a tracked path before checkout can write the file there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Obstacle {
    None,
    /// Unlinked, never followed (#1604).
    Symlink,
    /// Removed only when empty (#1606).
    EmptyDir,
}

/// What discarding one requested path will do, decided before any mutation.
enum Plan<'a> {
    /// Restore from HEAD after clearing `obstacle`.
    Restore {
        path: &'a str,
        obstacle: Obstacle,
        gitlink: bool,
    },
    /// Remove the untracked entry, which was a `kind` when planned.
    Remove { path: &'a str, kind: Kind },
}

fn lstat(path: &Path) -> Result<Option<Metadata>, AppError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// A repo-relative path as the user sees it: `/`-separated on every platform.
fn shown(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether the index tracks anything below `dir/`.
fn tracks_anything_under(index: &Index, dir: &str) -> Result<bool, AppError> {
    match index.find_prefix(format!("{dir}/")) {
        Ok(_) => Ok(true),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(false),
        Err(e) => Err(to_app_err(e)),
    }
}

fn symlink_ancestor(rel: &str, ancestor: &str) -> AppError {
    AppError::Other(format!(
        "cannot discard '{rel}': '{ancestor}' is a symbolic link, and discarding \
         through it could change files outside the repository"
    ))
}

fn file_ancestor(rel: &str, ancestor: &str) -> AppError {
    AppError::Other(format!(
        "cannot discard '{rel}': the file '{ancestor}' is in the way and would be \
         deleted; move or delete it first"
    ))
}

fn changed_while_discarding(rel: &str) -> String {
    format!("cannot discard '{rel}': it changed while discarding; refresh and try again")
}

/// Every proper ancestor of `rel` inside the work tree must be a real
/// directory or absent: a symlink would redirect the write or delete outside
/// it, and a file would itself be deleted to make room.
fn check_ancestors(workdir: &Path, rel: &str) -> Result<(), AppError> {
    let mut ancestor = workdir.to_path_buf();
    let segments: Vec<&str> = rel.split('/').collect();
    for (i, segment) in segments[..segments.len() - 1].iter().enumerate() {
        ancestor.push(segment);
        let shown = segments[..=i].join("/");
        match lstat(&ancestor)? {
            None => return Ok(()),
            Some(meta) if meta.file_type().is_symlink() => {
                return Err(symlink_ancestor(rel, &shown))
            }
            Some(meta) if !meta.is_dir() => return Err(file_ancestor(rel, &shown)),
            Some(_) => {}
        }
    }
    Ok(())
}

fn foreign_repository(target: &str, git_dir: &str) -> String {
    format!(
        "cannot remove '{target}': '{git_dir}' belongs to another Git repository (a \
         nested repository or a linked worktree), and removing it would delete that \
         repository and any uncommitted work in it; delete it outside the app if \
         that is intended"
    )
}

/// An untracked path inside another repository's work tree belongs to that
/// repository; removing it is never this repository's "Remove".
fn check_not_inside_another_repository(workdir: &Path, rel: &str) -> Result<(), AppError> {
    let mut ancestor = workdir.to_path_buf();
    let segments: Vec<&str> = rel.split('/').collect();
    for i in 0..segments.len() - 1 {
        ancestor.push(segments[i]);
        if lstat(&ancestor.join(".git"))?.is_some() {
            let git_dir = format!("{}/.git", segments[..=i].join("/"));
            return Err(AppError::Other(foreign_repository(rel, &git_dir)));
        }
    }
    Ok(())
}

/// Why the entry at `rel` (a `depth`-deep part of the removal of `target`,
/// which is depth 1) must not be removed, if it must not.
fn untracked_entry_refusal(
    repo: &Repository,
    target: &str,
    rel: &Path,
    depth: usize,
) -> Result<Option<String>, AppError> {
    let name = rel.file_name().unwrap_or_default();
    if name.eq_ignore_ascii_case(OsStr::new(".git")) {
        return Ok(Some(foreign_repository(target, &shown(rel))));
    }
    // The target itself was named by the user; what is below it was listed
    // as untracked only if git does not ignore it.
    if depth > 1 && repo.status_should_ignore(rel).map_err(to_app_err)? {
        return Ok(Some(format!(
            "cannot remove '{target}': it contains '{}', which is ignored and so was \
             not listed as untracked; move or delete ignored files first",
            shown(rel)
        )));
    }
    Ok(None)
}

/// Refuse the removal of the untracked directory `target` if anything in it
/// must not be removed. Does not follow links.
fn scan_untracked_directory(
    repo: &Repository,
    workdir: &Path,
    target: &str,
) -> Result<(), AppError> {
    let mut stack: Vec<(PathBuf, usize)> = vec![(PathBuf::from(target), 1)];
    while let Some((dir, depth)) = stack.pop() {
        for entry in fs::read_dir(workdir.join(&dir))? {
            let entry = entry?;
            let rel = dir.join(entry.file_name());
            if let Some(refusal) = untracked_entry_refusal(repo, target, &rel, depth + 1)? {
                return Err(AppError::Other(refusal));
            }
            if entry.file_type()?.is_dir() {
                stack.push((rel, depth + 1));
            }
        }
    }
    Ok(())
}

fn plan_one<'a>(
    repo: &Repository,
    index: &Index,
    workdir: &Path,
    LiteralRepoPath {
        path: rel,
        dir_only,
    }: LiteralRepoPath<'a>,
) -> Result<Option<Plan<'a>>, AppError> {
    check_ancestors(workdir, rel)?;
    let abs = workdir.join(rel);
    let on_disk = lstat(&abs)?;
    if dir_only && on_disk.as_ref().is_some_and(|m| !m.is_dir()) {
        return Err(AppError::Other(format!(
            "cannot discard '{rel}/': it is no longer a directory"
        )));
    }
    let Some(entry) = index.get_path(Path::new(rel), 0) else {
        if tracks_anything_under(index, rel)? {
            return Err(AppError::Other(format!(
                "cannot remove '{rel}': it contains tracked files; discard them individually"
            )));
        }
        check_not_inside_another_repository(workdir, rel)?;
        let Some(meta) = on_disk else {
            return Ok(None);
        };
        let kind = kind_of(&meta);
        if kind == Kind::Directory {
            scan_untracked_directory(repo, workdir, rel)?;
        }
        return Ok(Some(Plan::Remove { path: rel, kind }));
    };
    let gitlink = entry.mode == GITLINK_MODE;
    let obstacle = match on_disk {
        Some(meta) if meta.file_type().is_symlink() => Obstacle::Symlink,
        // A submodule's checkout is a directory by design; checkout leaves it.
        Some(meta) if meta.is_dir() && !gitlink => {
            if fs::read_dir(&abs)?.next().is_some() {
                return Err(AppError::Other(format!(
                    "cannot discard '{rel}': a directory with contents now exists at that \
                     path, and restoring the file would delete them; move or delete the \
                     directory first"
                )));
            }
            Obstacle::EmptyDir
        }
        _ => Obstacle::None,
    };
    Ok(Some(Plan::Restore {
        path: rel,
        obstacle,
        gitlink,
    }))
}

/// Remove the entry at `rel`, which must still be a `kind`, admitting every
/// entry with `admit(relative_to_parent, depth, kind)` first.
#[cfg(unix)]
fn remove_entry(
    workdir: &Path,
    rel: &str,
    kind: Kind,
    mut admit: impl FnMut(&Path, usize) -> Result<(), String>,
) -> Result<(), AppError> {
    use crate::files::contained_removal::{remove_contained, ContainedRemovalError};

    let result = remove_contained(workdir, Path::new(rel), |entry| {
        if entry.depth == 1 {
            let observed = if entry.symlink {
                Kind::Symlink
            } else if entry.directory {
                Kind::Directory
            } else {
                Kind::File
            };
            if observed != kind {
                return Err(changed_while_discarding(rel));
            }
        }
        admit(entry.relative, entry.depth)
    });
    let Err(failure) = result else {
        return Ok(());
    };
    let ancestor = |n: usize| rel.split('/').take(n).collect::<Vec<_>>().join("/");
    Err(match failure.error {
        ContainedRemovalError::SymlinkAncestor(n) => symlink_ancestor(rel, &ancestor(n)),
        ContainedRemovalError::NonDirectoryAncestor(n) => AppError::Other(format!(
            "cannot discard '{rel}': '{}' is no longer a directory",
            ancestor(n)
        )),
        ContainedRemovalError::Refused(message) if failure.removed => AppError::Other(format!(
            "{message} (other entries in it had already been removed)"
        )),
        ContainedRemovalError::Refused(message) => AppError::Other(message),
        ContainedRemovalError::Io(e) => AppError::Io(e),
    })
}

#[cfg(unix)]
fn remove_untracked(
    repo: &Repository,
    workdir: &Path,
    rel: &str,
    kind: Kind,
) -> Result<(), AppError> {
    let parent = Path::new(rel).parent().unwrap_or(Path::new(""));
    remove_entry(
        workdir,
        rel,
        kind,
        |relative, depth| match untracked_entry_refusal(repo, rel, &parent.join(relative), depth) {
            Ok(None) => Ok(()),
            Ok(Some(refusal)) => Err(refusal),
            Err(e) => Err(e.to_string()),
        },
    )
}

/// Clear what stands at a tracked path: a symlink (never followed) or a
/// directory that must still be empty.
#[cfg(unix)]
fn clear_obstacle(workdir: &Path, rel: &str, obstacle: Obstacle) -> Result<(), AppError> {
    let kind = match obstacle {
        Obstacle::None => return Ok(()),
        Obstacle::Symlink => Kind::Symlink,
        Obstacle::EmptyDir => Kind::Directory,
    };
    remove_entry(workdir, rel, kind, |_, depth| {
        if depth > 1 {
            Err(changed_while_discarding(rel))
        } else {
            Ok(())
        }
    })
}

#[cfg(not(unix))]
fn remove_untracked(
    repo: &Repository,
    workdir: &Path,
    rel: &str,
    kind: Kind,
) -> Result<(), AppError> {
    check_ancestors(workdir, rel)?;
    let abs = workdir.join(rel);
    let Some(meta) = lstat(&abs)? else {
        return Ok(());
    };
    if kind_of(&meta) != kind {
        return Err(AppError::Other(changed_while_discarding(rel)));
    }
    let result = match kind {
        Kind::Symlink => remove_symlink(&abs),
        Kind::Directory => {
            scan_untracked_directory(repo, workdir, rel)?;
            // Does not follow links inside the directory.
            fs::remove_dir_all(&abs)
        }
        Kind::File => fs::remove_file(&abs),
    };
    result.map_err(AppError::Io)
}

#[cfg(not(unix))]
fn clear_obstacle(workdir: &Path, rel: &str, obstacle: Obstacle) -> Result<(), AppError> {
    let abs = workdir.join(rel);
    let expected = match obstacle {
        Obstacle::None => return Ok(()),
        Obstacle::Symlink => Kind::Symlink,
        Obstacle::EmptyDir => Kind::Directory,
    };
    check_ancestors(workdir, rel)?;
    match lstat(&abs)? {
        None => return Ok(()),
        Some(meta) if kind_of(&meta) != expected => {
            return Err(AppError::Other(changed_while_discarding(rel)))
        }
        Some(_) => {}
    }
    match obstacle {
        Obstacle::Symlink => remove_symlink(&abs),
        // `remove_dir` fails rather than delete anything created since.
        _ => fs::remove_dir(&abs),
    }
    .map_err(AppError::Io)
}

/// Unlink a symlink itself. Windows directory links are removed as
/// directories; neither call follows the link.
#[cfg(not(unix))]
fn remove_symlink(abs: &Path) -> std::io::Result<()> {
    match fs::remove_file(abs) {
        Err(e) => fs::remove_dir(abs).map_err(|_| e),
        other => other,
    }
}

/// Immediately before checkout: the restored path's ancestors are still real
/// directories, and nothing but a regular file (or a submodule checkout)
/// stands at it.
fn recheck_restore(workdir: &Path, rel: &str, gitlink: bool) -> Result<(), AppError> {
    check_ancestors(workdir, rel)?;
    match lstat(&workdir.join(rel))?.as_ref().map(kind_of) {
        None | Some(Kind::File) => Ok(()),
        Some(Kind::Directory) if gitlink => Ok(()),
        Some(_) => Err(AppError::Other(changed_while_discarding(rel))),
    }
}

/// Whether entries can be created and removed in the directory `dir`.
#[cfg(unix)]
fn can_modify_directory(dir: &Path) -> bool {
    access(dir, libc::W_OK | libc::X_OK)
}

#[cfg(unix)]
fn can_write_file(file: &Path) -> bool {
    access(file, libc::W_OK)
}

#[cfg(unix)]
fn access(path: &Path, mode: libc::c_int) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), mode) == 0 }
}

// Windows ACLs are not predicted; such failures surface from the effect
// itself, naming the path.
#[cfg(not(unix))]
fn can_modify_directory(_dir: &Path) -> bool {
    true
}

#[cfg(not(unix))]
fn can_write_file(_file: &Path) -> bool {
    true
}

fn not_writable(target: &str, dir: &Path, workdir: &Path) -> AppError {
    let shown_dir = dir
        .strip_prefix(workdir)
        .ok()
        .filter(|rel| !rel.as_os_str().is_empty())
        .map(shown)
        .unwrap_or_else(|| "the repository root".to_string());
    AppError::Other(format!(
        "cannot discard '{target}': '{shown_dir}' is not writable; nothing was changed"
    ))
}

/// Refuse the whole batch before any change when a planned effect is already
/// bound to fail: a directory it must modify is not writable, a restore path
/// no longer passes its checks. (Another git process holding the index is
/// refused earlier still: the whole batch runs under `index.lock`, #1617.)
fn preflight(workdir: &Path, plans: &[Plan<'_>]) -> Result<(), AppError> {
    let parent_of = |rel: &str| {
        Path::new(rel)
            .parent()
            .map(|p| workdir.join(p))
            .unwrap_or_else(|| workdir.to_path_buf())
    };
    for plan in plans {
        match *plan {
            Plan::Remove { path, kind } => {
                let parent = parent_of(path);
                if !can_modify_directory(&parent) {
                    return Err(not_writable(path, &parent, workdir));
                }
                if kind == Kind::Directory {
                    let mut stack = vec![workdir.join(path)];
                    while let Some(dir) = stack.pop() {
                        if !can_modify_directory(&dir) {
                            return Err(not_writable(path, &dir, workdir));
                        }
                        for entry in fs::read_dir(&dir)? {
                            let entry = entry?;
                            if entry.file_type()?.is_dir() {
                                stack.push(entry.path());
                            }
                        }
                    }
                }
            }
            Plan::Restore {
                path,
                obstacle,
                gitlink,
            } => {
                check_ancestors(workdir, path)?;
                if gitlink {
                    continue;
                }
                let abs = workdir.join(path);
                let writable = match (obstacle, lstat(&abs)?) {
                    (Obstacle::None, Some(_)) => {
                        can_write_file(&abs) || can_modify_directory(&parent_of(path))
                    }
                    (Obstacle::None, None) => {
                        // Checkout creates the file and any missing parents in
                        // the nearest existing ancestor.
                        let mut dir = parent_of(path);
                        while lstat(&dir)?.is_none() {
                            match dir.parent() {
                                Some(up) if up.starts_with(workdir) => dir = up.to_path_buf(),
                                _ => break,
                            }
                        }
                        if !can_modify_directory(&dir) {
                            return Err(not_writable(path, &dir, workdir));
                        }
                        true
                    }
                    _ => can_modify_directory(&parent_of(path)),
                };
                if !writable {
                    return Err(not_writable(path, &parent_of(path), workdir));
                }
            }
        }
    }
    Ok(())
}

/// An effect's failure, naming `path` and, when earlier effects of the batch
/// already happened, how many.
fn effect_error(path: &str, removed: usize, error: AppError) -> AppError {
    let message = match error {
        AppError::Other(message) if message.contains(&format!("'{path}'")) => message,
        other => format!("cannot discard '{path}': {other}"),
    };
    AppError::Other(match removed {
        0 => message,
        1 => format!("{message} (1 other item in this batch had already been removed)"),
        n => format!("{message} ({n} other items in this batch had already been removed)"),
    })
}

pub(crate) fn discard_paths(
    repo: &Repository,
    paths: &[String],
    force: bool,
) -> Result<(), AppError> {
    discard_paths_with(repo, paths, force, || {}, || {})
}

/// `after_planning` runs once every path is validated, planned and
/// pre-flighted, before the first mutation: tests use it to change the work
/// tree in that window. `before_write` runs after the effects, before the
/// updated index is written.
fn discard_paths_with(
    repo: &Repository,
    paths: &[String],
    force: bool,
    after_planning: impl FnOnce(),
    before_write: impl FnOnce(),
) -> Result<(), AppError> {
    let requested = paths
        .iter()
        .map(|p| literal_repo_path(p))
        .collect::<Result<BTreeSet<LiteralRepoPath<'_>>, _>>()?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Other("git: bare repository has no working tree".into()))?
        .to_path_buf();

    // The whole batch runs under `index.lock` (#1617): the index it plans
    // from is the one checkout rewrites, and a concurrent git command fails
    // rather than being overwritten. Checkout uses the repository's index,
    // which `with_locked_index_mapped` makes this exact-case one; otherwise under
    // `core.ignorecase` libgit2's checkout of `B` also rewrites (or deletes) a
    // tracked `b`. Only this `Repository` handle is affected.
    let update = |index: &mut git2::Index| {
        // Conflicted paths have no stage-0 entry, so they would otherwise look
        // untracked and be deleted. Discarding a conflict has no single correct
        // resolution: the user resolves it or aborts the operation.
        for &LiteralRepoPath { path: p, .. } in &requested {
            if (1..=3).any(|stage| index.get_path(Path::new(p), stage).is_some()) {
                return Err(AppError::Other(format!(
                    "cannot discard '{p}': it has an unresolved merge conflict. \
                     Resolve the conflict (stage the file) or abort the operation."
                )));
            }
        }
        if !force {
            let tree = head_tree(repo)?;
            for &target in &requested {
                if index_differs_from_tree(repo, tree.as_ref(), index, target)? {
                    return Err(AppError::Other(format!(
                        "refusing to discard '{}' with staged changes; pass force=true to override",
                        target.path
                    )));
                }
            }
        }

        let mut plans = Vec::new();
        for &target in &requested {
            plans.extend(plan_one(repo, index, &workdir, target)?);
        }
        preflight(&workdir, &plans)?;
        after_planning();

        let mut removed = 0;
        for plan in &plans {
            if let Plan::Remove { path, kind } = plan {
                remove_untracked(repo, &workdir, path, *kind)
                    .map_err(|e| effect_error(path, removed, e))?;
                removed += 1;
            }
        }
        let mut restore: Vec<&str> = Vec::new();
        for plan in &plans {
            if let Plan::Restore {
                path,
                obstacle,
                gitlink,
            } = plan
            {
                clear_obstacle(&workdir, path, *obstacle)
                    .map_err(|e| effect_error(path, removed, e))?;
                if *obstacle != Obstacle::None {
                    removed += 1;
                }
                recheck_restore(&workdir, path, *gitlink)
                    .map_err(|e| effect_error(path, removed, e))?;
                restore.push(path);
            }
        }
        let (filtered, restore): (Vec<&str>, Vec<&str>) = {
            let tree = head_tree(repo)?;
            let mut filtered = Vec::new();
            let mut plain = Vec::new();
            for p in restore {
                if runs_filter_driver(repo, tree.as_ref(), p)? {
                    filtered.push(p);
                } else {
                    plain.push(p);
                }
            }
            (filtered, plain)
        };
        if !restore.is_empty() {
            let mut co = git2::build::CheckoutBuilder::new();
            co.force();
            // User-selected names are literal files, never globs (#1589).
            co.disable_pathspec_match(true);
            for p in &restore {
                co.path(*p);
            }
            repo.checkout_head(Some(&mut co))
                .map_err(|e| effect_error(&restore.join("', '"), removed, to_app_err(e)))?;
        }
        let update = if restore.is_empty() {
            IndexUpdate::Unchanged
        } else {
            IndexUpdate::Write
        };
        let filtered: Vec<String> = filtered.into_iter().map(str::to_owned).collect();
        Ok(((restore.join("', '"), removed, filtered), update))
    };
    with_locked_index_mapped(
        repo,
        IndexCase::Exact,
        update,
        before_write,
        // Installing the index happens after the checkout: report it as a
        // partial discard, like any other failure after an effect.
        |(restored, removed, _), e| {
            effect_error(
                restored,
                *removed,
                AppError::Other(format!(
                    "the work tree was restored, but the index could not be updated: {e}"
                )),
            )
        },
        // Filtered paths are restored by `git checkout`, which takes
        // `index.lock` itself: it runs once our index is committed and the
        // lock released, never while we hold it, and its own index update
        // for these paths (which ours left alone) is never overwritten.
        |(_, removed, filtered)| {
            if filtered.is_empty() {
                return Ok(());
            }
            let filtered: Vec<&str> = filtered.iter().map(String::as_str).collect();
            checkout_with_git_cli(&workdir, &filtered)
                .map_err(|e| effect_error(&filtered.join("', '"), *removed, e))
        },
    )
    .map(|_| ())
}

/// Whether `git checkout` writes `rel` through an external filter driver
/// (`filter=<name>` with `filter.<name>.smudge` or `.process` configured, as
/// Git LFS is), which libgit2 does not run: it would write the stored blob,
/// for LFS the pointer text (#1616). Only a regular blob in HEAD qualifies:
/// symlinks and submodules are never filtered, and a path HEAD lacks is
/// removed, not written.
fn runs_filter_driver(
    repo: &Repository,
    head: Option<&git2::Tree<'_>>,
    rel: &str,
) -> Result<bool, AppError> {
    let Some(head) = head else {
        return Ok(false);
    };
    let blob = match head.get_path(Path::new(rel)) {
        Ok(entry) => entry.kind() == Some(git2::ObjectType::Blob) && entry.filemode() != 0o120000,
        Err(e) if e.code() == git2::ErrorCode::NotFound => false,
        Err(e) => return Err(to_app_err(e)),
    };
    if !blob {
        return Ok(false);
    }
    // Checkout reads attributes from the index first, as git does.
    let value = repo
        .get_attr(
            Path::new(rel),
            "filter",
            git2::AttrCheckFlags::INDEX_THEN_FILE,
        )
        .map_err(to_app_err)?;
    let git2::AttrValue::String(driver) = git2::AttrValue::from_string(value) else {
        return Ok(false);
    };
    let config = repo.config().map_err(to_app_err)?;
    for key in ["smudge", "process"] {
        match config.get_string(&format!("filter.{driver}.{key}")) {
            Ok(command) if !command.trim().is_empty() => return Ok(true),
            Ok(_) => {}
            Err(e) if e.code() == git2::ErrorCode::NotFound => {}
            Err(e) => return Err(to_app_err(e)),
        }
    }
    Ok(false)
}

/// Restore `paths` from HEAD with `git checkout`, which runs filter drivers.
/// Pathspecs are literal (#1589) and read NUL-separated from stdin, so no
/// name is parsed as an option or glob and no command line grows too long.
/// Git itself refuses to write beyond a symbolic link and replaces, rather
/// than follows, a link at the path; each path was re-checked just before.
fn checkout_with_git_cli(workdir: &Path, paths: &[&str]) -> Result<(), AppError> {
    use crate::process_ext::NoConsole;
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("git")
        .no_console()
        .current_dir(workdir)
        .args([
            "--literal-pathspecs",
            "checkout",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
            "HEAD",
        ])
        // The repository is the one at `workdir`, whatever the app inherited.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_ICASE_PATHSPECS")
        // A filter (LFS downloading an object) must fail, not wait on a prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Other(format!("could not run git to apply filters: {e}")))?;
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    let written = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("could not open git's input".into()))
        .and_then(|mut stdin| stdin.write_all(&input).map_err(AppError::Io));
    let output = child.wait_with_output()?;
    if output.status.success() {
        return written;
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Other(if stderr.is_empty() {
        format!("git checkout failed ({})", output.status)
    } else {
        stderr
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;

    use crate::error::AppError;
    use crate::git::{collect_status, GitStatusCode};

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contents).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// A repository with the tracked files in `files`, committed.
    fn repo(files: &[(&str, &str)]) -> TempDir {
        let d = TempDir::new().unwrap();
        git(d.path(), &["init", "-q", "-b", "main"]);
        // The product's own git subprocesses read the host's config, and
        // Windows runners set core.autocrlf=true globally, which would
        // check fixture text out with CRLF line endings.
        git(d.path(), &["config", "core.autocrlf", "false"]);
        for (rel, contents) in files {
            write(d.path(), rel, contents);
        }
        git(d.path(), &["add", "-A"]);
        git(d.path(), &["commit", "-q", "-m", "init"]);
        d
    }

    fn discard(dir: &Path, paths: &[&str]) -> Result<(), AppError> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(crate::git::git_discard(
                dir.to_str().unwrap().to_string(),
                paths.iter().map(|p| p.to_string()).collect(),
                None,
            ))
    }

    fn message(err: AppError) -> String {
        format!("{err:?}")
    }

    #[cfg(unix)]
    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// #1604: the link is replaced by the tracked file; its target, outside
    /// or inside the repository, is never written.
    #[cfg(unix)]
    #[test]
    fn discarding_a_file_replaced_by_a_symlink_never_writes_the_target() {
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.json");
        fs::write(&secret, "SECRET\n").unwrap();
        let d = repo(&[("config.json", "{\"a\":1}\n"), ("sibling.txt", "orig\n")]);
        write(d.path(), "sibling.txt", "SIBLING EDIT\n");

        fs::remove_file(d.path().join("config.json")).unwrap();
        symlink(&secret, &d.path().join("config.json"));
        discard(d.path(), &["config.json"]).unwrap();
        assert_eq!(read(&secret), "SECRET\n");
        let restored = d.path().join("config.json");
        assert!(!fs::symlink_metadata(&restored)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(read(&restored), "{\"a\":1}\n");

        fs::remove_file(&restored).unwrap();
        symlink(Path::new("sibling.txt"), &restored);
        discard(d.path(), &["config.json"]).unwrap();
        assert_eq!(read(&d.path().join("sibling.txt")), "SIBLING EDIT\n");
        assert_eq!(read(&restored), "{\"a\":1}\n");
        assert!(!fs::symlink_metadata(&restored)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    /// #1606: restoring a deleted file must not remove untracked files that
    /// now live in a directory at its path; an empty directory is fine.
    #[test]
    fn discarding_a_deleted_file_refuses_to_replace_a_non_empty_directory() {
        let d = repo(&[("a", "tracked\n")]);
        fs::remove_file(d.path().join("a")).unwrap();
        write(d.path(), "a/q", "UNTRACKED\n");

        let err = message(discard(d.path(), &["a"]).unwrap_err());
        assert!(err.contains("'a'") && err.contains("directory"), "{err}");
        assert_eq!(read(&d.path().join("a/q")), "UNTRACKED\n");

        fs::remove_file(d.path().join("a/q")).unwrap();
        discard(d.path(), &["a"]).unwrap();
        assert_eq!(read(&d.path().join("a")), "tracked\n");
    }

    /// A file now standing where a tracked file's parent directory was would
    /// be deleted to restore the tracked file.
    #[test]
    fn discarding_refuses_to_delete_a_file_in_place_of_a_parent_directory() {
        let d = repo(&[("d/f", "tracked\n")]);
        fs::remove_dir_all(d.path().join("d")).unwrap();
        write(d.path(), "d", "PRECIOUS\n");
        let err = message(discard(d.path(), &["d/f"]).unwrap_err());
        assert!(err.contains("'d'"), "{err}");
        assert_eq!(read(&d.path().join("d")), "PRECIOUS\n");
    }

    #[cfg(unix)]
    #[test]
    fn discarding_never_follows_a_symlinked_parent_out_of_the_repository() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("f"), "OUTSIDE F\n").unwrap();
        fs::write(outside.path().join("secret.txt"), "SECRET\n").unwrap();
        let d = repo(&[("d/f", "tracked\n")]);

        // Tracked path below a directory replaced by a symlink.
        fs::remove_dir_all(d.path().join("d")).unwrap();
        symlink(outside.path(), &d.path().join("d"));
        let err = message(discard(d.path(), &["d/f"]).unwrap_err());
        assert!(err.contains("symbolic link"), "{err}");
        assert_eq!(read(&outside.path().join("f")), "OUTSIDE F\n");

        // Untracked-looking path through an untracked symlink.
        symlink(outside.path(), &d.path().join("link"));
        assert!(discard(d.path(), &["link/secret.txt"]).is_err());
        assert_eq!(read(&outside.path().join("secret.txt")), "SECRET\n");
    }

    #[cfg(unix)]
    #[test]
    fn removing_an_untracked_symlink_removes_only_the_link() {
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("keep.txt"), "KEEP\n").unwrap();
        let d = repo(&[("base.txt", "1\n")]);
        symlink(outside.path(), &d.path().join("dirlink"));
        symlink(&outside.path().join("keep.txt"), &d.path().join("filelink"));
        symlink(Path::new("/nonexistent/target"), &d.path().join("dangling"));

        discard(d.path(), &["dirlink", "filelink", "dangling"]).unwrap();

        for link in ["dirlink", "filelink", "dangling"] {
            assert!(fs::symlink_metadata(d.path().join(link)).is_err(), "{link}");
        }
        assert_eq!(read(&outside.path().join("keep.txt")), "KEEP\n");
    }

    #[test]
    fn absolute_and_escaping_paths_are_rejected_without_side_effects() {
        let outside = TempDir::new().unwrap();
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, "VICTIM\n").unwrap();
        let d = repo(&[("a.txt", "1\n")]);
        write(d.path(), "a.txt", "EDIT\n");
        let rel_escape = format!(
            "../{}/victim.txt",
            outside.path().file_name().unwrap().to_str().unwrap()
        );
        for bad in [
            victim.to_str().unwrap(),
            rel_escape.as_str(),
            "..",
            ".",
            "./a.txt",
            "",
            ".git/config",
        ] {
            let err = discard(d.path(), &[bad, "a.txt"]).expect_err(bad);
            assert!(matches!(err, AppError::InvalidPath(_)), "{bad:?}: {err:?}");
        }
        assert_eq!(read(&victim), "VICTIM\n");
        // Nothing in the batch ran.
        assert_eq!(read(&d.path().join("a.txt")), "EDIT\n");
        assert!(d.path().join(".git/config").exists());
    }

    #[test]
    fn removing_a_directory_that_holds_tracked_files_is_refused() {
        let d = repo(&[("dir/tracked.txt", "T\n")]);
        write(d.path(), "dir/untracked.txt", "U\n");
        let err = message(discard(d.path(), &["dir"]).unwrap_err());
        assert!(err.contains("tracked"), "{err}");
        assert_eq!(read(&d.path().join("dir/tracked.txt")), "T\n");
        assert_eq!(read(&d.path().join("dir/untracked.txt")), "U\n");
    }

    /// #1605: a moved-and-edited file is listed as the deleted source plus the
    /// untracked destination, and discarding the rows as shown restores the
    /// source without touching the destination's edits.
    #[test]
    fn worktree_rename_is_two_rows_whose_discards_do_what_they_say() {
        let d = repo(&[("old.txt", "line1\nline2\nline3\nline4\n")]);
        fs::rename(d.path().join("old.txt"), d.path().join("new.txt")).unwrap();
        write(d.path(), "new.txt", "line1\nline2\nline3\nline4\nEDIT\n");

        let repo = crate::git_common::open_repo(d.path()).unwrap();
        let status = collect_status(&repo).unwrap();
        let rows: Vec<(&str, GitStatusCode)> = status
            .changes
            .iter()
            .map(|e| (e.path.as_str(), e.status))
            .collect();
        assert_eq!(rows, [("old.txt", GitStatusCode::Deleted)]);
        let untracked: Vec<&str> = status.untracked.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(untracked, ["new.txt"]);

        discard(d.path(), &["old.txt"]).unwrap();
        assert_eq!(
            read(&d.path().join("old.txt")),
            "line1\nline2\nline3\nline4\n"
        );
        assert_eq!(
            read(&d.path().join("new.txt")),
            "line1\nline2\nline3\nline4\nEDIT\n"
        );
    }

    /// A `/` names a directory, as status writes a nested repository's row.
    #[test]
    fn a_trailing_slash_requires_a_directory() {
        let d = repo(&[("base.txt", "1\n")]);
        write(d.path(), "plain", "P\n");
        assert!(discard(d.path(), &["plain/"]).is_err());
        assert_eq!(read(&d.path().join("plain")), "P\n");
        write(d.path(), "dir/x", "X\n");
        discard(d.path(), &["dir/"]).unwrap();
        assert!(!d.path().join("dir").exists());
    }

    fn discard_racing(
        dir: &Path,
        paths: &[&str],
        after_planning: impl FnOnce(),
    ) -> Result<(), AppError> {
        let repo = crate::git_common::open_repo(dir).unwrap();
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        super::discard_paths_with(&repo, &paths, false, after_planning, || {})
    }

    /// A failure to install the index after checkout restored the work tree
    /// is reported as that partial discard, naming the path (#1617 review).
    #[test]
    fn a_failure_to_install_the_index_after_checkout_names_what_happened() {
        let d = repo(&[("a", "1\n")]);
        git(d.path(), &["config", "core.autocrlf", "false"]);
        write(d.path(), "a", "EDIT\n");
        let index_path = d.path().join(".git/index");
        let repo = crate::git_common::open_repo(d.path()).unwrap();
        let err = super::discard_paths_with(
            &repo,
            &["a".to_string()],
            false,
            || {},
            // A non-empty directory cannot be replaced by a rename.
            || {
                fs::remove_file(&index_path).unwrap();
                fs::create_dir(&index_path).unwrap();
                fs::write(index_path.join("x"), "").unwrap();
            },
        )
        .unwrap_err();
        let err = message(err);
        assert!(err.contains("cannot discard 'a'"), "{err}");
        assert!(err.contains("work tree was restored"), "{err}");
        assert_eq!(read(&d.path().join("a")), "1\n");
        crate::git_index_lock::tests::assert_no_leftovers(&d.path().join(".git"));
    }

    /// `core.ignorecase` must not turn a Remove of the untracked `A` into a
    /// restore of the tracked, edited `a`, nor let a staged change to one
    /// case variant decide for the other (#1589 review).
    #[test]
    fn case_variants_under_ignorecase_are_distinct_paths() {
        let d = repo(&[("a", "1\n")]);
        git(d.path(), &["config", "core.ignorecase", "true"]);
        write(d.path(), "a", "EDIT\n");
        write(d.path(), "A", "UNTRACKED\n");
        if read(&d.path().join("a")) != "EDIT\n" {
            eprintln!(
                "SKIPPED case_variants_under_ignorecase_are_distinct_paths: the temporary \
                 directory is on a case-insensitive file system, where `a` and `A` are one file"
            );
            return;
        }

        discard(d.path(), &["A"]).unwrap();
        assert!(fs::symlink_metadata(d.path().join("A")).is_err());
        assert_eq!(read(&d.path().join("a")), "EDIT\n");

        let d = repo(&[("b", "1\n"), ("B", "1\n")]);
        git(d.path(), &["config", "core.ignorecase", "true"]);
        write(d.path(), "b", "STAGED\n");
        git(d.path(), &["add", "b"]);
        write(d.path(), "B", "EDIT\n");
        discard(d.path(), &["B"]).unwrap();
        assert_eq!(read(&d.path().join("B")), "1\n");
        assert_eq!(read(&d.path().join("b")), "STAGED\n");
        let err = message(discard(d.path(), &["b"]).unwrap_err());
        assert!(err.contains("staged"), "{err}");
    }

    /// #1618: an untracked path's parent swapped for a link to outside the
    /// repository after planning must not be followed.
    #[cfg(unix)]
    #[test]
    fn a_parent_swapped_for_a_symlink_after_planning_is_not_followed() {
        let outside = TempDir::new().unwrap();
        fs::create_dir(outside.path().join("inner")).unwrap();
        fs::write(outside.path().join("inner/victim"), "PRECIOUS\n").unwrap();
        let d = repo(&[("t", "1\n")]);
        write(d.path(), "t", "EDIT\n");
        write(d.path(), "u/inner/victim", "junk\n");

        let result = discard_racing(d.path(), &["t", "u/inner/victim"], || {
            fs::rename(d.path().join("u"), d.path().join("u.real")).unwrap();
            symlink(outside.path(), &d.path().join("u"));
        });
        assert_eq!(read(&outside.path().join("inner/victim")), "PRECIOUS\n");
        let err = message(result.unwrap_err());
        assert!(err.contains("symbolic link"), "{err}");
    }

    /// #1604 under a race: a tracked file replaced by a link after planning
    /// is not written through.
    #[cfg(unix)]
    #[test]
    fn a_tracked_file_swapped_for_a_symlink_after_planning_is_not_written_through() {
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret");
        fs::write(&secret, "SECRET\n").unwrap();
        let d = repo(&[("config.json", "{}\n")]);
        write(d.path(), "config.json", "EDIT\n");

        let _ = discard_racing(d.path(), &["config.json"], || {
            fs::remove_file(d.path().join("config.json")).unwrap();
            symlink(&secret, &d.path().join("config.json"));
        });
        assert_eq!(read(&secret), "SECRET\n");
    }

    /// An untracked directory that gains a repository after planning keeps it.
    #[test]
    fn a_repository_created_after_planning_is_not_removed() {
        let d = repo(&[("base.txt", "1\n")]);
        // Many siblings, so some precede `.git` in any directory order.
        let names: Vec<String> = (0..40).map(|i| format!("late/f{i:02}")).collect();
        for name in &names {
            write(d.path(), name, "WORK\n");
        }
        let result = discard_racing(d.path(), &["late"], || {
            git(&d.path().join("late"), &["init", "-q"]);
        });
        let err = message(result.unwrap_err());
        assert!(err.contains("late/.git"), "{err}");
        assert!(d.path().join("late/.git/HEAD").is_file());
        for name in &names {
            assert_eq!(read(&d.path().join(name)), "WORK\n", "{name} was removed");
        }
    }

    /// #1615: Remove never deletes a Git repository, wherever its `.git`
    /// (directory or file) is, and names it.
    #[test]
    fn removing_a_directory_that_holds_a_repository_is_refused() {
        // Nested repository, as status lists it.
        let d = repo(&[("base.txt", "1\n")]);
        let sub = d.path().join("sub");
        fs::create_dir(&sub).unwrap();
        git(&sub, &["init", "-q"]);
        write(&sub, "wip", "UNCOMMITTED\n");
        let err = message(discard(d.path(), &["sub/"]).unwrap_err());
        assert!(err.contains("sub/.git"), "{err}");
        assert_eq!(read(&sub.join("wip")), "UNCOMMITTED\n");
        assert!(sub.join(".git").is_dir());
        // Without the trailing slash, and a path inside it.
        assert!(discard(d.path(), &["sub"]).is_err());
        let err = message(discard(d.path(), &["sub/wip"]).unwrap_err());
        assert!(err.contains("sub/.git"), "{err}");
        assert_eq!(read(&sub.join("wip")), "UNCOMMITTED\n");

        // Deeply nested repository inside an untracked directory.
        write(d.path(), "deep/a/b/note", "N\n");
        git(&d.path().join("deep/a/b"), &["init", "-q"]);
        let err = message(discard(d.path(), &["deep"]).unwrap_err());
        assert!(err.contains("deep/a/b/.git"), "{err}");
        assert_eq!(read(&d.path().join("deep/a/b/note")), "N\n");
    }

    #[test]
    fn removing_a_linked_worktree_inside_the_repository_is_refused() {
        let d = repo(&[("a", "1\n")]);
        git(d.path(), &["worktree", "add", "-q", "-b", "other", "inwt"]);
        write(d.path(), "inwt/wip", "WORK\n");
        let repo = crate::git_common::open_repo(d.path()).unwrap();
        let rows: Vec<String> = collect_status(&repo)
            .unwrap()
            .untracked
            .iter()
            .map(|e| e.path.clone())
            .collect();
        assert_eq!(rows, ["inwt/"]);

        let err = message(discard(d.path(), &["inwt/"]).unwrap_err());
        assert!(err.contains("inwt/.git"), "{err}");
        assert_eq!(read(&d.path().join("inwt/wip")), "WORK\n");
        assert!(d.path().join("inwt/.git").is_file());
    }

    /// Ignored files are never listed as untracked, so a directory Remove that
    /// would delete them is refused, naming one; nothing is deleted.
    #[test]
    fn removing_a_directory_that_holds_ignored_files_is_refused() {
        let d = repo(&[(".gitignore", "*.log\nbuild/\n")]);
        write(d.path(), "tmp/keep.txt", "K\n");
        write(d.path(), "tmp/debug.log", "LOG\n");
        let err = message(discard(d.path(), &["tmp"]).unwrap_err());
        assert!(err.contains("tmp/debug.log"), "{err}");
        assert_eq!(read(&d.path().join("tmp/keep.txt")), "K\n");
        assert_eq!(read(&d.path().join("tmp/debug.log")), "LOG\n");

        write(d.path(), "out/src.c", "C\n");
        write(d.path(), "out/build/x.o", "O\n");
        let err = message(discard(d.path(), &["out"]).unwrap_err());
        assert!(err.contains("out/build"), "{err}");
        assert_eq!(read(&d.path().join("out/build/x.o")), "O\n");

        // Without ignored content the directory goes.
        write(d.path(), "plain/a", "A\n");
        discard(d.path(), &["plain"]).unwrap();
        assert!(!d.path().join("plain").exists());
    }

    /// Restores `mode` on `path` when dropped, so a failed assertion still
    /// leaves the temporary directory removable.
    #[cfg(unix)]
    struct ModeGuard(std::path::PathBuf, u32);

    #[cfg(unix)]
    impl ModeGuard {
        fn set(path: &Path, mode: u32, restore: u32) -> Self {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
            Self(path.to_path_buf(), restore)
        }
    }

    #[cfg(unix)]
    impl Drop for ModeGuard {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(self.1));
        }
    }

    /// Permission tests mean nothing to root, which bypasses them.
    #[cfg(unix)]
    fn skip_as_root(test: &str) -> bool {
        // SAFETY: geteuid has no preconditions.
        let root = unsafe { libc::geteuid() } == 0;
        if root {
            eprintln!("SKIPPED {test}: running as root, which bypasses file permissions");
        }
        root
    }

    /// A search-only ancestor (a 0711 home directory) must not stop a Remove
    /// or a typechange discard: only the repository and below are walked
    /// without following links (review of #1618).
    #[cfg(unix)]
    #[test]
    fn discard_works_below_a_search_only_ancestor() {
        if skip_as_root("discard_works_below_a_search_only_ancestor") {
            return;
        }
        let base = TempDir::new().unwrap();
        let home = base.path().join("home");
        let work = home.join("repo");
        fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        write(&work, "a", "1\n");
        write(&work, "cfg", "C\n");
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "init"]);
        write(&work, "u.txt", "U\n");
        symlink(Path::new("nowhere"), &work.join("ulink"));
        fs::remove_file(work.join("cfg")).unwrap();
        symlink(Path::new("a"), &work.join("cfg"));

        let _guard = ModeGuard::set(&home, 0o311, 0o755);
        discard(&work, &["u.txt", "ulink", "cfg"]).unwrap();

        assert!(fs::symlink_metadata(work.join("u.txt")).is_err());
        assert!(fs::symlink_metadata(work.join("ulink")).is_err());
        let cfg = fs::symlink_metadata(work.join("cfg")).unwrap();
        assert!(cfg.file_type().is_file());
        assert_eq!(read(&work.join("cfg")), "C\n");
        assert_eq!(read(&work.join("a")), "1\n");
    }

    /// Foreseeable failures refuse the whole batch before anything changes,
    /// naming the path (review of #1618).
    #[cfg(unix)]
    #[test]
    fn a_foreseeable_failure_refuses_the_batch_before_any_change() {
        if skip_as_root("a_foreseeable_failure_refuses_the_batch_before_any_change") {
            return;
        }
        // A deleted tracked file to restore into a read-only directory.
        let d = repo(&[("a", "1\n"), ("ro/m", "1\n")]);
        write(d.path(), "a", "EDIT\n");
        fs::remove_file(d.path().join("ro/m")).unwrap();
        write(d.path(), "u.txt", "U\n");
        let guard = ModeGuard::set(&d.path().join("ro"), 0o555, 0o755);
        let err = message(discard(d.path(), &["a", "u.txt", "ro/m"]).unwrap_err());
        drop(guard);
        assert!(err.contains("ro/m"), "{err}");
        assert_eq!(read(&d.path().join("u.txt")), "U\n");
        assert_eq!(read(&d.path().join("a")), "EDIT\n");

        // An untracked file to remove from a read-only directory.
        write(d.path(), "zrod/f", "F\n");
        write(d.path(), "u1.txt", "U1\n");
        let guard = ModeGuard::set(&d.path().join("zrod"), 0o555, 0o755);
        let err = message(discard(d.path(), &["a", "u1.txt", "zrod/f"]).unwrap_err());
        drop(guard);
        assert!(err.contains("zrod/f"), "{err}");
        assert_eq!(read(&d.path().join("u1.txt")), "U1\n");
        assert_eq!(read(&d.path().join("zrod/f")), "F\n");
        assert_eq!(read(&d.path().join("a")), "EDIT\n");
    }

    /// Another git process holding the index refuses the batch up front
    /// instead of failing the checkout after the removals.
    #[test]
    fn a_held_index_lock_refuses_the_batch_before_any_change() {
        let d = repo(&[("a", "1\n")]);
        write(d.path(), "a", "EDIT\n");
        write(d.path(), "u.txt", "U\n");
        fs::write(d.path().join(".git/index.lock"), "").unwrap();
        let err = message(discard(d.path(), &["a", "u.txt"]).unwrap_err());
        assert!(err.contains("index.lock"), "{err}");
        assert_eq!(read(&d.path().join("u.txt")), "U\n");
        assert_eq!(read(&d.path().join("a")), "EDIT\n");
    }

    /// A `git add` run while a discard is between planning and writing the
    /// index must never exit 0 and then vanish (#1617): the discard holds
    /// `index.lock`, so git refuses and the restore still lands.
    #[test]
    fn a_concurrent_git_add_during_discard_is_never_silently_lost() {
        let d = repo(&[("a", "1\n")]);
        git(d.path(), &["config", "core.autocrlf", "false"]);
        write(d.path(), "a", "EDIT\n");
        write(d.path(), "concurrent.txt", "c\n");
        let mut concurrent = None;
        discard_racing(d.path(), &["a"], || {
            concurrent = Some(
                Command::new("git")
                    .current_dir(d.path())
                    .args(["add", "concurrent.txt"])
                    .output()
                    .unwrap(),
            );
        })
        .unwrap();
        let concurrent = concurrent.unwrap();
        let tracked = Command::new("git")
            .current_dir(d.path())
            .args(["ls-files"])
            .output()
            .unwrap();
        let tracked = String::from_utf8_lossy(&tracked.stdout).into_owned();
        assert!(
            !concurrent.status.success() || tracked.lines().any(|l| l == "concurrent.txt"),
            "git add exited 0 but concurrent.txt was lost:\n{tracked}"
        );
        assert!(
            String::from_utf8_lossy(&concurrent.stderr).contains("index.lock"),
            "{concurrent:?}"
        );
        assert_eq!(read(&d.path().join("a")), "1\n");
        crate::git_index_lock::tests::assert_no_leftovers(&d.path().join(".git"));
        git(d.path(), &["add", "concurrent.txt"]);
    }

    /// A failure after earlier removals names the failing path and how many
    /// items were already removed.
    #[test]
    fn a_mid_batch_failure_names_the_path_and_what_was_already_removed() {
        let d = repo(&[("a", "1\n")]);
        write(d.path(), "u1.txt", "U1\n");
        write(d.path(), "zz/f", "F\n");
        let err = message(
            discard_racing(d.path(), &["u1.txt", "zz/f"], || {
                fs::remove_file(d.path().join("zz/f")).unwrap();
                fs::create_dir(d.path().join("zz/f")).unwrap();
            })
            .unwrap_err(),
        );
        assert!(err.contains("'zz/f'"), "{err}");
        assert!(err.contains("1 other item"), "{err}");
        assert!(fs::symlink_metadata(d.path().join("u1.txt")).is_err());
        assert!(d.path().join("zz/f").is_dir());
    }

    /// A repository whose `*.txt` files pass through a `tr` filter driver:
    /// stored lower-case, checked out upper-case, as `git checkout` writes
    /// them. The local `core.autocrlf` overrides Windows runners' global one.
    fn filtered_repo() -> TempDir {
        let d = TempDir::new().unwrap();
        git(d.path(), &["init", "-q", "-b", "main"]);
        git(d.path(), &["config", "core.autocrlf", "false"]);
        git(d.path(), &["config", "filter.upper.smudge", "tr a-z A-Z"]);
        git(d.path(), &["config", "filter.upper.clean", "tr A-Z a-z"]);
        write(d.path(), ".gitattributes", "*.txt filter=upper\n");
        write(d.path(), "f.txt", "hello\n");
        write(d.path(), "gone.txt", "bye\n");
        write(d.path(), "staged.txt", "s\n");
        write(d.path(), "plain.md", "plain\n");
        git(d.path(), &["add", "-A"]);
        git(d.path(), &["commit", "-q", "-m", "init"]);
        d
    }

    /// #1616: Discard writes what `git checkout` writes, running the smudge
    /// filter (for Git LFS, the file rather than its pointer text), and
    /// leaves the index matching the restored files.
    #[test]
    fn discarding_runs_the_smudge_filter_like_git_checkout() {
        let d = filtered_repo();
        write(d.path(), "f.txt", "edited\n");
        fs::remove_file(d.path().join("gone.txt")).unwrap();
        write(d.path(), "staged.txt", "staged edit\n");
        git(d.path(), &["add", "staged.txt"]);
        write(d.path(), "plain.md", "EDIT\n");

        discard(d.path(), &["f.txt", "gone.txt", "plain.md"]).unwrap();
        assert_eq!(read(&d.path().join("f.txt")), "HELLO\n");
        assert_eq!(read(&d.path().join("gone.txt")), "BYE\n");
        assert_eq!(read(&d.path().join("plain.md")), "plain\n");

        let repo = crate::git_common::open_repo(d.path()).unwrap();
        let paths: Vec<String> = vec!["staged.txt".into()];
        super::discard_paths(&repo, &paths, true).unwrap();
        assert_eq!(read(&d.path().join("staged.txt")), "S\n");

        let status = collect_status(&repo).unwrap();
        assert!(status.changes.is_empty(), "{:?}", status.changes);
        assert!(status.staged.is_empty(), "{:?}", status.staged);
    }

    /// #1604 still holds on the git CLI route: a filtered file replaced by a
    /// symlink is restored in place of the link, never through it.
    #[cfg(unix)]
    #[test]
    fn a_filtered_file_replaced_by_a_symlink_is_not_written_through() {
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "secret\n").unwrap();
        let d = filtered_repo();
        fs::remove_file(d.path().join("f.txt")).unwrap();
        symlink(&secret, &d.path().join("f.txt"));

        discard(d.path(), &["f.txt"]).unwrap();
        assert_eq!(read(&secret), "secret\n");
        let restored = d.path().join("f.txt");
        assert!(fs::symlink_metadata(&restored)
            .unwrap()
            .file_type()
            .is_file());
        assert_eq!(read(&restored), "HELLO\n");
    }

    #[test]
    fn discarding_a_missing_untracked_path_is_a_no_op() {
        let d = repo(&[("a.txt", "1\n")]);
        discard(d.path(), &["gone.txt"]).unwrap();
        assert_eq!(read(&d.path().join("a.txt")), "1\n");
    }
}
