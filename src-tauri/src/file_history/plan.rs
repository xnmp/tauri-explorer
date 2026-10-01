//! Pure inverse requests, fixed before worker execution. Recovery admission can
//! inspect this same owned plan instead of independently reconstructing paths.
use super::model::{Action, Direction, Recovery};
use crate::files::trash_artifact::RestoreRequest;
use std::{collections::BTreeSet, path::Path};

pub(super) struct Prepared {
    direction: Direction,
    root: Plan,
}

impl Prepared {
    pub(super) fn new(action: Action, direction: Direction) -> Self {
        Self {
            direction,
            root: Plan::new(action, direction),
        }
    }

    pub(super) fn into_parts(self) -> (Direction, Plan) {
        (self.direction, self.root)
    }

    /// Capture before handing the plan to a worker, so a panic cannot lose the
    /// exact directional paths that may need reconciliation.
    pub(super) fn affected_dirs(&self) -> Vec<String> {
        fn collect(plan: &Plan, directories: &mut BTreeSet<String>) {
            let mut add_parent = |path: &str| {
                if let Ok(parent) = parent(path) {
                    directories.insert(parent);
                }
            };
            match plan {
                Plan::Leaf {
                    request: Ok(request),
                    ..
                } => match request {
                    Request::Rename { path, .. } => add_parent(path),
                    Request::Move { path, destination } => {
                        add_parent(path);
                        directories.insert(destination.clone());
                    }
                    Request::Replacement { history, .. } => {
                        directories.extend(history.refresh_dirs.iter().cloned())
                    }
                    Request::Trash(paths) => paths.iter().for_each(|path| add_parent(path)),
                    Request::TrashPublication(publication) => {
                        if let Some(path) = publication.path.parent() {
                            directories.insert(path.to_string_lossy().into_owned());
                        }
                    }
                    Request::Restore(requests) => requests
                        .iter()
                        .for_each(|request| add_parent(&request.path)),
                },
                Plan::Leaf {
                    request: Err(_), ..
                } => {}
                Plan::Batch { children, .. } => children
                    .iter()
                    .for_each(|child| collect(child, directories)),
            }
        }
        let mut directories = BTreeSet::new();
        collect(&self.root, &mut directories);
        directories.into_iter().collect()
    }
}

pub(super) enum Request {
    Replacement {
        history: crate::files::recovery::ReplacementHistory,
        direction: crate::files::recovery::ReplacementDirection,
    },
    Rename {
        path: String,
        name: String,
    },
    Move {
        path: String,
        destination: String,
    },
    Trash(Vec<String>),
    TrashPublication(std::sync::Arc<crate::files::mutation::PublishedEntry>),
    Restore(Vec<RestoreRequest>),
}

pub(super) enum Plan {
    Leaf {
        action: Action,
        request: Result<Request, String>,
    },
    Batch {
        children: Vec<Plan>,
        label: String,
    },
}

impl Plan {
    /// Stored history has already passed depth, node and byte admission limits.
    /// Keep an invalid leaf in place so partial execution stops at the same
    /// position and preserves the original unfinished action ordering.
    pub(super) fn new(action: Action, direction: Direction) -> Self {
        match action {
            Action::Batch { actions, label } => Self::Batch {
                children: actions
                    .into_iter()
                    .map(|action| Self::new(action, direction))
                    .collect(),
                label,
            },
            action => {
                let request = request(&action, direction);
                Self::Leaf { action, request }
            }
        }
    }

    pub(super) fn into_action(self) -> Action {
        match self {
            Self::Leaf { action, .. } => action,
            Self::Batch { children, label } => Action::Batch {
                actions: children.into_iter().map(Self::into_action).collect(),
                label,
            },
        }
    }
}

fn request(action: &Action, direction: Direction) -> Result<Request, String> {
    match action {
        Action::Rename {
            path,
            old_name,
            new_name,
        } => {
            let (path, name) = match direction {
                Direction::Undo => (path.clone(), old_name.clone()),
                Direction::Redo => (join(&parent(path)?, old_name), new_name.clone()),
            };
            Ok(Request::Rename { path, name })
        }
        Action::Move {
            source_path,
            dest_path,
            ..
        } => {
            // The recorded effect paths are authoritative. `original_dir` is
            // redundant legacy metadata, also ignored by refresh projection.
            let original_dir = parent(source_path)?;
            let (path, destination) = match direction {
                Direction::Undo => (dest_path.clone(), original_dir),
                Direction::Redo => (
                    join(&original_dir, &file_name(dest_path)?),
                    parent(dest_path)?,
                ),
            };
            Ok(Request::Move { path, destination })
        }
        Action::Replacement { recovery, .. } => Ok(Request::Replacement {
            history: recovery
                .clone()
                .ok_or("Replacement history lacks native authority")?,
            direction: match direction {
                Direction::Undo => crate::files::recovery::ReplacementDirection::Restore,
                Direction::Redo => crate::files::recovery::ReplacementDirection::Reapply,
            },
        }),
        Action::Copy {
            copied_path,
            restore_supported,
            recovery,
            publication,
            ..
        } => match (direction, recovery) {
            (Direction::Undo, Recovery::Capture) => Ok(match publication {
                Some(publication) => Request::TrashPublication(publication.clone()),
                None => Request::Trash(vec![copied_path.clone()]),
            }),
            (Direction::Redo, Recovery::Restore(artifact)) if *restore_supported => {
                Ok(Request::Restore(vec![RestoreRequest {
                    path: copied_path.clone(),
                    artifact: artifact.clone(),
                }]))
            }
            (Direction::Redo, _) if !restore_supported => {
                Err("Cannot redo copy because restoring this item is unsupported".into())
            }
            _ => Err("Copy history has no exact recovery identity for this direction".into()),
        },
        Action::Delete {
            paths, recovery, ..
        } => match (direction, recovery) {
            (Direction::Undo, Recovery::Restore(artifacts)) => paths
                .iter()
                .map(|path| {
                    artifacts
                        .get(path)
                        .map(|artifact| RestoreRequest {
                            path: path.clone(),
                            artifact: artifact.clone(),
                        })
                        .ok_or_else(|| format!("No exact recovery identity for {path}"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Request::Restore),
            (Direction::Redo, Recovery::Capture) => Ok(Request::Trash(paths.clone())),
            _ => Err("Delete history has no exact recovery identity for this direction".into()),
        },
        Action::Batch { .. } => unreachable!("batches are planned recursively"),
    }
}

fn parent(path: &str) -> Result<String, String> {
    Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid file history path: {path}"))
}

fn file_name(path: &str) -> Result<String, String> {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid file history path: {path}"))
}

fn join(parent: &str, name: &str) -> String {
    Path::new(parent).join(name).to_string_lossy().into_owned()
}
