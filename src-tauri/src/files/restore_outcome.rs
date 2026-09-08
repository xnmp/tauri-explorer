//! Pure interpretation of Windows Shell move completion evidence.
//!
//! `HRESULT::is_ok` is deliberately insufficient here: the Shell copy engine
//! uses non-negative status codes for skipped and deferred work. Only an exact
//! `S_OK` item callback with an actual destination proves this restore.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ItemCompletion {
    Missing,
    Duplicate,
    InvalidSource(String),
    One {
        hresult: i32,
        actual_path: Result<PathBuf, String>,
        requested_matches_actual: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompletionEvidence {
    pub(crate) item: ItemCompletion,
    /// A `PreMoveItem` callback requested overwrite/merge semantics that this
    /// adapter vetoed. It remains uncertain because recursive child callbacks
    /// can arrive after an earlier child has already moved.
    pub(crate) rejected_transfer_flags: Option<u32>,
    pub(crate) perform_error: Option<String>,
    pub(crate) aborted: Result<bool, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestoreOutcome {
    Exact,
    Uncertain(String),
}

fn format_hresult(value: i32) -> String {
    format!("0x{:08X}", value as u32)
}

fn operation_context(evidence: &CompletionEvidence) -> String {
    let perform = evidence.perform_error.as_deref().map_or_else(
        || "PerformOperations returned success".to_string(),
        |error| format!("PerformOperations returned {error}"),
    );
    let aborted = match &evidence.aborted {
        Ok(true) => "GetAnyOperationsAborted reported an abort".to_string(),
        Ok(false) => "GetAnyOperationsAborted reported no abort".to_string(),
        Err(error) => format!("GetAnyOperationsAborted failed: {error}"),
    };
    format!("{perform}; {aborted}")
}

pub(crate) fn classify_completion(evidence: CompletionEvidence) -> RestoreOutcome {
    if let Some(flags) = evidence.rejected_transfer_flags {
        return RestoreOutcome::Uncertain(format!(
            "Windows attempted unsafe overwrite or directory-merge semantics while restoring from trash (transfer flags 0x{flags:08X}); {}",
            operation_context(&evidence)
        ));
    }
    match &evidence.item {
        ItemCompletion::One {
            hresult: 0,
            actual_path: Ok(_),
            requested_matches_actual: true,
        } => RestoreOutcome::Exact,
        ItemCompletion::One {
            hresult: 0,
            actual_path: Ok(actual),
            requested_matches_actual: false,
        } => RestoreOutcome::Uncertain(format!(
            "Windows restored the item to {} instead of the requested path; inspect this location before continuing",
            actual.display()
        )),
        ItemCompletion::One {
            hresult: item_hresult,
            actual_path,
            ..
        } => {
            let item = match actual_path {
                Ok(actual) => format!(
                    "the item callback returned {} with destination {}",
                    format_hresult(*item_hresult),
                    actual.display()
                ),
                Err(error) => format!(
                    "the item callback returned {} without an authoritative destination: {error}",
                    format_hresult(*item_hresult)
                ),
            };
            RestoreOutcome::Uncertain(format!(
                "Windows could not confirm the trash restore: {item}; {}",
                operation_context(&evidence)
            ))
        }
        ItemCompletion::Missing => RestoreOutcome::Uncertain(format!(
            "Windows did not report an item completion after starting the trash restore; {}",
            operation_context(&evidence)
        )),
        ItemCompletion::Duplicate => RestoreOutcome::Uncertain(format!(
            "Windows reported more than one completion for a single trash item; {}",
            operation_context(&evidence)
        )),
        ItemCompletion::InvalidSource(error) => RestoreOutcome::Uncertain(format!(
            "Windows did not report completion for the queued Recycle Bin item: {error}; {}",
            operation_context(&evidence)
        )),
    }
}

#[cfg(test)]
#[path = "../../test_support/windows_restore.rs"]
mod tests;
