//! Typed application commands own forward history; filesystem primitives stay
//! reusable by inverses without recursively recording another forward action.
use crate::{
    error::AppError,
    file_history::{self, Action, ForwardEffect, MutationOutcome, MutationReply, Recovery},
    files::{batch::FileBatchOutcome, file_ops, mutation::FileMutationReceipt},
    renderer_owner,
};
use std::{future::Future, path::Path};

fn delete_effect(outcome: &FileBatchOutcome, permanent: bool) -> ForwardEffect {
    if outcome.succeeded.is_empty() && outcome.uncertain.is_empty() {
        return ForwardEffect::Unchanged;
    }
    if permanent {
        return ForwardEffect::Changed(None);
    }
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut indices = std::collections::HashMap::new();
    for path in &outcome.succeeded {
        if !outcome.artifacts.contains_key(path) {
            continue;
        }
        let directory = parent(path)
            .into_iter()
            .next()
            .expect("validated deletion parent");
        let index = *indices.entry(directory.clone()).or_insert_with(|| {
            groups.push((directory, Vec::new()));
            groups.len() - 1
        });
        groups[index].1.push(path.clone());
    }
    let mut actions: Vec<_> = groups
        .into_iter()
        .map(|(parent_dir, paths)| {
            let artifacts = paths
                .iter()
                .map(|path| (path.clone(), outcome.artifacts[path].clone()))
                .collect();
            Action::Delete {
                paths,
                parent_dir,
                recovery: Recovery::Restore(std::sync::Arc::new(artifacts)),
            }
        })
        .collect();
    let inverse = match actions.len() {
        0 => None,
        1 => actions.pop(),
        _ => Some(Action::Batch {
            actions,
            label: "Delete".into(),
        }),
    };
    ForwardEffect::Changed(inverse)
}

fn delete_outcome(
    mut result: FileBatchOutcome,
    permanent: bool,
) -> MutationOutcome<FileBatchOutcome> {
    if !permanent && !cfg!(target_os = "macos") {
        for path in &result.succeeded {
            if !result.artifacts.contains_key(path)
                && !result.warnings.iter().any(|warning| &warning.path == path)
            {
                result.warnings.push(crate::files::batch::FileFailure {
                    path: path.clone(),
                    error: "Deletion completed, but no exact recovery identity is available; Undo is unavailable for this item".into(),
                });
            }
        }
    }
    let effect = delete_effect(&result, permanent);
    let mut affected: Vec<_> = result
        .affected_paths()
        .flat_map(|path| parent(path))
        .collect();
    affected.sort_unstable();
    affected.dedup();
    MutationOutcome {
        result: Ok(result),
        effect,
        affected,
    }
}

#[tauri::command]
pub(crate) async fn delete_entries(
    window: tauri::Window,
    session_id: String,
    paths: Vec<String>,
    permanent: bool,
) -> Result<MutationReply<FileBatchOutcome>, AppError> {
    use crate::files::{batch, trash};
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let plan = batch::BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    let mut directories: Vec<_> = plan.paths.iter().flat_map(|path| parent(path)).collect();
    directories.sort_unstable();
    directories.dedup();
    file_history::run_forward(owner, false, directories, async move {
        let result = if permanent {
            Ok(batch::run(plan, file_ops::delete_path).await)
        } else {
            trash::run_batch(plan).await
        };
        match result {
            Ok(result) => delete_outcome(result, permanent),
            // Dedicated-worker setup is explicitly nonmutating. Once an item
            // starts, the external ledger returns its per-path outcome instead.
            Err(error) => MutationOutcome {
                result: Err(error),
                effect: ForwardEffect::Unchanged,
                affected: Vec::new(),
            },
        }
    })
    .await
}

fn parent(path: &str) -> Vec<String> {
    Path::new(path)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .into_iter()
        .collect()
}

async fn outcome(
    directories: Vec<String>,
    work: impl Future<Output = Result<FileMutationReceipt, AppError>>,
    classify: impl FnOnce(&FileMutationReceipt) -> ForwardEffect,
) -> MutationOutcome<FileMutationReceipt> {
    let result = work.await;
    let effect = match &result {
        Ok(receipt) => classify(receipt),
        Err(AppError::WorkerFailed(_) | AppError::MutationUncertain(_)) => {
            ForwardEffect::Changed(None)
        }
        Err(_) => ForwardEffect::Unchanged,
    };
    let affected = if matches!(effect, ForwardEffect::Unchanged) {
        Vec::new()
    } else {
        directories
    };
    MutationOutcome {
        result,
        effect,
        affected,
    }
}

fn rename_effect(
    receipt: &FileMutationReceipt,
    old_name: String,
    new_name: String,
) -> ForwardEffect {
    // Only classify after the filesystem operation succeeds: equal names do
    // not excuse a missing source, invalid name, or inaccessible directory.
    if old_name == new_name {
        return ForwardEffect::Unchanged;
    }
    ForwardEffect::Changed(Some(Action::Rename {
        path: receipt.path.clone(),
        old_name,
        new_name,
    }))
}

async fn entry(
    window: tauri::Window,
    session_id: String,
    directories: Vec<String>,
    work: impl Future<Output = Result<FileMutationReceipt, AppError>> + Send + 'static,
    classify: impl FnOnce(&FileMutationReceipt) -> ForwardEffect + Send + 'static,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    file_history::run_forward(
        owner,
        false,
        directories.clone(),
        outcome(directories, work, classify),
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_directory(
    window: tauri::Window,
    session_id: String,
    parent_path: String,
    name: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    entry(
        window,
        session_id,
        vec![parent_path.clone()],
        file_ops::create_directory(parent_path, name),
        |_| ForwardEffect::Changed(None),
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_empty_file(
    window: tauri::Window,
    session_id: String,
    parent_path: String,
    name: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    entry(
        window,
        session_id,
        vec![parent_path.clone()],
        file_ops::create_empty_file(parent_path, name),
        |_| ForwardEffect::Changed(None),
    )
    .await
}

#[tauri::command]
pub(crate) async fn rename_entry(
    window: tauri::Window,
    session_id: String,
    path: String,
    new_name: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let old_name = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let requested_name = new_name.clone();
    entry(
        window,
        session_id,
        parent(&path),
        file_ops::rename_entry(path, new_name),
        move |receipt| rename_effect(receipt, old_name, requested_name),
    )
    .await
}

#[tauri::command]
pub(crate) async fn write_text_file(
    window: tauri::Window,
    session_id: String,
    path: String,
    content: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    entry(
        window,
        session_id,
        parent(&path),
        file_ops::write_text_file(path, content),
        |_| ForwardEffect::Changed(None),
    )
    .await
}

#[tauri::command]
pub(crate) async fn create_symlink(
    window: tauri::Window,
    session_id: String,
    target_path: String,
    link_path: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    entry(
        window,
        session_id,
        parent(&link_path),
        file_ops::create_symlink(target_path, link_path),
        |_| ForwardEffect::Changed(None),
    )
    .await
}

#[cfg(test)]
#[path = "../test_support/file_mutation.rs"]
mod tests;
