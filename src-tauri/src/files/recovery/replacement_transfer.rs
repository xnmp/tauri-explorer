//! Exact native displacement and publication for a prepared copy replacement.
//! Phase transitions and lifecycle decisions remain with the recovery executor.

use super::super::{
    model::{DurableIntent, EntryVersion, ObjectId, ReplacementSpec, StagedPayload},
    rename_outcome::{classify, RenamePosition},
};
use super::Root;
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at, version_from_metadata},
        native_directory::Directory,
    },
};
use std::{ffi::OsStr, fs, io, os::unix::fs::PermissionsExt, path::PathBuf};

const ORIGINAL: &str = "original";
const PUBLICATION: &str = "publication";

struct SourceGuard<'a> {
    directory: Directory,
    parent_path: PathBuf,
    name: &'a OsStr,
    expected: &'a EntryVersion,
    parent: ObjectId,
}

impl SourceGuard<'_> {
    fn verify(&self) -> Result<(), AppError> {
        if of_file(&self.directory.file)? != self.parent
            || of_file(&Directory::open(&self.parent_path)?.file)? != self.parent
            || version_at(&self.directory, self.name)? != *self.expected
        {
            return Err(invalid(
                "Recovery copy source or its parent namespace changed",
            ));
        }
        Ok(())
    }
}

struct Transfer<'a> {
    root: &'a Root,
    intent: &'a DurableIntent,
    staged: &'a StagedPayload,
    spec: &'a ReplacementSpec,
    source: Option<SourceGuard<'a>>,
    target_name: &'a OsStr,
}

impl<'a> Transfer<'a> {
    fn new(
        root: &'a Root,
        intent: &'a DurableIntent,
        staged: &'a StagedPayload,
    ) -> Result<Self, AppError> {
        root.verify_copy_evidence(intent, staged)?;
        let spec = intent.operation.replacement()?;

        let source_claim = intent
            .resources
            .iter()
            .find(|resource| resource.path == spec.source)
            .ok_or_else(|| invalid("Recovery copy lacks source authority"))?;
        let parent_path = spec
            .source
            .0
            .parent()
            .ok_or_else(|| invalid("Recovery copy source has no parent"))?
            .to_owned();
        let source_name = spec
            .source
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery copy source has no name"))?;
        let source_directory = Directory::open(&parent_path)?;
        let source_parent = of_file(&source_directory.file)?;
        if source_claim.ancestors.first() != Some(&source_parent)
            || source_claim.object != Some(spec.source_version.object)
        {
            return Err(invalid(
                "Recovery copy source authority no longer matches its parent",
            ));
        }
        Self::with_source(
            root,
            intent,
            staged,
            Some(SourceGuard {
                directory: source_directory,
                parent_path,
                name: source_name,
                expected: &spec.source_version,
                parent: source_parent,
            }),
        )
    }

    /// Retained reapplication is independent of the original source namespace.
    /// Both native versions still derive from the same immutable operation.
    fn with_source(
        root: &'a Root,
        intent: &'a DurableIntent,
        staged: &'a StagedPayload,
        source: Option<SourceGuard<'a>>,
    ) -> Result<Self, AppError> {
        root.verify_copy_evidence(intent, staged)?;
        let spec = intent.operation.replacement()?;
        let target_name = spec
            .target
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery replacement target has no name"))?;
        let transfer = Self {
            root,
            intent,
            staged,
            spec,
            source,
            target_name,
        };
        transfer.verify_authority()?;
        Ok(transfer)
    }

    fn verify_authority(&self) -> Result<(), AppError> {
        self.root.verify_manifest(self.intent)?;
        if let Some(source) = &self.source {
            source.verify()?;
        }
        Ok(())
    }

    fn verify_staged(&self) -> Result<(), AppError> {
        self.verify_authority()?;
        if probe(&self.root.directory, OsStr::new(PUBLICATION))?.as_ref()
            != Some(&self.staged.version)
        {
            return Err(invalid(
                "Recovery staged publication changed before transfer",
            ));
        }
        Ok(())
    }

    fn verify_original(&self) -> Result<(), AppError> {
        if probe(&self.root.directory, OsStr::new(ORIGINAL))?.as_ref() != Some(&self.spec.original)
        {
            return Err(invalid(
                "Recovery retained original changed before publication",
            ));
        }
        Ok(())
    }

    fn verify_displaced(&self) -> Result<(), AppError> {
        self.verify_staged()?;
        self.verify_original()?;
        if probe(&self.root.parent, self.target_name)?.is_some() {
            return Err(uncertain(
                "Recovery displacement destination changed during durability",
            ));
        }
        Ok(())
    }

    fn verify_publication(
        &self,
        position: RenamePosition,
        version: &EntryVersion,
    ) -> Result<(), AppError> {
        self.verify_authority()?;
        self.verify_original()?;
        if classify(
            probe(&self.root.directory, OsStr::new(PUBLICATION))?.as_ref(),
            probe(&self.root.parent, self.target_name)?.as_ref(),
            version,
        ) != position
        {
            return Err(uncertain("Recovery publication endpoints changed"));
        }
        Ok(())
    }

    fn retain_publication_directory(
        &self,
        position: RenamePosition,
        finalized: &EntryVersion,
    ) -> Result<Directory, AppError> {
        let (parent, name) = if position == RenamePosition::Unmoved {
            (&self.root.directory, OsStr::new(PUBLICATION))
        } else {
            (&self.root.parent, self.target_name)
        };
        let directory = match parent.open_existing(name) {
            Ok(directory) => directory,
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    && position == RenamePosition::Moved
                    && *finalized != self.staged.version =>
            {
                // A restarted process has lost the readable handle retained
                // before finalization. Reacquire this inode without read access;
                // the temporary mode is exactly the already-recorded staged
                // version, so interruption remains recognizable on the next try.
                let pinned = parent.open_for_permissions(name)?;
                if version_from_metadata(&pinned.metadata()?)? != *finalized {
                    return Err(invalid(
                        "Recovery finalized directory changed before reopening",
                    ));
                }
                self.verify_publication(position, finalized)?;
                pinned.set_mode(self.staged.version.mode & 0o7777)?;
                if version_from_metadata(&pinned.metadata()?)? != self.staged.version {
                    return Err(uncertain(
                        "Recovery directory permission preparation changed its version",
                    ));
                }
                self.verify_publication(position, &self.staged.version)?;
                pinned.open_readable()?
            }
            Err(error) => return Err(error.into()),
        };
        let observed = version_from_metadata(&directory.metadata()?)?;
        if observed != self.staged.version && observed != *finalized {
            return Err(invalid(
                "Recovery publication directory changed before finalization",
            ));
        }
        self.verify_publication(position, &observed)?;
        Ok(directory)
    }
}

impl Root {
    pub(in crate::files::recovery) fn displace_copy(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<(), AppError> {
        self.displace_copy_with(intent, staged, || Ok(()))
    }

    fn displace_copy_with(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        after_rename: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let transfer = Transfer::new(self, intent, staged)?;
        self.displace_transfer(&transfer, after_rename)
    }

    fn displace_transfer(
        &self,
        transfer: &Transfer<'_>,
        after_rename: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        transfer.verify_staged()?;
        let before = classify(
            probe(&self.parent, transfer.target_name)?.as_ref(),
            probe(&self.directory, OsStr::new(ORIGINAL))?.as_ref(),
            &transfer.spec.original,
        );
        if before == RenamePosition::Conflict {
            return Err(invalid(
                "Recovery displacement endpoints differ from durable evidence",
            ));
        }
        let result = if before == RenamePosition::Unmoved {
            self.parent
                .rename_to(transfer.target_name, &self.directory, OsStr::new(ORIGINAL))
                .map_err(AppError::from)
                .and_then(|()| after_rename())
        } else {
            Ok(())
        };
        let position = classify(
            probe(&self.parent, transfer.target_name)?.as_ref(),
            probe(&self.directory, OsStr::new(ORIGINAL))?.as_ref(),
            &transfer.spec.original,
        );
        match position {
            RenamePosition::Moved => {
                self.directory.sync()?;
                self.parent.sync()?;
                transfer.verify_displaced()
            }
            RenamePosition::Unmoved => match result {
                Err(error) => Err(error),
                Ok(()) => Err(uncertain(
                    "Recovery displacement reported success without moving the original",
                )),
            },
            RenamePosition::Conflict => Err(uncertain(
                "Recovery displacement has conflicting source or destination evidence",
            )),
        }
    }

    pub(in crate::files::recovery) fn publish_copy(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<EntryVersion, AppError> {
        self.publish_copy_with(intent, staged, || Ok(()))
    }

    fn publish_copy_with(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        after_rename: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<EntryVersion, AppError> {
        self.publish_copy_with_preparation(intent, staged, after_rename, || Ok(()))
    }

    fn publish_copy_with_preparation(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        after_rename: impl FnOnce() -> Result<(), AppError>,
        after_directory_open: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<EntryVersion, AppError> {
        let transfer = Transfer::new(self, intent, staged)?;
        self.publish_transfer(&transfer, after_rename, after_directory_open)
    }

    fn publish_transfer(
        &self,
        transfer: &Transfer<'_>,
        after_rename: impl FnOnce() -> Result<(), AppError>,
        after_directory_open: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<EntryVersion, AppError> {
        let staged = transfer.staged;
        transfer.verify_original()?;
        let final_version = staged.published_version()?;
        let publication = probe(&self.directory, OsStr::new(PUBLICATION))?;
        let target = probe(&self.parent, transfer.target_name)?;
        let before = publication_position(
            publication.as_ref(),
            target.as_ref(),
            &staged.version,
            &final_version,
        );
        if before == RenamePosition::Conflict {
            return Err(invalid(
                "Recovery publication endpoints differ from durable evidence",
            ));
        }

        let retained_directory = if staged.final_mode.is_some() {
            let directory = transfer.retain_publication_directory(before, &final_version)?;
            after_directory_open()?;
            Some(directory)
        } else {
            None
        };

        let observed = if let Some(directory) = retained_directory.as_ref() {
            version_from_metadata(&directory.metadata()?)?
        } else {
            staged.version.clone()
        };
        transfer.verify_publication(before, &observed)?;
        let result = if before == RenamePosition::Unmoved {
            self.directory
                .rename_to(OsStr::new(PUBLICATION), &self.parent, transfer.target_name)
                .map_err(AppError::from)
                .and_then(|()| after_rename())
        } else {
            Ok(())
        };
        let position = publication_position(
            probe(&self.directory, OsStr::new(PUBLICATION))?.as_ref(),
            probe(&self.parent, transfer.target_name)?.as_ref(),
            &staged.version,
            &final_version,
        );
        match position {
            RenamePosition::Unmoved => {
                return match result {
                    Err(error) => Err(error),
                    Ok(()) => Err(uncertain(
                        "Recovery publication reported success without moving the payload",
                    )),
                };
            }
            RenamePosition::Conflict => {
                return Err(uncertain(
                    "Recovery publication has conflicting source or destination evidence",
                ));
            }
            RenamePosition::Moved => {}
        }

        // A rename is one effect, mode finalization is another. Authority can
        // change between them even when the exact payload reached its target.
        transfer.verify_authority()?;
        transfer.verify_original()?;
        if let Some(directory) = retained_directory.as_ref() {
            let observed = version_from_metadata(&directory.metadata()?)?;
            if probe(&self.directory, OsStr::new(PUBLICATION))?.is_some()
                || probe(&self.parent, transfer.target_name)?.as_ref() != Some(&observed)
            {
                return Err(uncertain(
                    "Recovery publication namespace changed before finalization",
                ));
            }
            if observed == staged.version {
                directory.file.set_permissions(fs::Permissions::from_mode(
                    staged
                        .final_mode
                        .expect("a retained publication directory has a final mode"),
                ))?;
            } else if observed != final_version {
                return Err(uncertain(
                    "Recovery publication directory changed before finalization",
                ));
            }
            directory.sync()?;
            if version_from_metadata(&directory.metadata()?)? != final_version {
                return Err(uncertain(
                    "Recovery publication directory did not retain its final mode",
                ));
            }
        }
        self.directory.sync()?;
        self.parent.sync()?;
        transfer.verify_authority()?;
        transfer.verify_original()?;
        if probe(&self.directory, OsStr::new(PUBLICATION))?.is_some()
            || probe(&self.parent, transfer.target_name)?.as_ref() != Some(&final_version)
        {
            return Err(uncertain(
                "Recovery publication changed before durability completed",
            ));
        }
        if let Some(directory) = retained_directory {
            if version_from_metadata(&directory.metadata()?)? != final_version {
                return Err(uncertain(
                    "Recovery publication retained handle changed before completion",
                ));
            }
        }
        Ok(final_version)
    }
}

impl Root {
    pub(in crate::files::recovery) fn reapply_copy_with(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        mut after_effect: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<EntryVersion, AppError> {
        use super::super::replacement_reapplication::{reapplication_step, ReapplicationStep};
        let transfer = Transfer::with_source(self, intent, staged, None)?;
        let step = reapplication_step(
            probe(&self.directory, OsStr::new(ORIGINAL))?.as_ref(),
            probe(&self.directory, OsStr::new(PUBLICATION))?.as_ref(),
            probe(&self.parent, transfer.target_name)?.as_ref(),
            &transfer.spec.original,
            staged,
        )?;
        match step {
            ReapplicationStep::ParkOriginal => {
                self.displace_transfer(&transfer, || after_effect("park-rename"))?;
                after_effect("park")?;
            }
            ReapplicationStep::PublishCopy | ReapplicationStep::Complete => {}
            ReapplicationStep::Conflict => {
                return Err(invalid(
                    "Recovery reapplication endpoints differ from durable evidence",
                ))
            }
        }
        let result =
            self.publish_transfer(&transfer, || after_effect("publish-rename"), || Ok(()))?;
        after_effect("publish")?;
        Ok(result)
    }
}

fn publication_position(
    source: Option<&EntryVersion>,
    target: Option<&EntryVersion>,
    staged: &EntryVersion,
    finalized: &EntryVersion,
) -> RenamePosition {
    let staged_position = classify(source, target, staged);
    if staged_position == RenamePosition::Conflict && source.is_none() && target == Some(finalized)
    {
        RenamePosition::Moved
    } else {
        staged_position
    }
}

fn probe(directory: &Directory, name: &OsStr) -> Result<Option<EntryVersion>, AppError> {
    match version_at(directory, name) {
        Ok(version) => Ok(Some(version)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

fn uncertain(message: &str) -> AppError {
    AppError::MutationUncertain(message.into())
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_transfer.rs"]
mod tests;

#[cfg(test)]
use crate::files::recovery::model::OperationSpec;
