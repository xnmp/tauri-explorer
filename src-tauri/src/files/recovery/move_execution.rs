//! Concrete durable move execution. Filesystem effects occur only after the
//! corresponding intent checkpoint, and the ordering is the crash contract:
//!
//! * a same-filesystem move without an overwrite is one no-replace rename;
//! * an overwritten destination is parked in private storage before publication;
//! * a cross-filesystem source is parked only after its destination exists.
//!
//! No method here deletes a user entry; parked sources are discarded only by
//! explicit retirement (`retirement`), so no boundary can leave both
//! endpoints absent.
use super::artifact_layout::{probe, ORIGINAL, PARKED, PUBLICATION};
use super::{
    checkpoint::{DurableKind, Effect, Event, Side, Sides},
    coordinator::DurableOperation,
    model::{EntryVersion, ObjectId, StagedPayload},
    move_model::{MoveSpec, Strategy},
    rename_outcome::{classify, RenamePosition},
    replacement_artifact::{Anchor, Root},
};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_from_metadata},
        native_directory::Directory,
    },
};
use std::{ffi::OsStr, io, os::unix::fs::PermissionsExt, path::Path};

pub(super) struct MoveExecution {
    pub(super) operation: DurableOperation,
    roots: Sides<Option<Root>>,
    /// Interruption seam. Each labelled boundary sits after a native effect and
    /// before the checkpoint that records it — exactly where a crash must be
    /// survivable. Production callers always pass `None`.
    hook: Option<Boundary>,
}

pub(super) type Boundary = Box<dyn Fn(&'static str) -> Result<(), AppError> + Send>;

/// Proof that an Undo passed its read-only admission. Only
/// [`MoveExecution::admit_restoration`] creates one, so no caller can reach
/// restoration's durable effects without it.
pub(super) struct AdmittedRestoration(());

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

    fn require(&self, side: Side) -> Result<&Root, AppError> {
        self.roots.get(side).as_ref().ok_or_else(|| {
            AppError::MutationUncertain(format!("Move has no opened {side:?} artifact root"))
        })
    }

    /// The sides whose private roots the immutable intent planned.
    fn planned(spec: &MoveSpec) -> impl Iterator<Item = Side> + '_ {
        [Side::Source, Side::Target]
            .into_iter()
            .filter(|side| spec.root(*side).is_some())
    }

    /// A dropped or failed preparation leaves catalog authority and any native
    /// artifacts intact. Neither this executor nor its fields delete on Drop.
    pub(super) fn prepare_with(
        mut operation: DurableOperation,
        hook: Option<Boundary>,
    ) -> Result<Self, AppError> {
        let spec = operation.intent().operation.move_spec()?.clone();
        let anchors: Vec<_> = Self::planned(&spec)
            .map(|side| Anchor::open(operation.intent(), side).map(|anchor| (side, anchor)))
            .collect::<Result<_, _>>()?;
        if anchors.is_empty() {
            // The same-filesystem non-overwrite fast path owns no private
            // storage: there is nothing to displace and nothing to retain.
            // It still carries the boundary seam, so its single publication
            // rename is coverable by the crash tests like any other effect.
            return Ok(Self {
                operation,
                roots: Sides::default(),
                hook,
            });
        }
        operation.advance(Event::Begin(Effect::Root))?;
        let mut roots = Sides::default();
        for (side, anchor) in anchors {
            *roots.get_mut(side) = Some(anchor.create()?);
        }
        if let Some(hook) = &hook {
            hook("root")?;
        }
        operation.advance(Event::Rooted(Sides {
            source: roots.source.as_ref().map(Root::identity),
            target: roots.target.as_ref().map(Root::identity),
        }))?;
        let mut execution = Self {
            operation,
            roots,
            hook,
        };
        execution
            .operation
            .advance(Event::Begin(Effect::Manifest))?;
        let result = (|| {
            for root in execution.opened() {
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
            .advance(Event::Complete(Effect::Manifest))?;
        Ok(execution)
    }

    /// Reopen only the checkpoint's recorded roots and exact manifests. Holding
    /// a native owner never justifies replaying an interrupted effect; each
    /// method reconciles its own recorded phase against live endpoints.
    pub(super) fn reopen(operation: DurableOperation) -> Result<Self, AppError> {
        let spec = operation.intent().operation.move_spec()?.clone();
        let mut roots = Sides::default();
        for side in Self::planned(&spec) {
            let identity = operation.state().roots.get(side).ok_or_else(|| {
                AppError::MutationUncertain(
                    "Move has no recorded artifact root identity for its phase".into(),
                )
            })?;
            let root = Anchor::open(operation.intent(), side)?.open_existing(identity)?;
            root.verify_manifest(operation.intent())?;
            *roots.get_mut(side) = Some(root);
        }
        Ok(Self {
            operation,
            roots,
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

    fn opened(&self) -> impl Iterator<Item = &Root> {
        self.roots.iter().filter_map(|(_, root)| root.as_ref())
    }

    fn verify_authority(&self) -> Result<(), AppError> {
        for root in self.opened() {
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
        self.operation.advance(Event::Begin(Effect::Stage))?;
        let payload = match self
            .copy_payload(progress)
            .and_then(|payload| self.at("stage").map(|()| payload))
        {
            Ok(payload) => payload,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation.advance(Event::Staged(payload))
    }

    fn copy_payload(
        &self,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<StagedPayload, AppError> {
        use crate::files::anchored_copy;
        self.verify_authority()?;
        let spec = self.spec()?.clone();
        let root = self.require(Side::Target)?;
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
        self.operation.advance(Event::Begin(Effect::Displace))?;
        let result = (|| {
            self.verify_authority()?;
            let original = self
                .spec()?
                .target_original
                .clone()
                .ok_or_else(|| invalid("Move displacement has no recorded original"))?;
            let root = self.require(Side::Target)?;
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
        self.operation.advance(Event::Complete(Effect::Displace))
    }

    /// Move the payload into its public destination. A same-filesystem move
    /// renames the user's own object; a cross-filesystem move publishes the
    /// staged copy while its source is still untouched at its public name.
    pub(super) fn publish_move(&mut self) -> Result<EntryVersion, AppError> {
        self.operation.advance(Event::Begin(Effect::Publish))?;
        let published = match self.publish_payload().and_then(|published| {
            self.at("publish")?;
            Ok(published)
        }) {
            Ok(published) => published,
            Err(error) => return Err(self.retain_failure(error)),
        };
        self.operation.advance(Event::Complete(Effect::Publish))?;
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
                    .staged
                    .clone()
                    .ok_or_else(|| invalid("Move publication lacks its staged payload"))?;
                let root = self.require(Side::Target)?;
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
        self.operation.advance(Event::Begin(Effect::Park))?;
        let result = (|| {
            self.verify_authority()?;
            let spec = self.spec()?.clone();
            let root = self.require(Side::Source)?;
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
        self.operation.advance(Event::Complete(Effect::Park))
    }

    /// The record's own exact inverse. Nothing is deleted before the source
    /// exists again at its original name.
    pub(super) fn restore_move(&mut self) -> Result<(), AppError> {
        let admitted = self.admit_restoration()?;
        self.restore_admitted(admitted)
    }

    /// Read-only Undo admission. An `Err` here precedes every durable effect,
    /// so the caller may keep offering the same Undo.
    ///
    /// Undo retains a cross-volume destination as the target root's
    /// `publication`, which is the one retained payload a user can still
    /// change after the move's own admission. It must fit a retirement plan
    /// under the bounds a discard captures, or the restored record could never
    /// be discarded (#760).
    pub(super) fn admit_restoration(&self) -> Result<AdmittedRestoration, AppError> {
        if let Some(target) = self.parkable_publication()? {
            self.admit_publication(&target).map_err(|error| {
                let reason = if error.to_string().contains("budget") {
                    format!("it has grown too large to be discarded later ({error})")
                } else {
                    format!("it cannot be read safely ({error})")
                };
                AppError::Other(format!(
                    "Undo cannot keep '{}' in File Recovery: {reason}. Nothing was changed. \
                     Fix the reported entry and Undo again, or discard this move's recovery data \
                     to keep it where it is.",
                    target.path.display()
                ))
            })?;
        }
        Ok(AdmittedRestoration(()))
    }

    /// The destination restoration would park as `publication`: present and
    /// still exactly the published payload. An absent destination parks
    /// nothing; a changed one is kept public by `park_publication`.
    fn parkable_publication(&self) -> Result<Option<Endpoint>, AppError> {
        if self.spec()?.strategy != Strategy::CopyParked {
            return Ok(None);
        }
        let Some(staged) = self.operation.state().staged.as_ref() else {
            return Ok(None);
        };
        let target = self.target()?;
        Ok(match target.probe()? {
            Some(observed)
                if observed == staged.version || observed == staged.published_version()? =>
            {
                Some(target)
            }
            _ => None,
        })
    }

    /// Walk the destination under exactly the bounds `Plan::capture` will
    /// apply to it inside the target root.
    fn admit_publication(&self, target: &Endpoint) -> Result<(), AppError> {
        let spec = self.spec()?;
        let root = spec
            .target_root
            .as_ref()
            .ok_or_else(|| invalid("Move has no target artifact root"))?;
        super::move_cleanup::Plan::admit(
            &target.directory,
            &target.name,
            &[root.path.0.join(PUBLICATION)],
            spec.plan_allowance(),
        )
    }

    pub(super) fn restore_admitted(
        &mut self,
        _admitted: AdmittedRestoration,
    ) -> Result<(), AppError> {
        let spec = self.spec()?.clone();
        self.operation.advance(Event::Begin(Effect::Restore))?;
        let result = (|| {
            // A durable restoration intent exists from here on: an interruption
            // at this boundary must stay retryable, not strand a parked source.
            self.at("restore-intent")?;
            self.verify_authority()?;
            let source = self.source()?;
            let target = self.target()?;
            match spec.strategy {
                // A same-filesystem publication is itself the original object.
                Strategy::Rename => {
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
                // A cross-filesystem source may be hidden under private
                // storage; the published destination is retired only after
                // the source is verified present at its own name.
                Strategy::CopyParked => {
                    let root = self.require(Side::Source)?;
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
                let root = self.require(Side::Target)?;
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
        self.operation.advance(Event::Complete(Effect::Restore))
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
            .staged
            .clone()
            .ok_or_else(|| invalid("Move restoration lacks its staged payload"))?;
        let root = self.require(Side::Target)?;
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
        // Admission ran before `BeginRestoration`; the destination can have
        // grown since. Refusing here keeps it public beside the returned
        // source, and the interrupted restoration stays retryable.
        self.admit_publication(target).map_err(|error| {
            uncertain(&format!(
                "'{}' grew too large to be kept in File Recovery while Undo ran ({error}). \
                 It stays in place and the source is back at its original location; remove \
                 entries from it and retry Restore in File Recovery.",
                target.path.display()
            ))
        })?;
        relocate(
            &target.directory,
            &target.name,
            root.directory(),
            OsStr::new(PUBLICATION),
            &expected,
        )
    }

    fn retain_failure(&mut self, error: AppError) -> AppError {
        self.operation.retain_failure(error)
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

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}

fn uncertain(message: &str) -> AppError {
    AppError::MutationUncertain(message.into())
}

// The crash acceptance plans moves through `forward_move`, which is Linux-only.
#[cfg(all(test, target_os = "linux"))]
#[path = "../../../test_support/recovery_move_execution.rs"]
mod tests;
