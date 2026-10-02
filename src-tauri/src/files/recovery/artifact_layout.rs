//! Children of a durable operation's private artifact root.
//!
//! These names are part of the on-disk crash-recovery format: a record written
//! by one build is discovered, restored and retired by another, and retirement
//! only removes children it can name. Change them only with a record-format
//! version bump (#867). Tests deliberately spell the literals out, so a change
//! here fails them.

use super::model::EntryVersion;
use crate::{
    error::AppError,
    files::{file_identity::version_at, native_directory::Directory},
};
use std::{ffi::OsStr, io};

/// A displaced destination entry, retained as the exact inverse of an
/// overwriting copy or move.
pub(super) const ORIGINAL: &str = "original";
/// The staged or published payload copy.
pub(super) const PUBLICATION: &str = "publication";
/// A cross-filesystem move source, hidden after its destination was published.
pub(super) const PARKED: &str = "parked";

/// The exact version of one artifact child, or `None` when it is absent.
pub(super) fn probe(directory: &Directory, name: &OsStr) -> Result<Option<EntryVersion>, AppError> {
    match version_at(directory, name) {
        Ok(version) => Ok(Some(version)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
