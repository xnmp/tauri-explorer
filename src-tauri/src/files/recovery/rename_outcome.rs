//! Rename results come from both observed endpoints, never the syscall status alone.
use super::model::EntryVersion;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RenamePosition {
    Unmoved,
    Moved,
    Conflict,
}

pub(super) fn classify(
    source: Option<&EntryVersion>,
    target: Option<&EntryVersion>,
    expected: &EntryVersion,
) -> RenamePosition {
    match (source, target) {
        (Some(source), None) if source == expected => RenamePosition::Unmoved,
        (None, Some(target)) if target == expected => RenamePosition::Moved,
        _ => RenamePosition::Conflict,
    }
}

#[cfg(test)]
#[path = "../../../test_support/recovery_rename_outcome.rs"]
mod tests;
