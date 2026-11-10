//! Shared git plumbing used by `git.rs`, `git_log.rs`, and `git_actions.rs`.
//! Issue: refactor/audit-tier4-quick-fixes (audit A8)

use crate::error::AppError;
use git2::{Repository, RepositoryOpenFlags};
use std::path::Path;

pub(crate) fn to_app_err(e: git2::Error) -> AppError {
    AppError::Other(format!("git: {}", e.message()))
}

/// Open the repository containing `path` without crossing filesystem
/// boundaries upward indefinitely (plain `open_ext` with no ceiling dirs).
pub(crate) fn open_repo(path: &Path) -> Result<Repository, AppError> {
    Repository::open_ext(
        path,
        RepositoryOpenFlags::empty(),
        std::iter::empty::<&Path>(),
    )
    .map_err(to_app_err)
}

/// Repo workdir as the canonical cache-key string: full path with any
/// trailing separator stripped (git2's `workdir()` keeps one, while pane
/// paths and the mock backend don't — the mismatch gave the same repo two
/// cache identities across the frontend's repo-keyed caches, #369).
pub(crate) fn workdir_key(repo: &Repository) -> Option<String> {
    repo.workdir().map(|wd| {
        let mut s = wd.to_string_lossy().to_string();
        while s.len() > 1 && (s.ends_with('/') || s.ends_with('\\')) {
            s.pop();
        }
        s
    })
}

/// A renderer-supplied repository path that SCM mutations treat as a literal
/// index path (#1589).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct LiteralRepoPath<'a> {
    /// `/`-separated, relative, normalised, without a trailing `/`.
    pub path: &'a str,
    /// The request ended in `/`, as status does for an untracked directory it
    /// does not descend into (a nested repository): it names a directory only.
    pub dir_only: bool,
}

/// Validate a renderer-supplied repository path that SCM mutations treat as a
/// literal index path (#1589): `/`-separated, relative, already normalised,
/// optionally with one trailing `/` marking a directory.
///
/// Rejected rather than "resolved": empty, absolute or drive-prefixed paths,
/// empty / `.` / `..` segments (`./a`, `d/../a`, `a//b`, `d//`), NUL,
/// any segment that can name `.git` (`names_git_metadata`), and on Windows a
/// `\` (index paths never contain one, so it could only name a different file
/// than the one the user selected) or a segment ending in `.` or ` `.
/// libgit2 would otherwise panic on an absolute path (`Index::get_path`), and a
/// non-normalised one silently names nothing in the index.
pub(crate) fn literal_repo_path(raw: &str) -> Result<LiteralRepoPath<'_>, AppError> {
    let invalid = |why: &str| AppError::InvalidPath(format!("{why}: {raw:?}"));
    let (path, dir_only) = match raw.strip_suffix('/') {
        Some(stripped) => (stripped, true),
        None => (raw, false),
    };
    if path.is_empty() {
        return Err(invalid("empty repository path"));
    }
    if path.contains('\0') {
        return Err(invalid("repository path contains NUL"));
    }
    if cfg!(windows) && path.contains('\\') {
        return Err(invalid("repository path must use '/' separators"));
    }
    let p = Path::new(path);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                std::path::Component::Prefix(_) | std::path::Component::RootDir
            )
        })
    {
        return Err(invalid("expected a repository-relative path"));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(invalid("repository path is not normalised"));
        }
        if names_git_metadata(segment) {
            return Err(invalid("repository path names git metadata"));
        }
        // Windows strips trailing dots and spaces from a name, so `a.` would
        // be the file `a`. Elsewhere they are ordinary, trackable names.
        if cfg!(windows) && segment.ends_with(['.', ' ']) {
            return Err(invalid("repository path segment ends in a dot or space"));
        }
    }
    Ok(LiteralRepoPath { path, dir_only })
}

/// Whether a path segment can name the `.git` directory on some file system
/// git supports (git's `is_ntfs_dotgit` / `is_hfs_dotgit` family, which
/// `core.protectNTFS` applies on every platform): `.git` in any case, followed
/// only by dots and spaces (which NTFS strips) up to an optional `:stream`,
/// and its 8.3 short names `GIT~<digits>`. Rejected on every platform: a
/// repository is often shared between them.
fn names_git_metadata(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix(".git") {
        rest
    } else if let Some(rest) = lower.strip_prefix("git~") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        &rest[digits..]
    } else {
        return false;
    };
    let before_stream = rest.split(':').next().unwrap_or_default();
    before_stream.bytes().all(|b| b == b'.' || b == b' ')
}

#[cfg(test)]
mod tests {
    use super::literal_repo_path;

    #[test]
    fn git_metadata_aliases_are_rejected_on_every_platform() {
        for bad in [
            ".git",
            ".GIT",
            ".Git/config",
            "d/.git/x",
            ".git.",
            ".git ",
            ".git. .",
            ".git::$INDEX_ALLOCATION",
            ".git:stream",
            "GIT~1",
            "git~12/config",
            "d/Git~3.",
        ] {
            assert!(literal_repo_path(bad).is_err(), "{bad:?} accepted");
        }
        for good in [
            ".gitignore",
            ".gitx",
            "git~",
            "git~x",
            "git~1a",
            "a.git",
            "x.git/y",
        ] {
            assert!(literal_repo_path(good).is_ok(), "{good:?} rejected");
        }
    }

    /// `a.` and `a ` are distinct, trackable files on Unix but the file `a`
    /// on Windows.
    #[test]
    fn trailing_dots_and_spaces_are_rejected_only_on_windows() {
        for name in ["a.", "a ", "d./x", "d /x", "a..", "x/..."] {
            assert_eq!(literal_repo_path(name).is_err(), cfg!(windows), "{name:?}");
        }
    }
}
