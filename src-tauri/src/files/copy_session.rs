//! One ordered native request owns its pauses, cancellation and confirmed
//! effects. Filesystem workers never wait for a renderer response.
//!
//! This is the session engine, not the copy effect: `Work` is the only
//! operation-specific seam, and `files::move_session` supplies the second
//! implementation. Ordering, conflict pauses, cancellation, the bounded
//! diagnostic budget and the completed prefix are shared by construction, so
//! a move can never acquire a weaker cancellation or retention contract than
//! a copy by drifting apart from it.
mod control;
mod model;
mod worker;
pub(crate) use control::{lookup, Control, Registration};
pub(crate) use model::{
    Choice, Conflict, Decision, Event, ItemOutcome, Outcome, Request, SessionRequest,
};
pub(crate) use worker::NativeWork;

use super::{
    batch::receipts::{ItemState, Receipts},
    mutation::FileMutationReceipt,
    WorkerCompletion,
};
use crate::{diagnostics::Warnings, error::AppError};
use std::{
    collections::BTreeSet,
    future::Future,
    sync::{Arc, Mutex},
};

pub(crate) struct Inspection {
    pub source: String,
    pub destination: String,
    pub presentation: String,
    pub conflict: Option<Conflict>,
    pub bytes: u64,
    #[cfg(target_os = "linux")]
    pub observation: Option<super::mutation::CopyObservation>,
}

pub(crate) trait Work: Send + 'static {
    fn inspect(
        &self,
        source: String,
        destination: String,
        remaining: usize,
    ) -> impl Future<Output = Result<Inspection, AppError>> + Send;
    /// Apply this session's effect to one inspected item.
    fn apply(
        &self,
        inspection: Inspection,
        overwrite: bool,
        control: Arc<Control>,
        progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> impl Future<Output = WorkerCompletion<FileMutationReceipt>> + Send;
}

enum Failure {
    Skipped,
    Failed(String),
    Uncertain(String),
}
struct Success {
    receipt: FileMutationReceipt,
    warning: Option<String>,
}

/// The ledger belongs to the supervisor, outside the async orchestration and
/// all blocking-worker captures. Cancellation never drops an active worker.
pub(crate) async fn run(
    request: Request,
    control: Arc<Control>,
    work: impl Work,
    emit: impl Fn(Event) -> bool + Send + Sync + 'static,
) -> Outcome {
    let receipts = Receipts::<Success, Failure>::new(request.sources.len());
    let emit = Arc::new(emit);
    let writer = receipts.clone();
    let inner_control = control.clone();
    let affected = Arc::new(Mutex::new(BTreeSet::new()));
    let physical_effects = affected.clone();
    let mut task = tauri::async_runtime::spawn(async move {
        if !emit(Event::Ready) {
            inner_control.cancelled.retire();
        }
        let mut global_choice = None;
        let mut diagnostic_budget = 64 * 1024;
        for (index, source) in request.sources.iter().enumerate() {
            if !inner_control.cancelled.active() || !inner_control.renderer.active() {
                break;
            }
            let inspection = work
                .inspect(
                    source.clone(),
                    request.destination.clone(),
                    request.sources.len() - index - 1,
                )
                .await;
            let inspection = match inspection {
                Ok(inspection) => inspection,
                Err(error) => {
                    writer.begin(index);
                    writer.complete(
                        index,
                        ItemState::Failed(Failure::Failed(bounded_error(
                            error,
                            &mut diagnostic_budget,
                        ))),
                    );
                    continue;
                }
            };
            let mut overwrite = false;
            if let Some(conflict) = inspection.conflict.clone() {
                let decision = match global_choice {
                    Some(choice) => Decision {
                        choice,
                        apply_to_all: true,
                    },
                    None => inner_control.decide(index, conflict, emit.as_ref()).await,
                };
                if decision.apply_to_all {
                    global_choice = Some(decision.choice);
                }
                match decision.choice {
                    Choice::Cancel => {
                        inner_control.cancelled.retire();
                        break;
                    }
                    Choice::Skip => {
                        writer.begin(index);
                        writer.complete(index, ItemState::Failed(Failure::Skipped));
                        continue;
                    }
                    Choice::Overwrite => overwrite = true,
                }
            }
            if !inner_control.cancelled.active() || !inner_control.renderer.active() {
                break;
            }
            if !emit(Event::Started {
                item: index,
                total: request.sources.len(),
            }) {
                inner_control.cancelled.retire();
                break;
            }
            physical_effects
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(inspection.destination.clone());
            writer.begin(index);
            let progress_emitter = emit.clone();
            let progress_control = inner_control.clone();
            let progress = Arc::new(move |progress| {
                if !progress_emitter(Event::Progress {
                    item: index,
                    progress,
                }) {
                    progress_control.cancelled.retire();
                }
            });
            let completion = work
                .apply(inspection, overwrite, inner_control.clone(), progress)
                .await;
            let entry = completion
                .result
                .as_ref()
                .ok()
                .and_then(|receipt| receipt.entry.clone());
            let terminal = match completion.result {
                Ok(mut receipt) => {
                    let mut messages = Warnings::default();
                    if let Some(message) = completion.warning {
                        messages.push(message);
                    }
                    if let Some(message) = receipt.warning.take() {
                        messages.push(message);
                    }
                    if let Some(message) = receipt
                        .replacement
                        .as_mut()
                        .and_then(|receipt| receipt.warning.take())
                    {
                        messages.push(message);
                    }
                    let message = messages.into_vec().join("\n");
                    let warning = (!message.is_empty())
                        .then(|| bounded_message(message, &mut diagnostic_budget));
                    ItemState::Succeeded(Success { receipt, warning })
                }
                Err(error @ (AppError::WorkerFailed(_) | AppError::MutationUncertain(_))) => {
                    ItemState::Uncertain(Failure::Uncertain(bounded_error(
                        error,
                        &mut diagnostic_budget,
                    )))
                }
                Err(error) => ItemState::Failed(Failure::Failed(bounded_error(
                    error,
                    &mut diagnostic_budget,
                ))),
            };
            let uncertain = matches!(terminal, ItemState::Uncertain(_));
            writer.complete(index, terminal);
            // Report only after retaining the effect. A broken channel or panic
            // cannot erase the successfully completed prefix.
            if !emit(Event::Completed {
                item: index,
                total: request.sources.len(),
                entry,
            }) {
                inner_control.cancelled.retire();
            }
            if uncertain {
                break;
            }
        }
    });
    let joined = tokio::select! {
        biased;
        _ = control.renderer.retired() => {
            control.cancelled.retire();
            task.await
        }
        result = &mut task => result,
    };
    let mut warnings = Warnings::default();
    if let Err(error) = joined {
        warnings.push(format!(
            "Native session was interrupted; inspect unfinished items before retrying: {error}"
        ));
    }
    let items = receipts
        .take()
        .into_iter()
        .map(|state| match state {
            ItemState::Succeeded(Success { receipt, warning }) => {
                if let Some(warning) = warning {
                    if warning.is_empty() {
                        warnings.push("Additional per-item diagnostics were omitted");
                    } else {
                        warnings.push(warning);
                    }
                }
                if let Some(warning) = receipt
                    .replacement
                    .as_ref()
                    .and_then(|receipt| receipt.warning.as_ref())
                {
                    warnings.push(warning);
                }
                ItemOutcome::Succeeded {
                    receipt: Box::new(receipt),
                }
            }
            ItemState::Failed(Failure::Skipped) => ItemOutcome::Skipped,
            ItemState::Failed(Failure::Failed(error)) => {
                if error.is_empty() {
                    warnings.push("Additional per-item diagnostics were omitted");
                }
                ItemOutcome::Failed { error }
            }
            ItemState::Uncertain(Failure::Uncertain(error)) => {
                if error.is_empty() {
                    warnings.push("Additional per-item diagnostics were omitted");
                }
                ItemOutcome::Uncertain { error }
            }
            ItemState::Unstarted => ItemOutcome::Unstarted,
            _ => ItemOutcome::Uncertain {
                error:
                    "The session was interrupted during execution; inspect the destination before retrying"
                        .into(),
            },
        })
        .collect();
    let refresh_dirs = std::mem::take(&mut *affected.lock().unwrap_or_else(|e| e.into_inner()))
        .into_iter()
        .collect();
    Outcome {
        items,
        cancelled: !control.cancelled.active() || !control.renderer.active(),
        warnings: warnings.into_vec(),
        refresh_dirs,
    }
}

fn bounded_error(error: AppError, budget: &mut usize) -> String {
    bounded_message(error.to_string(), budget)
}

fn bounded_message(error: String, budget: &mut usize) -> String {
    let mut end = error.len().min(4096).min(*budget);
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    *budget -= end;
    error[..end].to_owned()
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/copy_session.rs"]
mod tests;
