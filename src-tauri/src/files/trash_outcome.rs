//! Pure interpretation of Windows Shell deletion completion evidence.
//!
//! The Shell copy engine uses non-negative HRESULTs for skipped or deferred
//! work. Only an exact `S_OK` callback proves a committed deletion.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeletedArtifact {
    Missing,
    ParsingName(Vec<u16>),
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeleteItemCompletion {
    Missing,
    Duplicate,
    InvalidSource(String),
    One {
        hresult: i32,
        artifact: DeletedArtifact,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeleteCompletionEvidence {
    pub(crate) item: DeleteItemCompletion,
    /// A descendant, connected item, or otherwise non-matching callback means
    /// a skipped/vetoed root cannot prove that the operation had no effects.
    /// An exact `S_OK` root artifact still proves that root's recovery identity.
    pub(crate) other_activity: bool,
    /// Exact-root `PreDeleteItem` omitted recycle semantics, so the sink
    /// returned `E_ABORT` before that item could be deleted.
    pub(crate) rejected_transfer_flags: Option<u32>,
    pub(crate) perform_error: Option<String>,
    pub(crate) aborted: Result<bool, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeleteOutcome {
    Recycled(Vec<u16>),
    /// The source is known to be gone, but the app cannot offer an inverse.
    CommittedWithoutArtifact(String),
    Unchanged(String),
    Uncertain(String),
}

const S_OK: i32 = 0;
const COPYENGINE_S_USER_IGNORED: i32 = 0x0027_0005;

fn format_hresult(value: i32) -> String {
    format!("0x{:08X}", value as u32)
}

fn operation_context(evidence: &DeleteCompletionEvidence) -> String {
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

pub(crate) fn classify_delete(evidence: DeleteCompletionEvidence) -> DeleteOutcome {
    if let Some(flags) = evidence.rejected_transfer_flags {
        return match &evidence.item {
            DeleteItemCompletion::Missing if !evidence.other_activity => DeleteOutcome::Unchanged(format!(
                "Windows did not offer Recycle Bin semantics for this item (transfer flags 0x{flags:08X}); the deletion was canceled before it began"
            )),
            _ => DeleteOutcome::Uncertain(format!(
                "Windows reported deletion activity after recycle-only semantics were rejected (transfer flags 0x{flags:08X}); {}",
                operation_context(&evidence)
            )),
        };
    }
    match &evidence.item {
        DeleteItemCompletion::One {
            hresult: S_OK,
            artifact: DeletedArtifact::ParsingName(name),
        } if !name.is_empty() => DeleteOutcome::Recycled(name.clone()),
        DeleteItemCompletion::One {
            hresult: S_OK,
            artifact: DeletedArtifact::Missing,
        } => DeleteOutcome::CommittedWithoutArtifact(
            "Deletion completed, but Windows did not provide a recoverable Recycle Bin item; Undo is unavailable"
                .into(),
        ),
        DeleteItemCompletion::One {
            hresult: S_OK,
            artifact: DeletedArtifact::Unavailable(error),
        } => DeleteOutcome::CommittedWithoutArtifact(format!(
            "Windows recycled the item, but its exact Recycle Bin identity could not be retained: {error}"
        )),
        DeleteItemCompletion::One {
            hresult: COPYENGINE_S_USER_IGNORED,
            artifact: DeletedArtifact::Missing,
        } if !evidence.other_activity => DeleteOutcome::Unchanged(
            "Windows skipped the item without deleting it (COPYENGINE_S_USER_IGNORED)".into(),
        ),
        DeleteItemCompletion::One {
            hresult: COPYENGINE_S_USER_IGNORED,
            artifact: DeletedArtifact::Missing,
        } => DeleteOutcome::Uncertain(format!(
            "Windows skipped the root item but reported deletion activity for another Shell item; {}",
            operation_context(&evidence)
        )),
        DeleteItemCompletion::One { hresult, artifact } => {
            let artifact = match artifact {
                DeletedArtifact::Missing => "without a Recycle Bin item".to_string(),
                DeletedArtifact::ParsingName(_) => {
                    "while also returning a Recycle Bin item".to_string()
                }
                DeletedArtifact::Unavailable(error) => {
                    format!("with an unreadable Recycle Bin item: {error}")
                }
            };
            DeleteOutcome::Uncertain(format!(
                "Windows returned deletion status {} {artifact}; {}",
                format_hresult(*hresult),
                operation_context(&evidence)
            ))
        }
        DeleteItemCompletion::Missing => DeleteOutcome::Uncertain(format!(
            "Windows did not report completion after starting the deletion; {}",
            operation_context(&evidence)
        )),
        DeleteItemCompletion::Duplicate => DeleteOutcome::Uncertain(format!(
            "Windows reported more than one completion for a single deleted item; {}",
            operation_context(&evidence)
        )),
        DeleteItemCompletion::InvalidSource(error) => DeleteOutcome::Uncertain(format!(
            "Windows did not report completion for the queued item: {error}; {}",
            operation_context(&evidence)
        )),
    }
}

#[cfg(test)]
#[path = "../../test_support/trash_outcome.rs"]
mod tests;
