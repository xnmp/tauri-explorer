//! Typed application commands own forward history; filesystem primitives stay
//! reusable by inverses without recursively recording another forward action.
use crate::{
    error::AppError,
    file_history::{self, Action, ForwardEffect, MutationOutcome, MutationReply, Recovery},
    files::{
        batch::FileBatchOutcome, entry_plan::EntryPlan, file_ops, mutation::FileMutationReceipt,
    },
    renderer_owner,
};
use std::{future::Future, path::Path};
use tauri::Manager;

fn delete_effect(outcome: &FileBatchOutcome, permanent: bool) -> ForwardEffect {
    if outcome.succeeded.is_empty()
        && outcome.uncertain.is_empty()
        && outcome.worker_error.is_none()
    {
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
        warning: None,
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
                warning: None,
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

struct CopyWork {
    app: tauri::AppHandle,
    source: String,
    destination: String,
    overwrite: Option<bool>,
    job_id: Option<u64>,
    #[cfg(target_os = "linux")]
    recovery: (crate::files::recovery::Runtime, std::path::PathBuf),
}

impl CopyWork {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        let source = std::mem::take(&mut self.source);
        let destination = std::mem::take(&mut self.destination);
        #[cfg(target_os = "linux")]
        {
            file_ops::copy_entry_with(
                Some(&self.app),
                source,
                destination,
                self.overwrite,
                self.job_id,
                |source, _, target, progress| {
                    self.recovery.0.copy_overwriting(
                        self.recovery.1.clone(),
                        source,
                        target,
                        None,
                        progress,
                    )
                },
            )
        }
        #[cfg(not(target_os = "linux"))]
        {
            file_ops::copy_entry_impl(
                Some(&self.app),
                source,
                destination,
                self.overwrite,
                self.job_id,
            )
        }
    }
}

async fn copy_outcome(
    directories: Vec<String>,
    completion: crate::files::WorkerCompletion<FileMutationReceipt>,
) -> MutationOutcome<FileMutationReceipt> {
    let mut settled = outcome(
        directories,
        std::future::ready(completion.result),
        |receipt| {
            // Ordinary grouping is still renderer-owned until the batch command is
            // migrated. Replacements already use this native inverse projection.
            ForwardEffect::Changed(
                receipt
                    .replacement
                    .as_ref()
                    .and_then(|_| copy_inverse(receipt)),
            )
        },
    )
    .await;
    let mut warnings: crate::diagnostics::Warnings = completion.warning.into_iter().collect();
    if let Some(warning) = settled
        .result
        .as_ref()
        .ok()
        .and_then(|receipt| receipt.warning.as_ref())
    {
        warnings.push(warning);
    }
    if let Some(warning) = settled
        .result
        .as_ref()
        .ok()
        .and_then(|receipt| receipt.replacement.as_ref())
        .and_then(|replacement| replacement.warning.as_ref())
    {
        warnings.push(warning);
    }
    let warnings = warnings.into_vec();
    settled.warning = (!warnings.is_empty()).then(|| warnings.join("\n"));
    settled
}

/// Derive inverse authority only from the native effect receipt. Ordinary copy
/// keys use its resolved publication path, so alias spellings cannot disagree
/// with the real trash outcome's key during subsequent settlement.
pub(crate) fn copy_inverse(receipt: &FileMutationReceipt) -> Option<Action> {
    if receipt.recovery.is_some() {
        return None;
    }
    if let Some(replacement) = &receipt.replacement {
        return Some(Action::Replacement {
            path: receipt.path.clone(),
            recovery: Some(replacement.history.clone()),
        });
    }
    let publication = receipt.publication.as_ref()?;
    Some(Action::Copy {
        copied_path: publication.path.to_string_lossy().into_owned(),
        parent_dir: publication.path.parent()?.to_string_lossy().into_owned(),
        restore_supported: !cfg!(target_os = "macos"),
        recovery: Recovery::Capture,
        publication: Some(publication.clone()),
    })
}

/// Copy ownership and settlement outlive the requesting renderer. Ordinary copy
/// grouping still belongs to the existing batch caller; durable replacements
/// must never be recorded as ordinary path-only Copy inverses.
#[tauri::command]
pub(crate) async fn copy_entry(
    window: tauri::Window,
    session_id: String,
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
    job_id: Option<u64>,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let directories = vec![dest_dir.clone()];
    let app = window.app_handle().clone();
    #[cfg(target_os = "linux")]
    let recovery = crate::files::recovery::commands::owner(&window)?;
    let refresh = directories.clone();
    file_history::run_forward(owner, false, directories, async move {
        let completion = crate::files::run_blocking_context(
            CopyWork {
                app,
                source,
                destination: dest_dir,
                overwrite,
                job_id,
                #[cfg(target_os = "linux")]
                recovery,
            },
            CopyWork::execute,
        )
        .await;
        copy_outcome(refresh, completion).await
    })
    .await
}

/// One native history reservation covers the complete ordered selection,
/// including conflict pauses and the successfully completed prefix.
#[tauri::command]
pub(crate) async fn copy_entries(
    window: tauri::Window,
    session_id: String,
    request: crate::files::copy_session::CopyRequest,
    events: tauri::ipc::Channel<crate::files::copy_session::Event>,
) -> Result<MutationReply<crate::files::copy_session::Outcome>, AppError> {
    use crate::files::copy_session::{self, NativeWork, Registration, Request};
    let copy_session::CopyRequest {
        request_id,
        sources,
        dest_dir,
        job_id,
        shared,
    } = request;
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let request = Request::new(sources, dest_dir.clone())?;
    let registration = Registration::new(request_id, owner.clone())?;
    let work = NativeWork {
        app: Some(window.app_handle().clone()),
        job_id,
        #[cfg(target_os = "linux")]
        recovery: crate::files::recovery::commands::owner(&window)?,
    };
    file_history::run_forward(owner, shared, vec![dest_dir.clone()], async move {
        let result = copy_session::run(request, registration.control.clone(), work, move |event| {
            events.send(event).is_ok()
        })
        .await;
        let outcome = copy_session_outcome(result, dest_dir);
        drop(registration);
        outcome
    })
    .await
}

pub(crate) fn copy_session_outcome(
    result: crate::files::copy_session::Outcome,
    destination: String,
) -> MutationOutcome<crate::files::copy_session::Outcome> {
    use crate::files::copy_session::ItemOutcome;
    let mut actions = Vec::new();
    let mut affected = result.refresh_dirs.clone();
    if result.changed() {
        affected.push(destination.clone());
    }
    for item in &result.items {
        if let ItemOutcome::Succeeded { receipt } = item {
            affected.extend(parent(&receipt.path));
            if let Some(publication) = &receipt.publication {
                affected.extend(parent(&publication.path.to_string_lossy()));
            }
            if let Some(action) = copy_inverse(receipt) {
                actions.push(action);
            }
            // Retain existing non-Linux ordinary-copy Undo until each native
            // publication adapter is qualified. Never downgrade a replacement.
            #[cfg(not(target_os = "linux"))]
            if receipt.replacement.is_none() && receipt.recovery.is_none() {
                actions.push(Action::Copy {
                    copied_path: receipt.path.clone(),
                    parent_dir: destination.clone(),
                    restore_supported: !cfg!(target_os = "macos"),
                    recovery: Recovery::Capture,
                    publication: None,
                });
            }
        }
    }
    affected.sort_unstable();
    affected.dedup();
    let effect = if result.changed() {
        let inverse = match actions.len() {
            0 => None,
            1 => actions.pop(),
            _ => Some(Action::Batch {
                label: format!("Copy {} items", actions.len()),
                actions,
            }),
        };
        ForwardEffect::Changed(inverse)
    } else {
        ForwardEffect::Unchanged
    };
    MutationOutcome {
        result: Ok(result),
        effect,
        warning: None,
        affected,
    }
}

#[tauri::command]
pub(crate) async fn resolve_copy_conflict(
    window: tauri::Window,
    session_id: String,
    request_id: String,
    item: usize,
    nonce: String,
    decision: crate::files::copy_session::Decision,
) -> Result<(), AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    crate::files::copy_session::lookup(&request_id, &owner)?.resolve(&owner, item, &nonce, decision)
}

#[tauri::command]
pub(crate) async fn cancel_copy_session(
    window: tauri::Window,
    session_id: String,
    request_id: String,
) -> Result<(), AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    crate::files::copy_session::lookup(&request_id, &owner)?.cancel(&owner)
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
        warning: None,
        effect,
        affected,
    }
}

/// Native lifetime and recovery admission precede the filesystem worker. The
/// existing paste/drop callers still group Move inverses until session migration.
#[tauri::command]
pub(crate) async fn move_entry(
    window: tauri::Window,
    session_id: String,
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let plan =
        crate::files::move_plan::MovePlan::new(source, dest_dir, overwrite.unwrap_or(false))?;
    let directories = plan.affected_dirs();
    #[cfg(target_os = "linux")]
    let (runtime, storage) = crate::files::recovery::commands::owner(&window)?;
    file_history::run_forward(owner, false, directories, async move {
        #[cfg(target_os = "linux")]
        let outcome = crate::files::move_execution::execute(plan, runtime, storage).await;
        #[cfg(not(target_os = "linux"))]
        let outcome = crate::files::move_execution::execute_owned(plan, ()).await;
        move_outcome(outcome)
    })
    .await
}

/// The durable record IS the inverse. Never derive a Move inverse from paths:
/// replaying one can destroy the last copy of the user's data.
pub(crate) fn move_inverse(receipt: &FileMutationReceipt) -> Option<Action> {
    if receipt.recovery.is_some() {
        return None;
    }
    let relocation = receipt.relocation.as_ref()?;
    Some(Action::Replacement {
        path: receipt.path.clone(),
        recovery: Some(relocation.history.clone()),
    })
}

fn move_outcome(
    outcome: crate::files::move_execution::Outcome,
) -> MutationOutcome<FileMutationReceipt> {
    let changed = matches!(
        &outcome.completion.result,
        Ok(_) | Err(AppError::MutationUncertain(_) | AppError::WorkerFailed(_))
    );
    let inverse = outcome.completion.result.as_ref().ok().and_then(move_inverse);
    let mut affected = outcome.affected;
    if let Some(receipt) = outcome.completion.result.as_ref().ok() {
        if let Some(relocation) = &receipt.relocation {
            affected.extend(relocation.history.refresh_dirs.iter().cloned());
            affected.sort_unstable();
            affected.dedup();
        }
    }
    let outcome = crate::files::move_execution::Outcome {
        completion: outcome.completion,
        affected,
    };
    MutationOutcome {
        result: outcome.completion.result,
        effect: if changed {
            ForwardEffect::Changed(inverse)
        } else {
            ForwardEffect::Unchanged
        },
        warning: outcome.completion.warning,
        affected: if changed {
            outcome.affected
        } else {
            Vec::new()
        },
    }
}

fn rename_effect(committed_path: String, old_name: String, new_name: String) -> ForwardEffect {
    // Only classify after the filesystem operation succeeds: equal names do
    // not excuse a missing source, invalid name, or inaccessible directory.
    if old_name == new_name {
        return ForwardEffect::Unchanged;
    }
    ForwardEffect::Changed(Some(Action::Rename {
        path: committed_path,
        old_name,
        new_name,
    }))
}

#[cfg(any(test, not(target_os = "linux")))]
async fn entry_outcome(plan: EntryPlan) -> MutationOutcome<FileMutationReceipt> {
    entry_outcome_owned(plan, ()).await
}

async fn entry_outcome_owned<O: Send + 'static>(
    plan: EntryPlan,
    owner: O,
) -> MutationOutcome<FileMutationReceipt> {
    let directories = plan.affected_dirs();
    let committed_path = plan.target().to_string_lossy().into_owned();
    let rename = plan
        .rename_names()
        .map(|(old, new)| (old.to_owned(), new.to_owned()));
    outcome(
        directories,
        file_ops::execute_entry_owned(owner, plan),
        move |_| match rename {
            Some((old, new)) => rename_effect(committed_path, old, new),
            None => ForwardEffect::Changed(None),
        },
    )
    .await
}

#[cfg(target_os = "linux")]
async fn entry_with_recovery(
    plan: EntryPlan,
    runtime: crate::files::recovery::Runtime,
    storage: std::path::PathBuf,
) -> MutationOutcome<FileMutationReceipt> {
    let (plan, admission) = match admit_entry(plan, runtime, storage).await {
        Ok(admitted) => admitted,
        Err(error) => {
            return MutationOutcome {
                result: Err(error),
                effect: ForwardEffect::Unchanged,
                warning: None,
                affected: Vec::new(),
            }
        }
    };
    let outcome = entry_outcome_owned(plan, admission.context()).await;
    settle_entry(outcome, admission).await
}

#[cfg(target_os = "linux")]
async fn admit_entry(
    plan: EntryPlan,
    runtime: crate::files::recovery::Runtime,
    storage: std::path::PathBuf,
) -> Result<(EntryPlan, crate::files::recovery::MutationAdmission), AppError> {
    let admission = runtime.admit(storage, plan.resources()).await?;
    let plan = plan.resolve(admission.paths().map(Path::to_path_buf))?;
    Ok((plan, admission))
}

#[cfg(target_os = "linux")]
async fn settle_entry(
    mut outcome: MutationOutcome<FileMutationReceipt>,
    admission: crate::files::recovery::MutationAdmission,
) -> MutationOutcome<FileMutationReceipt> {
    if let Err(error) = crate::files::run_blocking(move || admission.finish()).await {
        let warning = format!(
            "File operation finished, but its ownership record could not be retired: {error}"
        );
        log::warn!("{warning}");
        outcome.warning = Some(warning);
    }
    outcome
}

async fn entry(
    window: tauri::Window,
    session_id: String,
    plan: EntryPlan,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let directories = plan.affected_dirs();
    #[cfg(target_os = "linux")]
    let work = {
        use tauri::Manager;
        let runtime = window
            .state::<crate::files::recovery::Runtime>()
            .inner()
            .clone();
        let storage = window
            .path()
            .app_local_data_dir()
            .map_err(|error| AppError::Other(error.to_string()))?
            .join("file-recovery");
        entry_with_recovery(plan, runtime, storage)
    };
    #[cfg(not(target_os = "linux"))]
    let work = entry_outcome(plan);
    file_history::run_forward(owner, false, directories, work).await
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
        EntryPlan::create_directory(parent_path, name)?,
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
        EntryPlan::create_empty_file(parent_path, name)?,
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
    entry(window, session_id, EntryPlan::rename(path, new_name)?).await
}

#[tauri::command]
pub(crate) async fn write_text_file(
    window: tauri::Window,
    session_id: String,
    path: String,
    content: String,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    entry(window, session_id, EntryPlan::write_text(path, content)).await
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
        EntryPlan::symlink(target_path, link_path),
    )
    .await
}

#[cfg(test)]
#[path = "../test_support/file_mutation.rs"]
mod tests;
