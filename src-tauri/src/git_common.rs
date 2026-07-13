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
