//! Move-specific observation and journaled removal. Public endpoints are only
//! read; all cleanup effects stay within the two immutable private namespaces.
use super::{
    coordinator::DurableOperation,
    model::EntryVersion,
    move_execution::MoveExecution,
    move_model::{MovePhase, Strategy},
    move_retention::{self, Decision, RootSide, Step},
    move_transition::MoveTransition,
    replacement_artifact::{Anchor, Root},
    retention::Disposal,
    retirement::Eligibility,
};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at},
        native_directory::Directory,
    },
};
use std::{io, path::Path};

/// Journal bytes a new discard decision must leave free. Each decision can
/// hold two cleanup plans of up to 8 MiB until it completes, so at most three
/// maximal decisions fit while ordinary operations keep a quarter of the
/// journal (ADR 0023).
const RETIREMENT_HEADROOM: usize = super::journal::MAX_TOTAL_BYTES / 4;

pub(super) struct MoveRetirement {
    pub(super) operation: DurableOperation,
    roots: Vec<(RootSide, Option<Root>)>,
    eligibility: Eligibility,
    headroom: usize,
}

impl MoveRetirement {
    pub(super) fn open(operation: DurableOperation) -> Result<Self, AppError> {
        let state = operation.state().move_state()?;
        let spec = operation.intent().operation.move_spec()?;
        let policy = move_retention::disposal(spec, state.phase);
        if policy.is_none() {
            return Ok(Self {
                operation,
                roots: vec![],
                headroom: RETIREMENT_HEADROOM,
                eligibility: Eligibility::Preserved(
                    "This move still needs recovery; all evidence is preserved".into(),
                ),
            });
        }
        let mut roots = Vec::new();
        for (source, plan) in MoveExecution::plans(spec) {
            let identity = if source {
                state.source_root
            } else {
                state.target_root
            }
            .ok_or_else(|| invalid("Move artifact identity is missing"))?;
            roots.push((
                if source {
                    RootSide::Source
                } else {
                    RootSide::Target
                },
                Anchor::open_plan(operation.intent(), plan)?.open_optional(identity)?,
            ));
        }
        let eligibility = if state.error.is_some() && state.retirement.is_none() {
            Eligibility::Preserved(
                "This move needs recovery; retained bytes are still accounted".into(),
            )
        } else if state.retirement.is_some() {
            Eligibility::Resume
        } else if policy == Some(Disposal::ExplicitOnly) {
            Eligibility::Discardable
        } else {
            Eligibility::Automatic
        };
        let mut result = Self {
            operation,
            roots,
            eligibility,
            headroom: RETIREMENT_HEADROOM,
        };
        if let Err(error) = result.verify() {
            // An interrupted decision that removed nothing resumes only to
            // withdraw itself on its post-intent verification (below).
            if result.untouched() {
                return Ok(result);
            }
            result.eligibility = Eligibility::Preserved(if result.retiring() {
                format!(
                    "Discard stopped before finishing; its Undo history is gone and the \
                     remaining recovery files are preserved: {error}"
                )
            } else {
                error.to_string()
            });
        }
        Ok(result)
    }

    /// Test seam: the journal headroom a new decision must leave free.
    #[cfg(test)]
    fn leaving(mut self, headroom: usize) -> Self {
        self.headroom = headroom;
        self
    }

    pub(super) fn eligibility(&self) -> &Eligibility {
        &self.eligibility
    }

    fn retiring(&self) -> bool {
        self.operation
            .state()
            .move_state()
            .is_ok_and(|state| state.retirement.is_some())
    }

    /// Observation that a journaled decision has removed nothing yet: no root
    /// is retired and every root still strictly matches its captured plan,
    /// manifest and exact payload version.
    fn untouched(&self) -> bool {
        let Ok(state) = self.operation.state().move_state() else {
            return false;
        };
        let Some(retirement) = state.retirement.as_ref() else {
            return false;
        };
        !retirement.completed
            && self.roots.iter().all(|(side, root)| {
                retirement.step(*side) != Some(Step::Removed)
                    && root.as_ref().is_some_and(|root| {
                        self.expected(*side).is_ok_and(|expected| {
                            root.verify_move_retirement(
                                self.operation.intent(),
                                expected.as_ref(),
                                retirement.plan(*side),
                                false,
                            )
                            .is_ok()
                        })
                    })
            })
    }

    /// A verification refusal after the decision is journaled but before any
    /// unlink withdraws that decision rather than consuming Undo for nothing.
    fn refuse(&mut self, error: AppError) -> AppError {
        if !self.untouched() {
            return error;
        }
        match self
            .operation
            .advance_move(MoveTransition::WithdrawRetirement)
        {
            Ok(()) => invalid(&format!(
                "{error}. Discard was withdrawn before removing anything; Undo and every \
                 recovery file are kept"
            )),
            Err(persistence) => {
                log::warn!("Could not withdraw move retirement: {persistence}");
                error
            }
        }
    }

    fn step(&self, side: RootSide) -> Option<Step> {
        self.operation
            .state()
            .move_state()
            .ok()?
            .retirement
            .as_ref()?
            .step(side)
    }

    fn expected(
        &self,
        side: RootSide,
    ) -> Result<Option<(&'static str, Vec<EntryVersion>)>, AppError> {
        Ok(move_retention::expected_payload(
            self.operation.intent().operation.move_spec()?,
            self.operation.state().move_state()?,
            side,
        )?)
    }

    fn verify_public(&self) -> Result<(), AppError> {
        let spec = self.operation.intent().operation.move_spec()?;
        let state = self.operation.state().move_state()?;
        let source = observe(&spec.source.0, spec.source_parent)?;
        let target = observe(&spec.target.0, spec.target_parent)?;
        let matches = if state.phase == MovePhase::Restored {
            source.as_ref() == Some(&spec.source_version) && target == spec.target_original
        } else {
            let published = match spec.strategy {
                Strategy::Rename => spec.source_version.clone(),
                Strategy::CopyParked => state
                    .staged
                    .as_ref()
                    .ok_or_else(|| invalid("Move has no staged evidence"))?
                    .published_version()?,
            };
            source.is_none() && target == Some(published)
        };
        if matches {
            Ok(())
        } else {
            Err(invalid(
                "Move endpoints changed; retained recovery files are preserved",
            ))
        }
    }

    fn verify(&self) -> Result<(), AppError> {
        // A rootless record (a same-volume rename) retains nothing, so there is
        // nothing public-endpoint proof could protect: forgetting it removes no
        // file. Requiring exact endpoints would pin it forever after any edit.
        if self.roots.is_empty() {
            return Ok(());
        }
        let retiring = self.operation.state().move_state()?.retirement.as_ref();
        let artifacts_gone =
            !self.roots.is_empty() && self.roots.iter().all(|(_, root)| root.is_none());
        if retiring.is_none() || (!artifacts_gone && !retiring.is_some_and(|state| state.completed))
        {
            self.verify_public()?;
        }
        for (side, root) in &self.roots {
            let step = self.step(*side);
            match (root, step) {
                (None, Some(Step::Removing | Step::Removed)) => {}
                (None, _) => {
                    return Err(invalid(
                        "Move artifact root is missing before its removal intent",
                    ))
                }
                (Some(_), Some(Step::Removed)) => {
                    return Err(invalid("A retired move artifact root reappeared"))
                }
                (Some(root), _) => root.verify_move_retirement(
                    self.operation.intent(),
                    self.expected(*side)?.as_ref(),
                    self.operation
                        .state()
                        .move_state()?
                        .retirement
                        .as_ref()
                        .and_then(|state| state.plan(*side)),
                    step == Some(Step::Removing),
                )?,
            }
        }
        Ok(())
    }

    pub(super) fn measure(&mut self) -> Result<Option<u64>, AppError> {
        let state = self.operation.state().move_state()?;
        if state.retained_bytes.is_some() {
            return Ok(state.retained_bytes);
        }
        if move_retention::disposal(self.operation.intent().operation.move_spec()?, state.phase)
            .is_none()
        {
            return Ok(None);
        }
        let mut bytes = 0u64;
        for (side, root) in &self.roots {
            if root.is_none() && !matches!(self.step(*side), Some(Step::Removing | Step::Removed)) {
                return Ok(None);
            }
            if let Some(root) = root {
                root.verify_namespace()?;
                let Some(size) = root.measure_all()? else {
                    return Ok(None);
                };
                bytes = bytes.saturating_add(size);
            }
        }
        self.operation
            .advance_move(MoveTransition::RetentionMeasured(bytes))?;
        Ok(Some(bytes))
    }

    pub(super) fn retire_with(
        mut self,
        mut checkpoint: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if let Eligibility::Preserved(reason) = &self.eligibility {
            return Err(invalid(reason));
        }
        let result = self.remove(&mut checkpoint);
        if let Err(error) = result {
            if self.operation.state().move_state()?.retirement.is_none() {
                // A read-only preflight failure did not consume the inverse.
                return Err(error);
            }
            self.report(&error.to_string());
            return Err(error);
        }
        self.operation.retire_record()
    }

    /// Record why a journaled retirement stopped. A reported failure waits
    /// for an explicit retry; enforcement never claims it again (ADR 0023).
    pub(super) fn report(&mut self, reason: &str) {
        if let Err(persistence) =
            self.operation
                .advance_move(MoveTransition::ReportError(super::model::bounded_error(
                    reason.to_owned(),
                )))
        {
            log::warn!("Could not persist move retirement failure: {persistence}");
        }
    }

    fn remove(
        &mut self,
        checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let state = self.operation.state().move_state()?;
        let fresh = state.retirement.is_none();
        let decision = state
            .retirement
            .as_ref()
            .map(|retirement| retirement.decision)
            .unwrap_or(if self.eligibility == Eligibility::Automatic {
                Decision::Automatic
            } else {
                Decision::Explicit
            });
        // Capture every root before the global decision and persist both plans
        // together. Restart must not adopt new descendants in a later root;
        // neither may it discover an unrepresentable target after removing source.
        let plans = self
            .roots
            .iter()
            .map(|(side, root)| {
                if self.step(*side) == Some(Step::Removed) {
                    return Ok(None);
                }
                if let Some(plan) = self
                    .operation
                    .state()
                    .move_state()?
                    .retirement
                    .as_ref()
                    .and_then(|state| state.plan(*side))
                {
                    return Ok(Some(plan.clone()));
                }
                let root = root
                    .as_ref()
                    .ok_or_else(|| invalid("Move root vanished before cleanup planning"))?;
                root.plan_move_retirement(self.operation.intent(), self.expected(*side)?.as_ref())
                    .map(Some)
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        // Before the decision consumes Undo: a cleanup this user cannot
        // perform must be refused while nothing is journaled or removed.
        for ((_, root), plan) in self.roots.iter().zip(&plans) {
            if let (Some(root), Some(plan)) = (root, plan) {
                root.preflight_move_retirement(plan)?;
            }
        }
        // The last read-only proof immediately before the decision consumes
        // Undo: planning a large tree takes time the endpoints can change in.
        if fresh {
            self.verify()?;
        }
        let planned = |side| {
            self.roots
                .iter()
                .position(|(candidate, _)| *candidate == side)
                .and_then(|index| plans[index].clone())
        };
        // A decision holds its plans in the journal until it completes; one
        // that could never finish must not starve every later operation.
        if !self.operation.advance_move_leaving(
            MoveTransition::BeginRetirement(
                decision,
                planned(RootSide::Source),
                planned(RootSide::Target),
            ),
            self.headroom,
        )? {
            return Err(invalid(
                "File Recovery is holding too many unfinished discards to record another. \
                 Finish or forget one of them first; nothing was removed and Undo is kept",
            ));
        }
        checkpoint("intent")?;
        if let Err(error) = self.verify() {
            return Err(self.refuse(error));
        }
        for (index, planned) in plans.iter().enumerate() {
            let side = self.roots[index].0;
            if self.step(side) == Some(Step::Removed) {
                continue;
            }
            let plan = planned
                .as_ref()
                .ok_or_else(|| invalid("Move root has no preflighted cleanup plan"))?;
            self.operation
                .advance_move(MoveTransition::BeginRootRetirement(side))?;
            checkpoint(match side {
                RootSide::Source => "source-intent",
                RootSide::Target => "target-intent",
            })?;
            // Re-observe every public endpoint after journaling, before touching this root.
            if self.roots[index].1.is_some() {
                if let Err(error) = self.verify_public() {
                    return Err(self.refuse(error));
                }
            }
            if let Some(root) = self.roots[index].1.take() {
                root.retire_move_artifacts(
                    self.operation.intent(),
                    self.expected(side)?.as_ref(),
                    plan,
                    checkpoint,
                )?;
            }
            checkpoint(match side {
                RootSide::Source => "source-removed",
                RootSide::Target => "target-removed",
            })?;
            self.operation
                .advance_move(MoveTransition::RootRetired(side))?;
            checkpoint(match side {
                RootSide::Source => "source-completed",
                RootSide::Target => "target-completed",
            })?;
        }
        self.operation
            .advance_move(MoveTransition::RetirementCompleted)?;
        checkpoint("completed")
    }
}

fn observe(path: &Path, parent: super::model::ObjectId) -> Result<Option<EntryVersion>, AppError> {
    let parent_path = path
        .parent()
        .ok_or_else(|| invalid("Move endpoint has no parent"))?;
    let directory = Directory::open(parent_path)?;
    if of_file(&directory.file)? != parent {
        return Err(invalid("Move endpoint parent identity changed"));
    }
    let name = path
        .file_name()
        .ok_or_else(|| invalid("Move endpoint has no name"))?;
    let entry = match version_at(&directory, name) {
        Ok(version) => Some(version),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if of_file(&Directory::open(parent_path)?.file)? != parent {
        return Err(invalid("Move endpoint parent namespace changed"));
    }
    Ok(entry)
}
fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../test_support/recovery_move_retirement.rs"]
mod tests;
