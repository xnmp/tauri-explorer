//! Concrete replacement execution owns its durable operation and native root.
//! Filesystem effects occur only after the corresponding intent checkpoint.
use super::{
    coordinator::DurableOperation,
    replacement_artifact::{Anchor, Root},
    replacement_transition::ReplacementTransition,
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
        let state = operation.state().replacement()?;
        let identity = state.root.ok_or_else(|| {
            AppError::MutationUncertain("Recovery has no recorded artifact root identity".into())
        })?;
        let root = Anchor::open(operation.intent())?.open_existing(identity)?;
        root.verify_manifest(operation.intent())?;
        Ok(Self { operation, root })
    }

    pub(super) fn stage_copy(
        &mut self,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<(), AppError> {
        self.operation
            .advance(ReplacementTransition::BeginStaging)?;
        let payload = match self.root.copy_payload(self.operation.intent(), progress) {
            Ok(payload) => payload,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation
            .advance(ReplacementTransition::StagingCompleted(payload))
    }

    pub(super) fn displace_copy(&mut self) -> Result<(), AppError> {
        self.displace_with(|| Ok(()))
    }

    fn displace_with(
        &mut self,
        after_native: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.operation
            .advance(ReplacementTransition::BeginDisplacement)?;
        let result = self
            .root
            .displace_copy(self.operation.intent(), self.payload()?);
        if let Err(error) = result.and_then(|()| after_native()) {
            return Err(self.retain_failure(error));
        }
        self.operation
            .advance(ReplacementTransition::DisplacementCompleted)
    }

    pub(super) fn publish_copy(&mut self) -> Result<super::model::EntryVersion, AppError> {
        self.publish_with(|_| Ok(()))
    }

    fn publish_with(
        &mut self,
        after_native: impl FnOnce(&super::model::EntryVersion) -> Result<(), AppError>,
    ) -> Result<super::model::EntryVersion, AppError> {
        self.operation
            .advance(ReplacementTransition::BeginPublication)?;
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
        self.operation
            .advance(ReplacementTransition::PublicationCompleted)?;
        Ok(published)
    }

    fn payload(&self) -> Result<&super::model::StagedPayload, AppError> {
        let state = self.operation.state().replacement()?;
        state.published.as_ref().ok_or_else(|| {
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
        self.operation
            .advance(ReplacementTransition::BeginRestoration)?;
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
        self.operation
            .advance(ReplacementTransition::RestorationCompleted)?;
        Ok(restored)
    }

    fn retain_failure(&mut self, error: AppError) -> AppError {
        let mut message = error.to_string();
        if message.len() > super::model::MAX_ERROR_BYTES {
            let mut end = super::model::MAX_ERROR_BYTES;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        if let Err(persistence) = self
            .operation
            .advance(ReplacementTransition::ReportError(message))
        {
            log::warn!("Could not persist replacement failure: {persistence}");
        }
        error
    }

    pub(super) fn reapply_copy(&mut self) -> Result<super::model::EntryVersion, AppError> {
        self.reapply_with(|_| Ok(()))
    }

    fn reapply_with(
        &mut self,
        after_effect: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<super::model::EntryVersion, AppError> {
        self.operation
            .advance(ReplacementTransition::BeginReapplication)?;
        let result =
            self.root
                .reapply_copy_with(self.operation.intent(), self.payload()?, after_effect);
        let published = match result {
            Ok(published) => published,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation
            .advance(ReplacementTransition::ReapplicationCompleted)?;
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
        let anchor = Anchor::open(operation.intent())?;
        operation.advance(ReplacementTransition::BeginRoot)?;
        let root = anchor.create()?;
        after_root()?;
        operation.advance(ReplacementTransition::RootObserved(root.identity()))?;
        operation.advance(ReplacementTransition::BeginManifest)?;
        root.publish_manifest(operation.intent())?;
        after_manifest()?;
        root.verify_namespace()?;
        operation.advance(ReplacementTransition::ManifestCompleted)?;
        Ok(Self { operation, root })
    }
}

#[cfg(test)]
#[path = "../../../test_support/recovery_replacement_execution.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test_support/recovery_reapplication_execution.rs"]
mod reapplication_tests;
