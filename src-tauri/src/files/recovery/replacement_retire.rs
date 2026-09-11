//! Identity-checked removal and measurement of one artifact root's contents.
//! Every removal here is authorized by the caller's journaled discard intent;
//! nothing in this file decides *whether* an artifact may be destroyed.

use super::super::{
    model::{DurableIntent, EntryVersion, StagedPayload},
    retention::Retained,
};
use super::Root;
use crate::{
    error::AppError,
    files::{file_identity::version_at, native_directory::Directory},
};
use std::{ffi::OsStr, io};

/// Recovery roots are our own private storage; these bounds exist so a
/// substituted or pathological namespace cannot make cleanup unbounded.
const MAX_DEPTH: usize = 256;
const MAX_ENTRIES: usize = 65_536;

/// What the observed endpoints permit next. Derived from all three positions,
/// never from the recorded phase alone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::files::recovery) enum RetirementStep {
    /// The retained artifact is present and exactly as recorded, and the live
    /// public endpoint independently holds the payload that survives it.
    Remove,
    /// The retained artifact is already gone and the live endpoint is intact:
    /// an interrupted retirement resuming past its removal checkpoint.
    Removed,
    /// Anything else. Every entry is preserved and reported.
    Conflict,
}

impl Root {
    /// Classify the retained artifact, its sibling and the public endpoint.
    pub(in crate::files::recovery) fn retirement_step(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        retained: Retained,
    ) -> Result<RetirementStep, AppError> {
        self.verify_manifest(intent)?;
        let spec = intent.operation.replacement()?;
        let target_name = spec
            .target
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery replacement target has no name"))?;
        let finalized = staged.published_version()?;
        let target = probe(&self.parent, target_name)?;
        let original = probe(
            &self.directory,
            OsStr::new(super::super::retention::ORIGINAL),
        )?;
        let publication = probe(
            &self.directory,
            OsStr::new(super::super::retention::PUBLICATION),
        )?;
        // The copy is recorded either as staged or with its final permissions;
        // both are the same object, and restoration may have parked either.
        let is_copy = |entry: &EntryVersion| *entry == staged.version || *entry == finalized;
        Ok(match retained {
            // A completed overwrite: the copy is public, the original private.
            Retained::Original => match (original, publication, target) {
                (Some(held), None, Some(live)) if held == spec.original && is_copy(&live) => {
                    RetirementStep::Remove
                }
                (None, None, Some(live)) if is_copy(&live) => RetirementStep::Removed,
                _ => RetirementStep::Conflict,
            },
            // A completed restoration: the original is public, the copy private.
            Retained::Publication => match (original, publication, target) {
                (None, Some(held), Some(live)) if is_copy(&held) && live == spec.original => {
                    RetirementStep::Remove
                }
                (None, None, Some(live)) if live == spec.original => RetirementStep::Removed,
                _ => RetirementStep::Conflict,
            },
        })
    }

    /// Does the root still hold exactly one recorded artifact, unmodified?
    /// An interrupted retirement that has removed nothing answers `true`, so a
    /// resumption can refuse when its live counterpart has since disappeared.
    pub(in crate::files::recovery) fn retained_intact(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<bool, AppError> {
        let spec = intent.operation.replacement()?;
        let finalized = staged.published_version()?;
        let original = probe(
            &self.directory,
            OsStr::new(super::super::retention::ORIGINAL),
        )?;
        let publication = probe(
            &self.directory,
            OsStr::new(super::super::retention::PUBLICATION),
        )?;
        Ok(match (original, publication) {
            (Some(held), None) => held == spec.original,
            (None, Some(held)) => held == staged.version || held == finalized,
            _ => false,
        })
    }

    /// Is the recorded source still exactly as captured? A parked copy is only
    /// redundant while an independent live original of its content survives.
    /// Any doubt — including an unreadable parent — answers no.
    ///
    /// A directory source is always doubt: `EntryVersion` is explicitly not a
    /// recursive snapshot, so an unchanged directory version cannot show that
    /// the tree beneath it still holds the payload the parked copy retains.
    /// Directory payloads therefore need an explicit user decision.
    pub(in crate::files::recovery) fn source_intact(&self, intent: &DurableIntent) -> bool {
        let observed = || -> Result<bool, AppError> {
            let spec = intent.operation.replacement()?;
            if spec.source_version.directory {
                return Ok(false);
            }
            let parent = Directory::open(
                spec.source
                    .0
                    .parent()
                    .ok_or_else(|| invalid("Recovery copy source has no parent"))?,
            )?;
            let name = spec
                .source
                .0
                .file_name()
                .ok_or_else(|| invalid("Recovery copy source has no name"))?;
            Ok(probe(&parent, name)?.as_ref() == Some(&spec.source_version))
        };
        observed().unwrap_or(false)
    }

    /// Bounded measurement of the retained artifact. `None` means the artifact
    /// is absent or exceeded the walk bounds; it is never reported as zero.
    pub(in crate::files::recovery) fn measure_retained(
        &self,
        retained: Retained,
    ) -> Result<Option<u64>, AppError> {
        let name = OsStr::new(retained.name());
        if !self.directory.entry_exists(name)? {
            return Ok(None);
        }
        let mut budget = MAX_ENTRIES;
        Ok(measure(&self.directory, name, 0, &mut budget).ok())
    }

    /// Bounded measurement of every entry a root retains. Used for operation
    /// kinds whose artifacts are not one named payload — a durable move keeps
    /// a parked source in one root and a displaced original in another — so
    /// their retained bytes are accounted even before a retirement plan exists.
    pub(in crate::files::recovery) fn measure_all(&self) -> Result<Option<u64>, AppError> {
        let mut budget = MAX_ENTRIES;
        let mut total = 0u64;
        for name in self.directory.names(MAX_ENTRIES)? {
            match measure(&self.directory, &name, 0, &mut budget) {
                Ok(bytes) => total = total.saturating_add(bytes),
                // Over bounds is unknown, never zero.
                Err(_) => return Ok(None),
            }
        }
        Ok(Some(total))
    }

    /// Remove the retained artifact, then every remaining private entry, then
    /// the root itself. Requires a journaled discard intent and a `Remove` or
    /// `Removed` step observed under the same native ownership.
    pub(in crate::files::recovery) fn retire_artifacts(self) -> Result<(), AppError> {
        self.verify_namespace()?;
        let mut budget = MAX_ENTRIES;
        for name in self.directory.names(MAX_ENTRIES)? {
            remove_tree(&self.directory, &name, 0, &mut budget)?;
        }
        self.directory.sync()?;
        // Only the exact retained handle and its named link may be unlinked.
        self.verify_namespace()?;
        self.parent.unlink(&self.name, true)?;
        self.parent.sync()?;
        if self.parent.entry_exists(&self.name)? {
            return Err(invalid(
                "Recovery artifact root reappeared after retirement; evidence is preserved",
            ));
        }
        Ok(())
    }
}

fn probe(directory: &Directory, name: &OsStr) -> Result<Option<EntryVersion>, AppError> {
    match version_at(directory, name) {
        Ok(version) => Ok(Some(version)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Handle-relative recursive removal. `open_existing` refuses to follow a
/// symlink, so a link is always unlinked rather than traversed.
fn remove_tree(
    parent: &Directory,
    name: &OsStr,
    depth: usize,
    budget: &mut usize,
) -> Result<(), AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Recovery artifact exceeds its removal depth limit"));
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| invalid("Recovery artifact exceeds its removal entry limit"))?;
    let stat = match parent.stat(name) {
        Ok(stat) => stat,
        // Removal is idempotent: an entry already gone is a completed step.
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Ok(parent.unlink(name, false)?);
    }
    let directory = parent.open_existing(name)?;
    for child in directory.names(MAX_ENTRIES)? {
        remove_tree(&directory, &child, depth + 1, budget)?;
    }
    directory.sync()?;
    parent.unlink(name, true)?;
    Ok(())
}

fn measure(
    parent: &Directory,
    name: &OsStr,
    depth: usize,
    budget: &mut usize,
) -> Result<u64, AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Recovery artifact exceeds its measurement depth"));
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| invalid("Recovery artifact exceeds its measurement entry limit"))?;
    let stat = parent.stat(name)?;
    let bytes = u64::try_from(stat.st_size).unwrap_or(0);
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Ok(bytes);
    }
    let directory = parent.open_existing(name)?;
    let mut total = bytes;
    for child in directory.names(MAX_ENTRIES)? {
        total = total.saturating_add(measure(&directory, &child, depth + 1, budget)?);
    }
    Ok(total)
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}
