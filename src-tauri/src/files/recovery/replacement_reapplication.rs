//! Reapply only the retained independent copy, preserving its original again.
//! Unlike restoration, reapplication cannot proceed without the copied payload.
use super::model::{EntryVersion, StagedPayload};
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReapplicationStep {
    ParkOriginal,
    PublishCopy,
    Complete,
    Conflict,
}

pub(super) fn reapplication_step(
    original: Option<&EntryVersion>,
    publication: Option<&EntryVersion>,
    target: Option<&EntryVersion>,
    expected_original: &EntryVersion,
    staged: &StagedPayload,
) -> io::Result<ReapplicationStep> {
    expected_original.validate()?;
    let finalized = staged.published_version()?;
    if expected_original.object == staged.version.object {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Reapplication requires independent original and copied objects",
        ));
    }
    Ok(
        if original.is_none()
            && publication == Some(&staged.version)
            && target == Some(expected_original)
        {
            ReapplicationStep::ParkOriginal
        } else if original == Some(expected_original)
            && publication == Some(&staged.version)
            && target.is_none()
        {
            ReapplicationStep::PublishCopy
        } else if original == Some(expected_original)
            && publication.is_none()
            && (target == Some(&staged.version) || target == Some(&finalized))
        {
            ReapplicationStep::Complete
        } else {
            ReapplicationStep::Conflict
        },
    )
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_reapplication.rs"]
mod tests;
