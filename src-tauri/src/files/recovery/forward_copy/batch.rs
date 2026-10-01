//! One execution boundary retains ordered receipts across later child failure.
use super::{plan, PreparedCopy};
use crate::{
    diagnostics::{panic_message, Warnings},
    error::AppError,
    files::{
        anchored_copy::CopyProgress,
        batch::receipts::{ItemState, Receipts},
        mutation::FileMutationReceipt,
    },
};
use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
};

pub(in crate::files::recovery) struct BatchExecution {
    pub items: Vec<CopyItem>,
    pub physical_refresh: Vec<String>,
    pub warnings: Warnings,
}

pub(in crate::files::recovery) struct CopyItem {
    pub target: String,
    pub state: ItemState<FileMutationReceipt, AppError>,
}

impl BatchExecution {
    pub(in crate::files::recovery) fn warn(&mut self, message: String) {
        self.warnings.push(message);
    }

    pub(in crate::files::recovery) fn into_single(self) -> Result<FileMutationReceipt, AppError> {
        assert_eq!(
            self.items.len(),
            1,
            "singleton adapter requires exactly one item"
        );
        let warnings = self.warnings.into_vec();
        let warning = (!warnings.is_empty()).then(|| warnings.join("\n"));
        let item = self.items.into_iter().next().expect("one item");
        let result = match item.state {
            ItemState::Succeeded(mut receipt) => {
                if let Some(replacement) = &mut receipt.replacement {
                    replacement.warning = warning;
                }
                return Ok(receipt);
            }
            ItemState::Failed(error) | ItemState::Uncertain(error) => error,
            ItemState::Unstarted | ItemState::Active => AppError::WorkerFailed(format!(
                "Copy did not report an outcome for {}",
                item.target,
            )),
        };
        match warning {
            Some(warning) => {
                let message = format!("{result}\n{warning}");
                Err(match result {
                    AppError::WorkerFailed(_) => AppError::WorkerFailed(message),
                    AppError::MutationUncertain(_) => AppError::MutationUncertain(message),
                    _ => AppError::Other(message),
                })
            }
            None => Err(result),
        }
    }
}

pub(in crate::files::recovery) fn execute_batch(
    copies: Vec<PreparedCopy>,
    progress: &mut impl CopyProgress,
) -> BatchExecution {
    // Paths are projections, never execution authority. Capture before any
    // child is consumed so both success and unwind can invalidate aliases.
    let targets: Vec<_> = copies
        .iter()
        .map(|copy| copy.presentation.to_string_lossy().into_owned())
        .collect();
    let physical: Vec<_> = copies.iter().map(PreparedCopy::physical_refresh).collect();
    let receipts = Receipts::new(copies.len());
    let mut pending: VecDeque<_> = copies.into();
    let result = catch_unwind(AssertUnwindSafe(|| {
        for index in 0..targets.len() {
            receipts.begin(index);
            let copy = pending
                .pop_front()
                .expect("one pending child per admitted index");
            let result = copy.execute(progress);
            let stop = result.is_err();
            let state = match result {
                Ok(receipt) => ItemState::Succeeded(receipt),
                Err(error @ (AppError::WorkerFailed(_) | AppError::MutationUncertain(_))) => {
                    ItemState::Uncertain(error)
                }
                Err(error) => ItemState::Failed(error),
            };
            // No formatting, probing, callbacks or allocation between a returned
            // receipt and its preallocated slot. Never replay an acknowledged child.
            receipts.complete(index, state);
            if stop {
                break;
            }
        }
    }));
    // Active child owners have unwound. Explicitly retire the unstarted suffix
    // before inventory/refresh publication; cleanup warnings cannot erase receipts.
    let warning = plan::retire_unstarted(pending.into_iter().map(|copy| copy.reservation));
    let mut physical_refresh = Vec::new();
    let items = targets
        .into_iter()
        .zip(receipts.take())
        .zip(physical)
        .map(|((target, state), physical)| {
            if !matches!(state, ItemState::Unstarted) {
                physical_refresh.extend(physical);
            }
            let state = match state {
                ItemState::Active => ItemState::Uncertain(AppError::WorkerFailed(match &result {
                    Err(payload) => panic_message(payload.as_ref()),
                    Ok(()) => "Copy worker did not report an outcome".into(),
                })),
                state => state,
            };
            CopyItem { target, state }
        })
        .collect();
    physical_refresh.sort_unstable();
    physical_refresh.dedup();
    BatchExecution {
        items,
        physical_refresh,
        warnings: warning.into_iter().collect(),
    }
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_copy_batch.rs"]
mod tests;
