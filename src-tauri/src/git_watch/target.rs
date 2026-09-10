//! Repository discovery and event policy, independent of the service runtime.
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::git_common::{open_repo, workdir_key};

#[derive(Clone, Debug)]
pub(super) struct Target {
    pub key: String,
    pub source: String,
    pub roots: Vec<PathBuf>,
    pub metadata: Vec<PathBuf>,
}

impl Target {
    pub fn resolve(path: &str) -> Result<Self, AppError> {
        let repo = open_repo(Path::new(path))?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| AppError::Other("git: bare repo cannot be watched".into()))?;
        let metadata = vec![repo.path().to_path_buf(), repo.commondir().to_path_buf()];
        let mut roots: Vec<PathBuf> = Vec::new();
        for candidate in [workdir, repo.path(), repo.commondir()] {
            if roots.iter().any(|root| candidate.starts_with(root)) {
                continue;
            }
            roots.retain(|root| !root.starts_with(candidate));
            roots.push(candidate.to_path_buf());
        }
        Ok(Self {
            key: workdir_key(&repo)
                .ok_or_else(|| AppError::Other("git: missing workdir".into()))?,
            source: workdir.to_string_lossy().into_owned(),
            roots,
            metadata,
        })
    }

    pub fn relevant(&self, event: &notify::Event) -> bool {
        if event.need_rescan() {
            return true;
        }
        if event.kind.is_access() {
            return false;
        }
        if event.paths.is_empty() {
            return true;
        }
        event.paths.iter().any(|path| {
            if !self
                .roots
                .iter()
                .any(|root| path.starts_with(root) || root.starts_with(path))
            {
                return false;
            }
            let temporary =
                path.to_string_lossy().ends_with(".lock") || path.to_string_lossy().ends_with('~');
            !temporary || !self.metadata.iter().any(|root| path.starts_with(root))
        })
    }

    pub fn lost_root(&self, event: &notify::Event) -> bool {
        (event.kind.is_remove()
            || matches!(
                event.kind,
                notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            ))
            && event
                .paths
                .iter()
                .any(|path| self.roots.iter().any(|root| root.starts_with(path)))
    }
}

pub(super) fn install(
    target: &Target,
    mut watch: impl FnMut(&Path, notify::RecursiveMode) -> notify::Result<()>,
) -> Result<(), AppError> {
    // Root movement/deletion requires a parent watch. Keep it non-recursive;
    // relevant() rejects unrelated siblings in that parent directory.
    let mut parents = std::collections::HashSet::new();
    for parent in target.roots.iter().filter_map(|root| root.parent()) {
        if target.roots.iter().any(|root| parent.starts_with(root)) || !parents.insert(parent) {
            continue;
        }
        watch(parent, notify::RecursiveMode::NonRecursive).map_err(|error| {
            AppError::Other(format!("git watch parent {}: {error}", parent.display()))
        })?;
    }
    for root in &target.roots {
        watch(root, notify::RecursiveMode::Recursive)
            .map_err(|error| AppError::Other(format!("git watch {}: {error}", root.display())))?;
    }
    Ok(())
}
