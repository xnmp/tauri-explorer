//! Concrete durable move execution. Filesystem effects occur only after the
//! corresponding intent checkpoint, and the ordering is the crash contract:
//!
//! * a same-filesystem move without an overwrite is one no-replace rename;
//! * an overwritten destination is parked in private storage before publication;
//! * a cross-filesystem source is parked only after its destination exists,
//!   and its parked copy is removed only after that parking is durable.
//!
//! No method here deletes a user entry outside `remove_source`, which requires
//! an already-durable park, so no boundary can leave both endpoints absent.
use super::{
    coordinator::DurableOperation,
    model::{EntryVersion, ObjectId, StagedPayload},
    move_model::{MoveSpec, Strategy},
    move_transition::{restoration_source, MoveTransition, RestorationSource},
    rename_outcome::{classify, RenamePosition},
    replacement_artifact::{Anchor, Root, RootPlan},
};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at, version_from_metadata},
        native_directory::Directory,
    },
};
use std::{ffi::OsStr, io, os::unix::fs::PermissionsExt, path::Path};

/// Private names inside an artifact root. `publication` matches the copy
/// executor's spelling; `original` is a displaced destination; `parked` is a
/// cross-filesystem source hidden after its destination was published.
const PUBLICATION: &str = "publication";
const ORIGINAL: &str = "original";
const PARKED: &str = "parked";

pub(super) struct MoveExecution {
    pub(super) operation: DurableOperation,
    source_root: Option<Root>,
    target_root: Option<Root>,
    /// Interruption seam. Each labelled boundary sits after a native effect and
    /// before the checkpoint that records it — exactly where a crash must be
    /// survivable. Production callers always pass `None`.
    hook: Option<Boundary>,
}

pub(super) type Boundary = Box<dyn Fn(&'static str) -> Result<(), AppError> + Send>;

/// A user endpoint addressed through its retained parent handle. Reopening the
/// public path instead would let a namespace substitution redirect the effect.
struct Endpoint {
    directory: Directory,
    path: std::path::PathBuf,
    identity: ObjectId,
    name: std::ffi::OsString,
}

impl Endpoint {
    fn open(path: &Path, parent: ObjectId) -> Result<Self, AppError> {
        let parent_path = path
            .parent()
            .ok_or_else(|| invalid("Move endpoint has no parent"))?;
        let name = path
            .file_name()
            .ok_or_else(|| invalid("Move endpoint has no name"))?
            .to_owned();
        let directory = Directory::open(parent_path)?;
        if of_file(&directory.file)? != parent {
            return Err(invalid("Move endpoint parent changed before its effect"));
        }
        Ok(Self {
            directory,
            path: path.to_owned(),
            identity: parent,
            name,
        })
    }

    fn verify(&self) -> Result<(), AppError> {
        if of_file(&self.directory.file)? != self.identity
            || of_file(&Directory::open(self.path.parent().expect("validated parent"))?.file)?
                != self.identity
        {
            return Err(invalid("Move endpoint parent namespace changed"));
        }
        Ok(())
    }

    fn probe(&self) -> Result<Option<EntryVersion>, AppError> {
        probe(&self.directory, &self.name)
    }
}

impl MoveExecution {
    fn spec(&self) -> Result<&MoveSpec, AppError> {
        Ok(self.operation.intent().operation.move_spec()?)
    }

    fn source(&self) -> Result<Endpoint, AppError> {
        let spec = self.spec()?;
        Endpoint::open(&spec.source.0, spec.source_parent)
    }

    fn target(&self) -> Result<Endpoint, AppError> {
        let spec = self.spec()?;
        Endpoint::open(&spec.target.0, spec.target_parent)
    }

    fn require<'a>(root: &'a Option<Root>, which: &str) -> Result<&'a Root, AppError> {
        root.as_ref().ok_or_else(|| {
            AppError::MutationUncertain(format!("Move has no opened {which} artifact root"))
        })
    }

    /// Plan both roots exactly as the immutable intent named them. A root is a
    /// private sibling of the user entry whose displacement it will retain.
    fn plans(spec: &MoveSpec) -> Vec<(bool, RootPlan)> {
        let mut excluded = vec![spec.source_version.object];
        if let Some(original) = &spec.target_original {
            excluded.push(original.object);
        }
        let mut plans = Vec::new();
        for (is_source, plan, user, parent) in [
            (
                true,
                spec.source_root.as_ref(),
                &spec.source,
                spec.source_parent,
            ),
            (
                false,
                spec.target_root.as_ref(),
                &spec.target,
                spec.target_parent,
            ),
        ] {
            let Some(plan) = plan else { continue };
            plans.push((
                is_source,
                RootPlan {
                    parent_path: user
                        .0
                        .parent()
                        .expect("validated move endpoint parent")
                        .to_owned(),
                    parent,
                    root: plan.path.0.clone(),
                    token: plan.token.clone(),
                    excluded: excluded.clone(),
                },
            ));
        }
        plans
    }

    /// A dropped or failed preparation leaves catalog authority and any native
    /// artifacts intact. Neither this executor nor its fields delete on Drop.
    pub(super) fn prepare_with(
        mut operation: DurableOperation,
        hook: Option<Boundary>,
    ) -> Result<Self, AppError> {
        let spec = operation.intent().operation.move_spec()?.clone();
        let plans = Self::plans(&spec);
        if plans.is_empty() {
            // The same-filesystem non-overwrite fast path owns no private
            // storage: there is nothing to displace and nothing to retain.
            // It still carries the boundary seam, so its single publication
            // rename is coverable by the crash tests like any other effect.
            return Ok(Self {
                operation,
                source_root: None,
                target_root: None,
                hook,
            });
        }
        let anchors: Vec<_> = plans
            .into_iter()
            .map(|(is_source, plan)| {
                Anchor::open_plan(operation.intent(), plan).map(|anchor| (is_source, anchor))
            })
            .collect::<Result<_, _>>()?;
        operation.advance_move(MoveTransition::BeginRoots)?;
        let mut source_root = None;
        let mut target_root = None;
        for (is_source, anchor) in anchors {
            let root = anchor.create()?;
            if is_source {
                source_root = Some(root);
            } else {
                target_root = Some(root);
            }
        }
        for label in ["root"] {
            if let Some(hook) = &hook {
                hook(label)?;
            }
        }
        operation.advance_move(MoveTransition::RootsObserved {
            source: source_root.as_ref().map(Root::identity),
            target: target_root.as_ref().map(Root::identity),
        })?;
        let mut execution = Self {
            operation,
            source_root,
            target_root,
            hook,
        };
        execution
            .operation
            .advance_move(MoveTransition::BeginManifests)?;
        let result = (|| {
            for root in execution.roots() {
                root.publish_manifest(execution.operation.intent())?;
                root.verify_namespace()?;
            }
            execution.at("manifest")
        })();
        if let Err(error) = result {
            return Err(execution.retain_failure(error));
        }
        execution
            .operation
            .advance_move(MoveTransition::ManifestsCompleted)?;
        Ok(execution)
    }

    /// Reopen only the checkpoint's recorded roots and exact manifests. Holding
    /// a native owner never justifies replaying an interrupted effect; each
    /// method reconciles its own recorded phase against live endpoints.
    pub(super) fn reopen(operation: DurableOperation) -> Result<Self, AppError> {
        let spec = operation.intent().operation.move_spec()?.clone();
        let state = operation.state().move_state()?.clone();
        let mut source_root = None;
        let mut target_root = None;
        for (is_source, plan) in Self::plans(&spec) {
            let recorded = if is_source {
                state.source_root
            } else {
                state.target_root
            };
            let identity = recorded.ok_or_else(|| {
                AppError::MutationUncertain(
                    "Move has no recorded artifact root identity for its phase".into(),
                )
            })?;
            let root = Anchor::open_plan(operation.intent(), plan)?.open_existing(identity)?;
            root.verify_manifest(operation.intent())?;
            if is_source {
                source_root = Some(root);
            } else {
                target_root = Some(root);
            }
        }
        Ok(Self {
            operation,
            source_root,
            target_root,
            hook: None,
        })
    }

    #[cfg(test)]
    pub(super) fn with_boundary(mut self, hook: Boundary) -> Self {
        self.hook = Some(hook);
        self
    }

    fn at(&self, label: &'static str) -> Result<(), AppError> {
        match &self.hook {
            Some(hook) => hook(label),
            None => Ok(()),
        }
    }

    fn roots(&self) -> impl Iterator<Item = &Root> {
        self.source_root.iter().chain(self.target_root.iter())
    }

    fn verify_authority(&self) -> Result<(), AppError> {
        for root in self.roots() {
            root.verify_manifest(self.operation.intent())?;
        }
        Ok(())
    }

    /// Copy a cross-filesystem source into the destination's private root.
    /// Nothing about the public source or destination changes here.
    pub(super) fn stage_copy(
        &mut self,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<(), AppError> {
        self.operation.advance_move(MoveTransition::BeginStaging)?;
        let payload = match self
            .copy_payload(progress)
            .and_then(|payload| self.at("stage").map(|()| payload))
        {
            Ok(payload) => payload,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation
            .advance_move(MoveTransition::StagingCompleted(payload))
    }

    fn copy_payload(
        &self,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<StagedPayload, AppError> {
        use crate::files::anchored_copy;
        self.verify_authority()?;
        let spec = self.spec()?.clone();
        let root = Self::require(&self.target_root, "target")?;
        let source = self.source()?;
        if source.probe()? != Some(spec.source_version.clone()) {
            return Err(invalid("Move source changed before staging"));
        }
        let copied = anchored_copy::copy_entry(
            &source.directory,
            &source.name,
            root.directory(),
            OsStr::new(PUBLICATION),
            &spec.source.0,
            &spec.source_version,
            progress,
        )?;
        source.verify()?;
        if source.probe()? != Some(spec.source_version) {
            return Err(invalid("Move source changed during staging"));
        }
        self.verify_authority()?;
        Ok(StagedPayload {
            version: copied.version,
            final_mode: copied.final_mode,
        })
    }

    /// Retain the destination that an overwriting move is about to replace.
    pub(super) fn displace_target(&mut self) -> Result<(), AppError> {
        self.operation
            .advance_move(MoveTransition::BeginDisplacement)?;
        let result = (|| {
            self.verify_authority()?;
            let original = self
                .spec()?
                .target_original
                .clone()
                .ok_or_else(|| invalid("Move displacement has no recorded original"))?;
            let root = Self::require(&self.target_root, "target")?;
            let target = self.target()?;
            relocate(
                &target.directory,
                &target.name,
                root.directory(),
                OsStr::new(ORIGINAL),
                &original,
            )?;
            self.verify_authority()?;
            self.at("displace")
        })();
        if let Err(error) = result {
            return Err(self.retain_failure(error));
        }
        self.operation
            .advance_move(MoveTransition::DisplacementCompleted)
    }

    /// Move the payload into its public destination. A same-filesystem move
    /// renames the user's own object; a cross-filesystem move publishes the
    /// staged copy while its source is still untouched at its public name.
    pub(super) fn publish_move(&mut self) -> Result<EntryVersion, AppError> {
        self.operation
            .advance_move(MoveTransition::BeginPublication)?;
        let published = match self.publish_payload().and_then(|published| {
            self.at("publish")?;
            Ok(published)
        }) {
            Ok(published) => published,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation
            .advance_move(MoveTransition::PublicationCompleted)?;
        Ok(published)
    }

    fn publish_payload(&self) -> Result<EntryVersion, AppError> {
        self.verify_authority()?;
        let spec = self.spec()?.clone();
        let target = self.target()?;
        let published = match spec.strategy {
            Strategy::Rename => {
                let source = self.source()?;
                relocate(
                    &source.directory,
                    &source.name,
                    &target.directory,
                    &target.name,
                    &spec.source_version,
                )?;
                source.verify()?;
                spec.source_version
            }
            Strategy::CopyParked => {
                let staged = self
                    .operation
                    .state()
                    .move_state()?
                    .staged
                    .clone()
                    .ok_or_else(|| invalid("Move publication lacks its staged payload"))?;
                let root = Self::require(&self.target_root, "target")?;
                self.publish_staged(root, &target, &staged)?
            }
        };
        target.verify()?;
        self.verify_authority()?;
        if target.probe()?.as_ref() != Some(&published) {
            return Err(uncertain("Move publication changed before durability"));
        }
        Ok(published)
    }

    /// A staged directory stays owner-accessible while private. Restore its
    /// recorded final mode through a retained handle after publication, exactly
    /// as the replacement executor does, so both are recognizable after a crash.
    fn publish_staged(
        &self,
        root: &Root,
        target: &Endpoint,
        staged: &StagedPayload,
    ) -> Result<EntryVersion, AppError> {
        let finalized = staged.published_version()?;
        let already = target.probe()?;
        if already.as_ref() == Some(&finalized)
            && probe(root.directory(), OsStr::new(PUBLICATION))?.is_none()
        {
            // A prior process completed both the rename and finalization.
            return Ok(finalized);
        }
        let retained = if staged.final_mode.is_some() {
            let position = if already.is_none() {
                RenamePosition::Unmoved
            } else {
                RenamePosition::Moved
            };
            let (parent, name) = if position == RenamePosition::Unmoved {
                (root.directory(), OsStr::new(PUBLICATION))
            } else {
                (&target.directory, target.name.as_os_str())
            };
            Some(parent.open_existing(name)?)
        } else {
            None
        };
        relocate(
            root.directory(),
            OsStr::new(PUBLICATION),
            &target.directory,
            &target.name,
            &staged.version,
        )?;
        let Some(directory) = retained else {
            return Ok(finalized);
        };
        let observed = version_from_metadata(&directory.metadata()?)?;
        if observed == staged.version {
            directory
                .file
                .set_permissions(std::fs::Permissions::from_mode(
                    staged
                        .final_mode
                        .expect("a retained publication directory has a final mode"),
                ))?;
        } else if observed != finalized {
            return Err(uncertain(
                "Move publication directory changed before finalization",
            ));
        }
        directory.sync()?;
        if version_from_metadata(&directory.metadata()?)? != finalized {
            return Err(uncertain(
                "Move publication directory did not retain its final mode",
            ));
        }
        Ok(finalized)
    }

    /// Hide the cross-filesystem source under private storage. Reaching this
    /// method at all requires a `Published` checkpoint, so the destination
    /// already holds the payload before the source stops being reachable.
    pub(super) fn park_source(&mut self) -> Result<(), AppError> {
        self.operation.advance_move(MoveTransition::BeginPark)?;
        let result = (|| {
            self.verify_authority()?;
            let spec = self.spec()?.clone();
            let root = Self::require(&self.source_root, "source")?;
            let source = self.source()?;
            // Never park before the destination is verifiably present.
            let target = self.target()?;
            if target.probe()?.is_none() {
                return Err(uncertain(
                    "Move destination is absent; the source must not be parked",
                ));
            }
            relocate(
                &source.directory,
                &source.name,
                root.directory(),
                OsStr::new(PARKED),
                &spec.source_version,
            )?;
            source.verify()?;
            self.verify_authority()?;
            self.at("park")
        })();
        if let Err(error) = result {
            return Err(self.retain_failure(error));
        }
        self.operation.advance_move(MoveTransition::ParkCompleted)
    }

    /// Discard the parked source. This is the only deletion in this executor,
    /// it is reachable only from a durable `Parked` checkpoint, and it is never
    /// part of the forward move or of restoration. It has no production caller
    /// yet — finishing a parked move belongs with durable retirement (#687) —
    /// but the crash boundary tests exercise the ordering it enforces.
    #[allow(dead_code)]
    pub(super) fn remove_source(&mut self) -> Result<(), AppError> {
        self.operation
            .advance_move(MoveTransition::BeginSourceRemoval)?;
        let result = (|| {
            self.verify_authority()?;
            let spec = self.spec()?.clone();
            let root = Self::require(&self.source_root, "source")?;
            let target = self.target()?;
            let published = target
                .probe()?
                .ok_or_else(|| uncertain("Move destination is absent; the source is retained"))?;
            let expected = match spec.strategy {
                Strategy::CopyParked => self
                    .operation
                    .state()
                    .move_state()?
                    .staged
                    .as_ref()
                    .ok_or_else(|| invalid("Move removal lacks its staged payload"))?
                    .published_version()?,
                Strategy::Rename => spec.source_version.clone(),
            };
            if published != expected {
                return Err(uncertain(
                    "Move destination differs from the published payload; the source is retained",
                ));
            }
            match probe(root.directory(), OsStr::new(PARKED))? {
                None => Ok(()),
                Some(parked) if parked == spec.source_version => {
                    remove_tree(root.directory(), OsStr::new(PARKED), parked.directory, 0)?;
                    root.directory().sync()?;
                    if probe(root.directory(), OsStr::new(PARKED))?.is_some() {
                        return Err(uncertain("Move parked source was not removed"));
                    }
                    self.at("remove")
                }
                Some(_) => Err(uncertain(
                    "Move parked source differs from its recorded identity; it is retained",
                )),
            }
        })();
        if let Err(error) = result {
            return Err(self.retain_failure(error));
        }
        self.operation.advance_move(MoveTransition::SourceRemoved)
    }

    /// The record's own exact inverse. Nothing is deleted before the source
    /// exists again at its original name.
    pub(super) fn restore_move(&mut self) -> Result<(), AppError> {
        let spec = self.spec()?.clone();
        let origin = restoration_source(&spec);
        self.operation
            .advance_move(MoveTransition::BeginRestoration)?;
        let result = (|| {
            // A durable restoration intent exists from here on: an interruption
            // at this boundary must stay retryable, not strand a parked source.
            self.at("restore-intent")?;
            self.verify_authority()?;
            let source = self.source()?;
            let target = self.target()?;
            match origin {
                RestorationSource::Published => {
                    if source.probe()?.is_none() {
                        relocate(
                            &target.directory,
                            &target.name,
                            &source.directory,
                            &source.name,
                            &spec.source_version,
                        )?;
                    }
                }
                RestorationSource::Parked => {
                    let root = Self::require(&self.source_root, "source")?;
                    // A cross-filesystem source may never have been parked
                    // (a restoration from `Published`), or may already be home
                    // (a reasserted restoration). Observe, never assume.
                    if source.probe()?.is_none() {
                        relocate(
                            root.directory(),
                            OsStr::new(PARKED),
                            &source.directory,
                            &source.name,
                            &spec.source_version,
                        )?;
                    }
                    self.park_publication(&target)?;
                }
            }
            // Only once the source is home may the destination be restored to
            // the original it displaced.
            if source.probe()?.as_ref() != Some(&spec.source_version) {
                return Err(uncertain(
                    "Move restoration did not return the source to its original name",
                ));
            }
            if let Some(original) = &spec.target_original {
                let root = Self::require(&self.target_root, "target")?;
                if target.probe()?.is_none() {
                    relocate(
                        root.directory(),
                        OsStr::new(ORIGINAL),
                        &target.directory,
                        &target.name,
                        original,
                    )?;
                }
                if target.probe()?.as_ref() != Some(original) {
                    return Err(uncertain(
                        "Move restoration could not republish the displaced original",
                    ));
                }
            }
            source.verify()?;
            target.verify()?;
            self.verify_authority()?;
            self.at("restore")
        })();
        if let Err(error) = result {
            return Err(self.retain_failure(error));
        }
        self.operation
            .advance_move(MoveTransition::RestorationCompleted)
    }

    /// Return a cross-filesystem publication to the private root it came from,
    /// once the exact source is verified present at its own name. Restoration
    /// deletes nothing: the copied payload stays recoverable, and a destination
    /// edited after publication is preserved rather than destroyed.
    fn park_publication(&self, target: &Endpoint) -> Result<(), AppError> {
        let spec = self.spec()?.clone();
        let source = self.source()?;
        if source.probe()?.as_ref() != Some(&spec.source_version) {
            return Err(uncertain(
                "Move source is absent; the published destination is retained",
            ));
        }
        let staged = self
            .operation
            .state()
            .move_state()?
            .staged
            .clone()
            .ok_or_else(|| invalid("Move restoration lacks its staged payload"))?;
        let root = Self::require(&self.target_root, "target")?;
        // Publication may have been interrupted before its final directory
        // mode was restored, so both recorded permission states are valid here.
        let observed = match target.probe()? {
            None => return Ok(()),
            Some(observed) => observed,
        };
        let expected = if observed == staged.version {
            staged.version.clone()
        } else {
            staged.published_version()?
        };
        if observed != expected {
            return Err(uncertain(
                "Move destination differs from the published payload; it is retained",
            ));
        }
        relocate(
            &target.directory,
            &target.name,
            root.directory(),
            OsStr::new(PUBLICATION),
            &expected,
        )
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
            .advance_move(MoveTransition::ReportError(message))
        {
            log::warn!("Could not persist move failure: {persistence}");
        }
        error
    }
}

/// One no-replace rename classified from both observed endpoints. A reported
/// error can still mean the rename happened, and a success alone cannot prove
/// it did, so the result comes from the versions rather than the syscall.
fn relocate(
    from: &Directory,
    from_name: &OsStr,
    to: &Directory,
    to_name: &OsStr,
    expected: &EntryVersion,
) -> Result<(), AppError> {
    let before = classify(
        probe(from, from_name)?.as_ref(),
        probe(to, to_name)?.as_ref(),
        expected,
    );
    if before == RenamePosition::Conflict {
        return Err(invalid("Move endpoints differ from durable evidence"));
    }
    let result = if before == RenamePosition::Unmoved {
        from.rename_to(from_name, to, to_name)
            .map_err(AppError::from)
    } else {
        Ok(())
    };
    match classify(
        probe(from, from_name)?.as_ref(),
        probe(to, to_name)?.as_ref(),
        expected,
    ) {
        RenamePosition::Moved => {
            from.sync()?;
            to.sync()?;
            Ok(())
        }
        RenamePosition::Unmoved => match result {
            Err(error) => Err(error),
            Ok(()) => Err(uncertain("Move reported success without moving the entry")),
        },
        RenamePosition::Conflict => Err(uncertain(
            "Move has conflicting source or destination evidence",
        )),
    }
}

/// Remove one entry through its retained parent handle. Every descendant is
/// reached relative to an opened directory, so no path component can be
/// substituted between the decision to remove and the removal itself.
fn remove_tree(
    parent: &Directory,
    name: &OsStr,
    directory: bool,
    depth: usize,
) -> Result<(), AppError> {
    const MAX_DEPTH: usize = 256;
    if depth > MAX_DEPTH {
        return Err(invalid(
            "Move parked source exceeds its removal depth budget",
        ));
    }
    if directory {
        let child = parent.open_existing(name)?;
        for entry in child.entries()? {
            let entry = entry?;
            let is_directory = version_at(&child, &entry)?.directory;
            remove_tree(&child, &entry, is_directory, depth + 1)?;
        }
    }
    parent.unlink(name, directory)?;
    Ok(())
}

fn probe(directory: &Directory, name: &OsStr) -> Result<Option<EntryVersion>, AppError> {
    match version_at(directory, name) {
        Ok(version) => Ok(Some(version)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}

fn uncertain(message: &str) -> AppError {
    AppError::MutationUncertain(message.into())
}

#[cfg(test)]
#[path = "../../../test_support/recovery_move_execution.rs"]
mod tests;
