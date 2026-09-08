//! Exact restoration of a retained replacement original.
//! Selection of this recovery action and phase persistence remain external.

use super::super::{
    model::{DurableIntent, EntryVersion, ReplacementSpec, StagedPayload},
    rename_outcome::{classify, RenamePosition},
    replacement_restoration::{restoration_step, RestorationStep},
};
use super::Root;
use crate::{
    error::AppError,
    files::{
        file_identity::{version_at, version_from_metadata},
        native_directory::Directory,
    },
};
use std::{ffi::OsStr, io};

const ORIGINAL: &str = "original";
const PUBLICATION: &str = "publication";

trait RestoreHooks {
    fn after_directory_mode(&mut self) -> Result<(), AppError> {
        Ok(())
    }

    fn after_copy_parked(&mut self) -> Result<(), AppError> {
        Ok(())
    }

    fn after_original_restored(&mut self) -> Result<(), AppError> {
        Ok(())
    }
}

struct NoHooks;
impl RestoreHooks for NoHooks {}

#[cfg(test)]
struct CallbackHooks<F>(F);

#[cfg(test)]
impl<F> RestoreHooks for CallbackHooks<F>
where
    F: FnMut(&'static str) -> Result<(), AppError>,
{
    fn after_directory_mode(&mut self) -> Result<(), AppError> {
        (self.0)("permissions")
    }

    fn after_copy_parked(&mut self) -> Result<(), AppError> {
        (self.0)("park")
    }

    fn after_original_restored(&mut self) -> Result<(), AppError> {
        (self.0)("restore")
    }
}

struct Restoration<'a> {
    root: &'a Root,
    intent: &'a DurableIntent,
    staged: &'a StagedPayload,
    spec: &'a ReplacementSpec,
    target_name: &'a OsStr,
}

impl<'a> Restoration<'a> {
    fn new(
        root: &'a Root,
        intent: &'a DurableIntent,
        staged: &'a StagedPayload,
    ) -> Result<Self, AppError> {
        root.verify_copy_evidence(intent, staged)?;
        let spec = intent.operation.replacement()?;
        let target_name = spec
            .target
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery replacement target has no name"))?;
        let restoration = Self {
            root,
            intent,
            staged,
            spec,
            target_name,
        };
        restoration.verify_authority()?;
        Ok(restoration)
    }

    fn verify_authority(&self) -> Result<(), AppError> {
        self.root.verify_manifest(self.intent)
    }

    fn step(&self) -> Result<RestorationStep, AppError> {
        Ok(restoration_step(
            probe(&self.root.directory, OsStr::new(ORIGINAL))?.as_ref(),
            probe(&self.root.directory, OsStr::new(PUBLICATION))?.as_ref(),
            probe(&self.root.parent, self.target_name)?.as_ref(),
            &self.spec.original,
            self.staged,
        )?)
    }

    fn verify_step(&self, expected: RestorationStep) -> Result<(), AppError> {
        self.verify_authority()?;
        if self.step()? != expected {
            return Err(uncertain(
                "Recovery restoration endpoints changed before durability completed",
            ));
        }
        Ok(())
    }

    fn park_publication(&self, hooks: &mut impl RestoreHooks) -> Result<(), AppError> {
        self.verify_step(RestorationStep::ParkPublication)?;
        let finalized = self.staged.published_version()?;
        let observed = probe(&self.root.parent, self.target_name)?
            .ok_or_else(|| invalid("Recovery publication disappeared before parking"))?;
        let retained_directory = if self.staged.final_mode.is_some() {
            let directory = self.root.parent.open_for_permissions(self.target_name)?;
            if version_from_metadata(&directory.metadata()?)? != observed {
                return Err(invalid(
                    "Recovery publication directory changed while retaining it",
                ));
            }
            Some(directory)
        } else {
            None
        };

        if let Some(directory) = retained_directory.as_ref() {
            if observed == finalized && observed != self.staged.version {
                self.verify_step(RestorationStep::ParkPublication)?;
                let mode = self.staged.version.mode & 0o7777;
                let result = directory.set_mode(mode).map_err(AppError::from);
                let handle = version_from_metadata(&directory.metadata()?)?;
                let named = probe(&self.root.parent, self.target_name)?;
                if handle != self.staged.version || named.as_ref() != Some(&self.staged.version) {
                    return match result {
                        Err(error) if handle == finalized && named.as_ref() == Some(&finalized) => {
                            Err(error)
                        }
                        _ => Err(uncertain(
                            "Recovery publication directory mode has conflicting evidence",
                        )),
                    };
                }
                directory.open_readable()?.sync()?;
                self.verify_step(RestorationStep::ParkPublication)?;
                if version_from_metadata(&directory.metadata()?)? != self.staged.version {
                    return Err(uncertain(
                        "Recovery publication directory changed after mode durability",
                    ));
                }
                hooks.after_directory_mode()?;
            } else if observed != self.staged.version {
                return Err(invalid(
                    "Recovery publication directory is neither staged nor finalized",
                ));
            }
        }

        self.verify_step(RestorationStep::ParkPublication)?;
        let result = self
            .root
            .parent
            .rename_to(
                self.target_name,
                &self.root.directory,
                OsStr::new(PUBLICATION),
            )
            .map_err(AppError::from);
        match classify(
            probe(&self.root.parent, self.target_name)?.as_ref(),
            probe(&self.root.directory, OsStr::new(PUBLICATION))?.as_ref(),
            &self.staged.version,
        ) {
            RenamePosition::Moved => {
                self.root.parent.sync()?;
                self.root.directory.sync()?;
                self.verify_step(RestorationStep::RestoreOriginal)?;
                hooks.after_copy_parked()
            }
            RenamePosition::Unmoved => match result {
                Err(error) => Err(error),
                Ok(()) => Err(uncertain(
                    "Recovery copy parking reported success without moving the copy",
                )),
            },
            RenamePosition::Conflict => Err(uncertain(
                "Recovery copy parking has conflicting source or destination evidence",
            )),
        }
    }

    fn restore_original(&self, hooks: &mut impl RestoreHooks) -> Result<(), AppError> {
        self.verify_step(RestorationStep::RestoreOriginal)?;
        let result = self
            .root
            .directory
            .rename_to(OsStr::new(ORIGINAL), &self.root.parent, self.target_name)
            .map_err(AppError::from);
        match classify(
            probe(&self.root.directory, OsStr::new(ORIGINAL))?.as_ref(),
            probe(&self.root.parent, self.target_name)?.as_ref(),
            &self.spec.original,
        ) {
            RenamePosition::Moved => {
                self.root.directory.sync()?;
                self.root.parent.sync()?;
                self.verify_step(RestorationStep::Complete)?;
                hooks.after_original_restored()
            }
            RenamePosition::Unmoved => match result {
                Err(error) => Err(error),
                Ok(()) => Err(uncertain(
                    "Recovery original restoration reported success without moving the original",
                )),
            },
            RenamePosition::Conflict => Err(uncertain(
                "Recovery original restoration has conflicting source or destination evidence",
            )),
        }
    }
}

impl Root {
    /// Read-only native observation for a claimed operation. Resolution must
    /// repeat these checks; this result is a UI offer, never cached authority.
    pub(in crate::files::recovery) fn inspect_restoration(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<RestorationStep, AppError> {
        let restoration = Restoration::new(self, intent, staged)?;
        let step = restoration.step()?;
        restoration.verify_authority()?;
        Ok(step)
    }

    pub(in crate::files::recovery) fn restore_copy(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
    ) -> Result<EntryVersion, AppError> {
        self.restore_copy_with(intent, staged, &mut NoHooks)
    }

    #[cfg(test)]
    pub(in crate::files::recovery) fn restore_copy_with_hook(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        after_effect: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<EntryVersion, AppError> {
        self.restore_copy_with(intent, staged, &mut CallbackHooks(after_effect))
    }

    fn restore_copy_with(
        &self,
        intent: &DurableIntent,
        staged: &StagedPayload,
        hooks: &mut impl RestoreHooks,
    ) -> Result<EntryVersion, AppError> {
        let restoration = Restoration::new(self, intent, staged)?;
        match restoration.step()? {
            RestorationStep::ParkPublication => restoration.park_publication(hooks)?,
            RestorationStep::RestoreOriginal | RestorationStep::Complete => {}
            RestorationStep::Conflict => {
                return Err(invalid(
                    "Recovery restoration endpoints differ from durable evidence",
                ));
            }
        }
        match restoration.step()? {
            RestorationStep::RestoreOriginal => restoration.restore_original(hooks)?,
            RestorationStep::Complete => restoration.verify_step(RestorationStep::Complete)?,
            RestorationStep::ParkPublication | RestorationStep::Conflict => {
                return Err(uncertain(
                    "Recovery restoration did not reach a completable endpoint state",
                ));
            }
        }
        // A prior process may have completed the rename but exited before its
        // namespace barriers. Repeat both barriers, then reject hook-time races.
        self.directory.sync()?;
        self.parent.sync()?;
        restoration.verify_step(RestorationStep::Complete)?;
        Ok(restoration.spec.original.clone())
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
#[path = "../../../test_support/recovery_replacement_restore.rs"]
mod tests;

#[cfg(test)]
use crate::files::recovery::model::OperationSpec;
