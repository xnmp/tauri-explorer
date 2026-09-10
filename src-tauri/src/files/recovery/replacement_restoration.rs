//! Decide one restoration step from exact native endpoint observations.
//! The source of the original copy is irrelevant to restoring independent data.
use super::model::{EntryVersion, StagedPayload};
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RestorationStep {
    ParkPublication,
    RestoreOriginal,
    Complete,
    Conflict,
}

pub(super) fn restoration_step(
    original: Option<&EntryVersion>,
    publication: Option<&EntryVersion>,
    target: Option<&EntryVersion>,
    expected_original: &EntryVersion,
    staged: &StagedPayload,
) -> io::Result<RestorationStep> {
    expected_original.validate()?;
    let finalized = staged.published_version()?;
    if expected_original.object == staged.version.object {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Restoration copy and original must be independent objects",
        ));
    }
    let is_copy =
        |entry: Option<&EntryVersion>| entry == Some(&staged.version) || entry == Some(&finalized);
    let private_copy_known = publication.is_none() || is_copy(publication);
    Ok(
        if original == Some(expected_original) && publication.is_none() && is_copy(target) {
            RestorationStep::ParkPublication
        } else if original == Some(expected_original) && target.is_none() && private_copy_known {
            RestorationStep::RestoreOriginal
        } else if original.is_none() && target == Some(expected_original) && private_copy_known {
            RestorationStep::Complete
        } else {
            RestorationStep::Conflict
        },
    )
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_restoration.rs"]
mod tests;
