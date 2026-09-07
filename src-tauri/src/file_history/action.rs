//! Admission policy and projections for recorded file actions.
use super::model::Action;
use std::{collections::BTreeSet, path::Path};

fn unc(path: &str) -> bool {
    path.starts_with("//") || path.starts_with("\\\\")
}

/// Cap both recursive shape and retained allocation before history takes
/// ownership. Recoverability comes from the host at admission, never the caller.
pub fn prepare(action: Action, trash_restore: bool) -> Result<Option<Action>, String> {
    fn validate(action: &Action, depth: usize, nodes: &mut usize) -> Result<(), String> {
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
            Action::Delete { paths, parent_dir } => {
                *nodes += paths.len();
                if *nodes > 100_000 {
                    return Err("File history action is too large".into());
                }
                path(parent_dir)?;
                for item in paths {
                    path(item)?;
                }
            }
            Action::Batch { actions, .. } => {
                for action in actions {
                    validate(action, depth + 1, nodes)?;
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
                ..
            } => {
                let restore_supported = trash_restore && !unc(&copied_path);
                Some(Action::Copy {
                    copied_path,
                    parent_dir,
                    restore_supported,
                })
            }
            Action::Delete { paths, parent_dir } => {
                let paths: Vec<_> = paths
                    .into_iter()
                    .filter(|path| trash_restore && !unc(path))
                    .collect();
                (!paths.is_empty()).then_some(Action::Delete { paths, parent_dir })
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
    validate(&action, 0, &mut 0)?;
    if action.retained_bytes() > 32 * 1024 * 1024 {
        return Err("File history action exceeds its memory budget".into());
    }
    Ok(normalize(action, trash_restore))
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
