//! Typed application commands own forward history; filesystem primitives stay
//! reusable by inverses without recursively recording another forward action.
use crate::{
    error::AppError,
    file_history::{self, Action, ForwardEffect, MutationOutcome, MutationReply},
    files::{file_ops, mutation::FileMutationReceipt},
    renderer_owner,
};
use std::{future::Future, path::Path};

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
        Err(AppError::WorkerFailed(_)) => ForwardEffect::Uncertain,
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
    ForwardEffect::Committed(Some(Action::Rename {
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
        |_| ForwardEffect::Committed(None),
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
        |_| ForwardEffect::Committed(None),
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
        |_| ForwardEffect::Committed(None),
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
        |_| ForwardEffect::Committed(None),
    )
    .await
}

#[cfg(test)]
#[path = "../test_support/file_mutation.rs"]
mod tests;
