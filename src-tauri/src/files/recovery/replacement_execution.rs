//! Concrete replacement execution owns its durable operation and native root.
//! Filesystem effects occur only after the corresponding intent checkpoint.
use super::{
    checkpoint::{Effect, Event, Side, Sides},
    coordinator::DurableOperation,
    replacement_artifact::{Anchor, Root},
};
use crate::error::AppError;

pub(super) struct ReplacementExecution {
    pub(super) operation: DurableOperation,
    pub(super) root: Root,
}

impl ReplacementExecution {
    /// Reopen only the checkpoint's recorded root and exact immutable manifest.
    /// Claiming a native owner does not justify replaying an interrupted effect;
    /// each execution method must still reconcile its own recorded phase.
    pub(super) fn reopen(operation: DurableOperation) -> Result<Self, AppError> {
        let identity = operation.state().roots.target.ok_or_else(|| {
            AppError::MutationUncertain("Recovery has no recorded artifact root identity".into())
        })?;
        let root = Anchor::open(operation.intent(), Side::Target)?.open_existing(identity)?;
        root.verify_manifest(operation.intent())?;
        Ok(Self { operation, root })
    }

    pub(super) fn stage_copy(
        &mut self,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<(), AppError> {
        self.operation.advance(Event::Begin(Effect::Stage))?;
        let payload = match self.root.copy_payload(self.operation.intent(), progress) {
            Ok(payload) => payload,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation.advance(Event::Staged(payload))
    }

    pub(super) fn displace_copy(&mut self) -> Result<(), AppError> {
        self.displace_with(|| Ok(()))
    }

    fn displace_with(
        &mut self,
        after_native: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.operation.advance(Event::Begin(Effect::Displace))?;
        let result = self
            .root
            .displace_copy(self.operation.intent(), self.payload()?);
        if let Err(error) = result.and_then(|()| after_native()) {
            return Err(self.retain_failure(error));
        }
        self.operation.advance(Event::Complete(Effect::Displace))
    }

    pub(super) fn publish_copy(&mut self) -> Result<super::model::EntryVersion, AppError> {
        self.publish_with(|_| Ok(()))
    }

    fn publish_with(
        &mut self,
        after_native: impl FnOnce(&super::model::EntryVersion) -> Result<(), AppError>,
    ) -> Result<super::model::EntryVersion, AppError> {
        self.operation.advance(Event::Begin(Effect::Publish))?;
        let result = self
            .root
            .publish_copy(self.operation.intent(), self.payload()?);
        let published = match result {
            Ok(published) => published,
            Err(error) => return Err(self.retain_failure(error)),
        };
        if let Err(error) = after_native(&published) {
            return Err(self.retain_failure(error));
        }
        self.operation.advance(Event::Complete(Effect::Publish))?;
        Ok(published)
    }

    fn payload(&self) -> Result<&super::model::StagedPayload, AppError> {
        self.operation.state().staged.as_ref().ok_or_else(|| {
            AppError::MutationUncertain("Replacement operation lacks its staged payload".into())
        })
    }

    pub(super) fn restore_copy(&mut self) -> Result<super::model::EntryVersion, AppError> {
        self.restore_with(|_| Ok(()))
    }

    fn restore_with(
        &mut self,
        after_native: impl FnOnce(&super::model::EntryVersion) -> Result<(), AppError>,
    ) -> Result<super::model::EntryVersion, AppError> {
        self.operation.advance(Event::Begin(Effect::Restore))?;
        let restored = match self
            .root
            .restore_copy(self.operation.intent(), self.payload()?)
        {
            Ok(restored) => restored,
            Err(error) => return Err(self.retain_failure(error)),
        };
        if let Err(error) = after_native(&restored) {
            return Err(self.retain_failure(error));
        }
        self.operation.advance(Event::Complete(Effect::Restore))?;
        Ok(restored)
    }

    fn retain_failure(&mut self, error: AppError) -> AppError {
        self.operation.retain_failure(error)
    }

    pub(super) fn reapply_copy(&mut self) -> Result<super::model::EntryVersion, AppError> {
        self.reapply_with(|_| Ok(()))
    }

    fn reapply_with(
        &mut self,
        after_effect: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<super::model::EntryVersion, AppError> {
        self.operation.advance(Event::Begin(Effect::Reapply))?;
        let result =
            self.root
                .reapply_copy_with(self.operation.intent(), self.payload()?, after_effect);
        let published = match result {
            Ok(published) => published,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation.advance(Event::Complete(Effect::Reapply))?;
        Ok(published)
    }

    /// A dropped or failed preparation leaves catalog authority and any native
    /// artifacts intact. Neither this executor nor its fields delete on Drop.
    pub(super) fn prepare(operation: DurableOperation) -> Result<Self, AppError> {
        Self::prepare_with(operation, || Ok(()), || Ok(()))
    }

    fn prepare_with(
        mut operation: DurableOperation,
        after_root: impl FnOnce() -> Result<(), AppError>,
        after_manifest: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<Self, AppError> {
        let anchor = Anchor::open(operation.intent(), Side::Target)?;
        operation.advance(Event::Begin(Effect::Root))?;
        let root = anchor.create()?;
        after_root()?;
        operation.advance(Event::Rooted(Sides {
            source: None,
            target: Some(root.identity()),
        }))?;
        operation.advance(Event::Begin(Effect::Manifest))?;
        root.publish_manifest(operation.intent())?;
        after_manifest()?;
        root.verify_namespace()?;
        operation.advance(Event::Complete(Effect::Manifest))?;
        Ok(Self { operation, root })
    }
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_execution.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test_support/recovery_reapplication_execution.rs"]
mod reapplication_tests;
