//! Pure batch admission and outcome projection. Paths retain their IPC spelling.
use crate::files::trash_artifact::{TrashArtifact, TrashSuccess};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path},
    sync::Arc,
};

const MAX_PATHS: usize = 32_768;
const MAX_PATH_BYTES: usize = 8 * 1024 * 1024;

pub(crate) struct BatchPlan {
    pub paths: Vec<String>,
}

impl BatchPlan {
    pub fn new(paths: Vec<String>) -> Result<Self, String> {
        if paths.len() > MAX_PATHS
            || paths
                .iter()
                .try_fold(0usize, |size, path| size.checked_add(path.len()))
                .is_none_or(|size| size > MAX_PATH_BYTES)
        {
            return Err("File batch exceeds its path count or size limit".into());
        }
        for path in &paths {
            let native = Path::new(path);
            if path.contains('\0')
                || !native.is_absolute()
                || native.file_name().is_none()
                || native
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(format!("File batch requires absolute non-root paths without parent traversal or NUL bytes: {path}"));
            }
        }
        let mut seen = HashSet::new();
        let paths: Vec<_> = paths
            .into_iter()
            .filter(|path| seen.insert(path.clone()))
            .collect();
        // Component ordering places a selected ancestor immediately before
        // its first selected descendant. Hashing every ancestor prefix would
        // make admission quadratic for deeply nested input paths.
        let mut native: Vec<_> = paths.iter().map(Path::new).collect();
        native.sort_unstable();
        for pair in native.windows(2) {
            if pair[0] == pair[1] {
                return Err("File batch contains multiple spellings of the same path".into());
            }
            if pair[1].starts_with(pair[0]) {
                return Err(
                    "Select either a directory or its descendants in one file batch".into(),
                );
            }
        }
        Ok(Self { paths })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct FileFailure {
    pub(crate) path: String,
    pub(crate) error: String,
}

/// Disjoint partitions of admitted inputs, preserving input order within each.
#[derive(Clone, Debug, Default, Serialize)]
pub struct FileBatchOutcome {
    #[serde(skip)]
    pub(crate) artifacts: BTreeMap<String, Arc<TrashArtifact>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) warnings: Vec<FileFailure>,
    /// Native reconciliation effects independent of requested-item success.
    /// These are conservative invalidations, not created-directory ownership.
    /// The native coordinator publishes them; they are not a renderer receipt.
    #[serde(skip)]
    pub(crate) refresh_dirs: Vec<String>,
    pub(crate) succeeded: Vec<String>,
    pub(crate) failed: Vec<FileFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) uncertain: Vec<FileFailure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) unstarted: Vec<String>,
}

impl FileBatchOutcome {
    pub fn affected_paths(&self) -> impl Iterator<Item = &String> {
        self.succeeded
            .iter()
            .chain(self.uncertain.iter().map(|failure| &failure.path))
    }

    pub fn error(&self) -> Option<String> {
        let mut errors: Vec<_> = self
            .failed
            .iter()
            .map(|item| format!("{}: {}", item.path, item.error))
            .collect();
        errors.extend(self.uncertain.iter().map(|item| {
            format!(
                "{}: outcome is uncertain; inspect the affected files before continuing: {}",
                item.path, item.error
            )
        }));
        errors.extend(
            self.warnings
                .iter()
                .map(|item| format!("{}: {}", item.path, item.error)),
        );
        if !self.unstarted.is_empty() {
            errors.push(format!("{} items were not started", self.unstarted.len()));
        }
        (!errors.is_empty()).then(|| errors.join("; "))
    }
}

#[derive(Clone, Debug, Default)]
pub(super) enum ItemState {
    #[default]
    Unstarted,
    Active,
    Succeeded(TrashSuccess),
    Failed(String),
    Uncertain(String),
}

pub(super) fn settle(
    paths: Vec<String>,
    states: Vec<ItemState>,
    worker_error: Option<String>,
) -> FileBatchOutcome {
    let mut outcome = FileBatchOutcome::default();
    for (path, state) in paths.into_iter().zip(states) {
        match state {
            ItemState::Succeeded(success) => {
                if let Some(artifact) = success.artifact {
                    outcome.artifacts.insert(path.clone(), artifact);
                }
                if let Some(error) = success.warning {
                    outcome.warnings.push(FileFailure {
                        path: path.clone(),
                        error,
                    });
                }
                outcome.succeeded.push(path);
            }
            ItemState::Failed(error) => outcome.failed.push(FileFailure { path, error }),
            ItemState::Uncertain(error) => outcome.uncertain.push(FileFailure { path, error }),
            ItemState::Active => outcome.uncertain.push(FileFailure {
                path,
                error: worker_error
                    .clone()
                    .unwrap_or_else(|| "File operation did not report an outcome".into()),
            }),
            ItemState::Unstarted => outcome.unstarted.push(path),
        }
    }
    outcome
}
