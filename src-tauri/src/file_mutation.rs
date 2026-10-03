//! Typed application commands own forward history; filesystem primitives stay
//! reusable by inverses without recursively recording another forward action.
use crate::{
    error::AppError,
    file_history::{self, Action, ForwardEffect, MutationOutcome, MutationReply, Recovery},
    files::{
        admission, batch::FileBatchOutcome, entry_plan::EntryPlan, mutation::FileMutationReceipt,
    },
    platform, renderer_owner,
};
use std::path::Path;
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
    if !permanent && platform::TRASH_RESTORE_SUPPORTED {
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
    let runtime = admission::runtime(&window)?;
    let mut directories: Vec<_> = plan.paths.iter().flat_map(|path| parent(path)).collect();
    directories.sort_unstable();
    directories.dedup();
    file_history::run_forward(owner, false, directories, async move {
        match trash::delete(plan, &runtime, permanent).await {
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
        restore_supported: platform::TRASH_RESTORE_SUPPORTED,
        recovery: Recovery::Capture,
        publication: Some(publication.clone()),
    })
}

/// One native history reservation covers the complete ordered selection,
/// including conflict pauses and the successfully completed prefix.
#[tauri::command]
pub(crate) async fn copy_entries(
    window: tauri::Window,
    session_id: String,
    request: crate::files::copy_session::SessionRequest,
    events: tauri::ipc::Channel<crate::files::copy_session::Event>,
) -> Result<MutationReply<crate::files::copy_session::Outcome>, AppError> {
    use crate::files::copy_session::{self, NativeWork, Registration, Request};
    let copy_session::SessionRequest {
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
        runtime: admission::runtime(&window)?,
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
                    restore_supported: platform::TRASH_RESTORE_SUPPORTED,
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

/// One native history reservation covers the complete ordered relocation,
/// including conflict pauses and the successfully completed prefix. A
/// cancelled session still records the prefix, so Undo remains available for
/// exactly the items that moved.
#[tauri::command]
pub(crate) async fn move_entries(
    window: tauri::Window,
    session_id: String,
    request: crate::files::copy_session::SessionRequest,
    events: tauri::ipc::Channel<crate::files::copy_session::Event>,
) -> Result<MutationReply<crate::files::copy_session::Outcome>, AppError> {
    use crate::files::{
        copy_session::{self, Registration, Request},
        move_session::MoveWork,
    };
    let copy_session::SessionRequest {
        request_id,
        sources,
        dest_dir,
        job_id,
        shared,
    } = request;
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let request = Request::new(sources.clone(), dest_dir.clone())?;
    let registration = Registration::new(request_id, owner.clone())?;
    let work = MoveWork {
        job_id,
        runtime: admission::runtime(&window)?,
    };
    // A relocation changes two directories per item. The source parents are
    // only known per item, so the reservation names the destination and the
    // outcome extends the refreshed set with every committed source parent.
    let mut directories = vec![dest_dir.clone()];
    directories.extend(sources.iter().flat_map(|source| parent(source)));
    directories.sort_unstable();
    directories.dedup();
    file_history::run_forward(owner, shared, directories, async move {
        let result = copy_session::run(request, registration.control.clone(), work, move |event| {
            events.send(event).is_ok()
        })
        .await;
        let outcome = move_session_outcome(result, &sources, dest_dir);
        drop(registration);
        outcome
    })
    .await
}

/// Position is the item identity: `sources[index]` is the requested spelling
/// of `items[index]`, including repeated paths.
pub(crate) fn move_session_outcome(
    result: crate::files::copy_session::Outcome,
    sources: &[String],
    destination: String,
) -> MutationOutcome<crate::files::copy_session::Outcome> {
    use crate::files::copy_session::ItemOutcome;
    let mut actions = Vec::new();
    let mut affected = result.refresh_dirs.clone();
    // An item that found its entry already at the destination changed nothing.
    // A session of only such items must not advance history at all, because a
    // forward entry — even one with no inverse — discards the redo stack.
    let mut changed = result
        .items
        .iter()
        .any(|item| matches!(item, ItemOutcome::Uncertain { .. }));
    for (index, item) in result.items.iter().enumerate() {
        let ItemOutcome::Succeeded { receipt } = item else {
            continue;
        };
        if receipt.unchanged {
            continue;
        }
        changed = true;
        affected.extend(parent(&receipt.path));
        let Some(source) = sources.get(index) else {
            continue;
        };
        affected.extend(parent(source));
        if let Some(relocation) = &receipt.relocation {
            // The durable record IS the inverse. Never pair it with a
            // path-only action: replaying one can destroy the last copy.
            actions.push(Action::Replacement {
                path: receipt.path.clone(),
                recovery: Some(relocation.history.clone()),
            });
        } else {
            // Without the durable journal there is no record to name, so this
            // is the pre-existing renderer inverse moved into native history
            // rather than a new hazard. `move_session.rs` refuses to produce a
            // receipt whose source removal did not finish, so the only paths
            // reaching here are complete relocations.
            actions.push(Action::Move {
                source_path: source.clone(),
                dest_path: receipt.path.clone(),
                original_dir: parent(source).pop().unwrap_or_default(),
            });
        }
    }
    if changed {
        affected.push(destination);
    }
    affected.sort_unstable();
    affected.dedup();
    let effect = if changed {
        let inverse = match actions.len() {
            0 => None,
            1 => actions.pop(),
            _ => Some(Action::Batch {
                label: format!("Move {} items", actions.len()),
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
        affected: if changed { affected } else { Vec::new() },
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

async fn entry_outcome(
    plan: EntryPlan,
    runtime: &admission::Runtime,
) -> MutationOutcome<FileMutationReceipt> {
    settle_entry(crate::files::entry_execution::execute(plan, runtime).await)
}

fn settle_entry(
    outcome: crate::files::entry_execution::Outcome,
) -> MutationOutcome<FileMutationReceipt> {
    let changed = admission::changed(&outcome.completion.result);
    let mut warning = outcome.completion.warning;
    let effect = if outcome.completion.result.is_ok() {
        match outcome.rename {
            Some((old, new)) if old == new => ForwardEffect::Unchanged,
            Some((old, new)) => match outcome.target.to_str() {
                Some(path) => rename_effect(path.to_owned(), old, new),
                None => {
                    let mut warnings: crate::diagnostics::Warnings = warning.into_iter().collect();
                    warnings.push("Rename completed, but its native path cannot be represented in history; Undo is unavailable");
                    warning = Some(warnings.into_vec().join("\n"));
                    ForwardEffect::Changed(None)
                }
            },
            None => ForwardEffect::Changed(None),
        }
    } else if changed {
        ForwardEffect::Changed(None)
    } else {
        ForwardEffect::Unchanged
    };
    let affected = if matches!(effect, ForwardEffect::Changed(_)) {
        outcome.affected
    } else {
        Vec::new()
    };
    MutationOutcome {
        result: outcome.completion.result,
        effect,
        warning,
        affected,
    }
}

async fn entry(
    window: tauri::Window,
    session_id: String,
    plan: EntryPlan,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let directories = plan.affected_dirs();
    let runtime = admission::runtime(&window)?;
    file_history::run_forward(owner, false, directories, async move {
        entry_outcome(plan, &runtime).await
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_image_crop(
    window: tauri::Window,
    session_id: String,
    request: crate::files::image_crop::SaveRequest,
) -> Result<MutationReply<FileMutationReceipt>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let plan = crate::files::image_crop::SavePlan::new(request)?;
    let trace_metadata = plan.trace_metadata();
    let trace_window = window.clone();
    let runtime = admission::runtime(&window)?;
    let directories = plan.affected_dirs();
    file_history::run_forward(owner, false, directories, async move {
        let mut outcome = crate::files::image_crop::execute(plan, &runtime).await;
        if let Ok(receipt) = &outcome.completion.result {
            let output_path = receipt.path.clone();
            let output_digest = outcome
                .output_digest
                .take()
                .expect("confirmed crop carries output digest");
            let recorded = tauri::async_runtime::spawn_blocking(move || {
                crate::trace::record_crop(trace_metadata, &output_path, &output_digest)
            })
            .await;
            match recorded {
                Ok(Ok(())) => {
                    use tauri::Emitter;
                    let _ = trace_window
                        .app_handle()
                        .emit("trace:changed", &receipt.path);
                }
                failure => {
                    let detail = match failure {
                        Ok(Err(error)) => error.to_string(),
                        Err(error) => error.to_string(),
                        Ok(Ok(())) => unreachable!(),
                    };
                    let warning =
                        format!("Image saved, but Trace metadata could not be recorded: {detail}");
                    log::warn!("{warning}");
                    outcome.completion.warning = Some(match outcome.completion.warning.take() {
                        Some(previous) => format!("{previous}\n{warning}"),
                        None => warning,
                    });
                }
            }
        }
        let effect = match &outcome.completion.result {
            Ok(receipt) => ForwardEffect::Changed(copy_inverse(receipt)),
            Err(_) if admission::changed(&outcome.completion.result) => {
                ForwardEffect::Changed(None)
            }
            Err(_) => ForwardEffect::Unchanged,
        };
        let affected = if matches!(effect, ForwardEffect::Changed(_)) {
            outcome.affected
        } else {
            Vec::new()
        };
        MutationOutcome {
            result: outcome.completion.result,
            warning: outcome.completion.warning,
            effect,
            affected,
        }
    })
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
