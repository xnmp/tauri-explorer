//! Pure disposal authority for moves. A completed move's journal is its Undo
//! authority even when no private bytes remain; only explicit discard consumes it.
use super::{
    move_model::{MovePhase, MoveSpec, MoveState, Strategy},
    retention::Disposal,
};
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Decision {
    Automatic,
    Explicit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RootSide {
    Source,
    Target,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Step {
    Pending,
    Removing,
    Removed,
}

/// One decision covers the entire immutable plan. Each root has its own intent
/// and completion so loss of either volume cannot authorize skipping the other.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetirementState {
    pub decision: Decision,
    pub source: Option<Step>,
    pub target: Option<Step>,
    pub source_plan: Option<super::move_cleanup::Plan>,
    pub target_plan: Option<super::move_cleanup::Plan>,
    pub completed: bool,
}

impl RetirementState {
    pub(super) fn new(
        spec: &MoveSpec,
        decision: Decision,
        source_plan: Option<super::move_cleanup::Plan>,
        target_plan: Option<super::move_cleanup::Plan>,
    ) -> Self {
        Self {
            decision,
            source: spec.source_root.as_ref().map(|_| Step::Pending),
            target: spec.target_root.as_ref().map(|_| Step::Pending),
            source_plan,
            target_plan,
            completed: false,
        }
    }

    pub(super) fn step(&self, side: RootSide) -> Option<Step> {
        match side {
            RootSide::Source => self.source,
            RootSide::Target => self.target,
        }
    }

    pub(super) fn step_mut(&mut self, side: RootSide) -> &mut Option<Step> {
        match side {
            RootSide::Source => &mut self.source,
            RootSide::Target => &mut self.target,
        }
    }

    pub(super) fn plan(&self, side: RootSide) -> Option<&super::move_cleanup::Plan> {
        match side {
            RootSide::Source => self.source_plan.as_ref(),
            RootSide::Target => self.target_plan.as_ref(),
        }
    }
    pub(super) fn plan_mut(&mut self, side: RootSide) -> &mut Option<super::move_cleanup::Plan> {
        match side {
            RootSide::Source => &mut self.source_plan,
            RootSide::Target => &mut self.target_plan,
        }
    }

    pub(super) fn roots_removed(&self) -> bool {
        [self.source, self.target]
            .into_iter()
            .flatten()
            .all(|step| step == Step::Removed)
    }

    pub(super) fn validate(&self, spec: &MoveSpec, state: &MoveState) -> io::Result<()> {
        let policy = disposal(spec, state.phase)
            .ok_or_else(|| invalid("Unsettled move cannot authorize retirement"))?;
        if self.source.is_some() != spec.source_root.is_some()
            || self.target.is_some() != spec.target_root.is_some()
            || (self.decision == Decision::Automatic && policy == Disposal::ExplicitOnly)
            || (self.completed && !self.roots_removed())
            // A fixed source-then-target order makes interruption unambiguous.
            || (self.target.is_some_and(|step| step != Step::Pending)
                && self.source.is_some_and(|step| step != Step::Removed))
        {
            return Err(invalid(
                "Move retirement disagrees with its disposal authority or root order",
            ));
        }
        for (side, root) in [
            (RootSide::Source, &spec.source_root),
            (RootSide::Target, &spec.target_root),
        ] {
            if self.plan(side).is_some()
                != self.step(side).is_some_and(|step| step != Step::Removed)
            {
                return Err(invalid("Move root removal lacks its exact descendant plan"));
            }
            if let (Some(root), Some(plan)) = (root, self.plan(side)) {
                let expected = expected_payload(spec, state, side)?;
                plan.validate(
                    &root.path.0,
                    expected
                        .as_ref()
                        .map(|(name, versions)| (*name, versions.as_slice())),
                )?;
            }
        }
        Ok(())
    }
}

/// The one expected child of a settled root, shared by journal validation and observation.
pub(super) fn expected_payload(
    spec: &MoveSpec,
    state: &MoveState,
    side: RootSide,
) -> io::Result<Option<(&'static str, Vec<super::model::EntryVersion>)>> {
    Ok(match (side, state.phase) {
        (RootSide::Source, MovePhase::Parked) => {
            Some(("parked", vec![spec.source_version.clone()]))
        }
        (RootSide::Target, MovePhase::Published | MovePhase::Parked | MovePhase::Removed) => spec
            .target_original
            .clone()
            .map(|version| ("original", vec![version])),
        (RootSide::Target, MovePhase::Restored) if spec.strategy == Strategy::CopyParked => {
            let staged = state
                .staged
                .as_ref()
                .ok_or_else(|| invalid("Move has no staged evidence"))?;
            Some((
                "publication",
                vec![staged.version.clone(), staged.published_version()?],
            ))
        }
        _ => None,
    })
}

/// Native observations still have to prove the expected endpoints and private
/// artifacts. This policy never grants filesystem authority by itself.
pub(super) fn disposal(spec: &MoveSpec, phase: MovePhase) -> Option<Disposal> {
    use Disposal::*;
    match (spec.strategy, phase) {
        (Strategy::Rename, MovePhase::Published) | (Strategy::CopyParked, MovePhase::Parked) => {
            Some(ExplicitOnly)
        }
        (Strategy::CopyParked, MovePhase::Removed) => Some(if spec.target_original.is_some() {
            ExplicitOnly
        } else {
            AutomaticWhenSourceIntact
        }),
        (_, MovePhase::Restored) => Some(
            if spec.strategy == Strategy::CopyParked
                && (spec.source_version.directory || spec.source_version.symlink)
            {
                ExplicitOnly
            } else {
                AutomaticWhenSourceIntact
            },
        ),
        _ => None,
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
