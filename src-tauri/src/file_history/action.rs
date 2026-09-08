//! Admission policy and projections for recorded file actions.
use super::model::{Action, Recovery};
use std::{collections::BTreeSet, path::Path};

fn unc(path: &str) -> bool {
    crate::files::is_network_share(Path::new(path))
}

/// Cap both recursive shape and retained allocation before history takes
/// ownership. Recoverability comes from the host at admission, never the caller.
#[cfg(test)]
pub fn prepare(action: Action, trash_restore: bool) -> Result<Option<Action>, String> {
    let action = prepare_with_origin(action, trash_restore, false)?;
    check_budget(action)
}

fn check_budget(action: Option<Action>) -> Result<Option<Action>, String> {
    if action
        .as_ref()
        .is_some_and(|action| super::model::entry_bytes(action) > super::model::MAX_BYTES)
    {
        return Err("File history action exceeds its memory budget".into());
    }
    Ok(action)
}

pub(super) fn prepare_forward(
    action: Action,
    trash_restore: bool,
) -> Result<super::retention::Retained, String> {
    Ok(match prepare_with_origin(action, trash_restore, false)? {
        Some(action) => super::retention::retain(
            action,
            super::model::Direction::Undo,
            super::model::MAX_BYTES,
        ),
        None => super::retention::Retained {
            action: None,
            warning: None,
        },
    })
}

fn prepare_with_origin(
    action: Action,
    trash_restore: bool,
    renderer: bool,
) -> Result<Option<Action>, String> {
    fn validate(
        action: &Action,
        depth: usize,
        nodes: &mut usize,
        renderer: bool,
    ) -> Result<(), String> {
        *nodes += 1;
        if depth > 64 || *nodes > 100_000 {
            return Err("File history action is too large".into());
        }
        let path = |path: &str| -> Result<(), String> {
            if path.is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
                Err("File history requires absolute paths without NUL bytes".into())
            } else {
                Ok(())
            }
        };
        let name = |name: &str| -> Result<(), String> {
            if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
                Err("Invalid file history entry name".into())
            } else {
                Ok(())
            }
        };
        match action {
            Action::Rename {
                path: target,
                old_name,
                new_name,
            } => {
                path(target)?;
                name(old_name)?;
                name(new_name)?;
            }
            Action::Move {
                source_path,
                dest_path,
                original_dir,
            } => {
                path(source_path)?;
                path(dest_path)?;
                path(original_dir)?;
            }
            Action::Copy {
                copied_path,
                parent_dir,
                ..
            } => {
                path(copied_path)?;
                path(parent_dir)?;
            }
            Action::Delete {
                paths,
                parent_dir,
                recovery,
            } => {
                if renderer {
                    return Err(
                        "Deletion history must be recorded by the native file operation".into(),
                    );
                }
                *nodes += paths.len();
                if *nodes > 100_000 {
                    return Err("File history action is too large".into());
                }
                path(parent_dir)?;
                for item in paths {
                    path(item)?;
                }
                if let Recovery::Restore(artifacts) = recovery {
                    let unique = paths.iter().collect::<BTreeSet<_>>();
                    if unique.len() != artifacts.len()
                        || paths.iter().any(|path| !artifacts.contains_key(path))
                    {
                        return Err(
                            "Delete history paths do not match their recovery artifacts".into()
                        );
                    }
                }
            }
            Action::Batch { actions, .. } => {
                for action in actions {
                    validate(action, depth + 1, nodes, renderer)?;
                }
            }
        }
        Ok(())
    }
    fn normalize(action: Action, trash_restore: bool) -> Option<Action> {
        match action {
            Action::Copy {
                copied_path,
                parent_dir,
                recovery,
                ..
            } => {
                let restore_supported = trash_restore && !unc(&copied_path);
                Some(Action::Copy {
                    copied_path,
                    parent_dir,
                    restore_supported,
                    recovery,
                })
            }
            Action::Delete {
                paths,
                parent_dir,
                recovery,
            } => {
                let paths: Vec<_> = paths
                    .into_iter()
                    .filter(|path| trash_restore && !unc(path))
                    .collect();
                let recovery = recovery.subset(&paths);
                (!paths.is_empty()).then_some(Action::Delete {
                    paths,
                    parent_dir,
                    recovery,
                })
            }
            Action::Batch { actions, label } => {
                let actions: Vec<_> = actions
                    .into_iter()
                    .filter_map(|action| normalize(action, trash_restore))
                    .collect();
                (!actions.is_empty()).then_some(Action::Batch { actions, label })
            }
            action => Some(action),
        }
    }
    validate(&action, 0, &mut 0, renderer)?;
    Ok(normalize(action, trash_restore))
}

/// Renderer input can describe newly copied/moved entries, but only native
/// deletion completion can mint a restorable Delete action.
pub fn prepare_renderer(action: Action, trash_restore: bool) -> Result<Option<Action>, String> {
    check_budget(prepare_with_origin(action, trash_restore, true)?)
}

pub fn affected_dirs(action: &Action) -> Vec<String> {
    fn collect(action: &Action, dirs: &mut BTreeSet<String>) {
        let parent = |path: &str| {
            Path::new(path)
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
        };
        match action {
            Action::Rename { path, .. } => {
                if let Some(path) = parent(path) {
                    dirs.insert(path);
                }
            }
            Action::Move {
                source_path,
                dest_path,
                ..
            } => {
                dirs.extend(parent(source_path));
                dirs.extend(parent(dest_path));
            }
            Action::Copy { copied_path, .. } => {
                dirs.extend(parent(copied_path));
            }
            Action::Delete { paths, .. } => {
                for path in paths {
                    dirs.extend(parent(path));
                }
            }
            Action::Batch { actions, .. } => {
                for action in actions {
                    collect(action, dirs);
                }
            }
        }
    }
    let mut dirs = BTreeSet::new();
    collect(action, &mut dirs);
    dirs.into_iter().collect()
}

#[cfg(test)]
#[path = "../../test_support/file_history_action.rs"]
mod tests;
