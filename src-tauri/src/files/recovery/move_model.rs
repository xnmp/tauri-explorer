//! Immutable relocation authority. A moved source is not an independent copy.
use super::model::{EntryVersion, NativePath, ObjectId};
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, io};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Strategy {
    Rename,
    CopyParked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArtifactPlan {
    pub path: NativePath,
    pub token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveSpec {
    pub source: NativePath,
    pub source_parent: ObjectId,
    pub source_version: EntryVersion,
    pub target: NativePath,
    pub target_parent: ObjectId,
    pub target_original: Option<EntryVersion>,
    pub strategy: Strategy,
    pub source_root: Option<ArtifactPlan>,
    pub target_root: Option<ArtifactPlan>,
}

/// A relocation's phases are not a replacement's. Parking and source removal
/// exist only here, and a same-filesystem rename publishes without any artifact.
/// Ordering is the crash contract: publication always precedes source parking.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MovePhase {
    Planned,
    RootIntent,
    Rooted,
    ManifestIntent,
    Prepared,
    StageIntent,
    Staged,
    DisplaceIntent,
    Displaced,
    PublishIntent,
    Published,
    ParkIntent,
    Parked,
    RemoveIntent,
    Removed,
    RestoreIntent,
    Restored,
}

impl MovePhase {
    /// Artifact roots are planned before admission but observed only after
    /// their exclusive creation. `Planned`/`RootIntent` have no root identity.
    pub(super) fn roots_observed(self) -> bool {
        !matches!(self, Self::Planned | Self::RootIntent)
    }

    /// A cross-filesystem payload is captured when staging completes and stays
    /// recorded for every later phase, including restoration.
    pub(super) fn payload_staged(self) -> bool {
        matches!(
            self,
            Self::Staged
                | Self::DisplaceIntent
                | Self::Displaced
                | Self::PublishIntent
                | Self::Published
                | Self::ParkIntent
                | Self::Parked
                | Self::RemoveIntent
                | Self::Removed
                | Self::RestoreIntent
                | Self::Restored
        )
    }

}

/// Mutable relocation evidence. Parked and displaced entries need no recorded
/// version: their exact identities are already immutable in `MoveSpec`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveState {
    /// Confirmed public-content transitions, matching the replacement counter.
    #[serde(default)]
    pub effect_revision: u64,
    pub source_root: Option<ObjectId>,
    pub target_root: Option<ObjectId>,
    pub phase: MovePhase,
    /// Only a cross-filesystem move stages an independent copied payload.
    pub staged: Option<super::durable_model::StagedPayload>,
    pub error: Option<String>,
}

impl Default for MoveState {
    fn default() -> Self {
        Self {
            effect_revision: 0,
            source_root: None,
            target_root: None,
            phase: MovePhase::Planned,
            staged: None,
            error: None,
        }
    }
}

#[cfg(unix)]
impl MoveState {
    pub(super) fn validate(
        &self,
        spec: &MoveSpec,
        resources: &[super::resources::Resource],
    ) -> io::Result<()> {
        let observed = self.phase.roots_observed();
        if self.source_root.is_some() != (observed && spec.source_root.is_some())
            || self.target_root.is_some() != (observed && spec.target_root.is_some())
            || self
                .error
                .as_ref()
                .is_some_and(|error| error.len() > super::durable_model::MAX_ERROR_BYTES)
        {
            return Err(invalid(
                "Move phase lacks its required artifact evidence or exceeds the error budget",
            ));
        }
        // A rename never stages a payload, and staging evidence must not appear
        // before its phase or survive a phase that has not observed it.
        let staged_required = self.phase.payload_staged() && spec.strategy == Strategy::CopyParked;
        if self.staged.is_some() != staged_required {
            return Err(invalid(
                "Move staging evidence disagrees with its strategy and phase",
            ));
        }
        // A move with no planned artifact root can only be the same-filesystem
        // fast path; it must never reach a phase that needs private storage.
        if spec.source_root.is_none()
            && spec.target_root.is_none()
            && !matches!(
                self.phase,
                MovePhase::Planned
                    | MovePhase::PublishIntent
                    | MovePhase::Published
                    | MovePhase::RestoreIntent
                    | MovePhase::Restored
            )
        {
            return Err(invalid(
                "Move without private storage cannot reach an artifact-bearing phase",
            ));
        }
        for (identity, plan, parent) in [
            (self.source_root, &spec.source_root, spec.source_parent),
            (self.target_root, &spec.target_root, spec.target_parent),
        ] {
            let (Some(identity), Some(plan)) = (identity, plan.as_ref()) else {
                continue;
            };
            spec.validate_root(resources, plan, parent, identity)?;
        }
        if let Some(staged) = &self.staged {
            staged.validate()?;
            let version = &staged.version;
            if !version.object.same_volume(spec.target_parent)
                || version.object == spec.target_parent
                || version.object == spec.source_version.object
                || Some(version.object) == self.target_root
                || Some(version.object) == self.source_root
                || spec
                    .target_original
                    .as_ref()
                    .is_some_and(|original| original.object == version.object)
            {
                return Err(invalid(
                    "Move staged payload aliases retained evidence or lies on another device",
                ));
            }
        }
        Ok(())
    }
}

impl MoveSpec {
    pub(super) fn roots(&self) -> impl Iterator<Item = &ArtifactPlan> {
        self.source_root.iter().chain(&self.target_root)
    }

    /// An observed artifact root must be a private sibling of its owning user
    /// entry: same volume as that parent, and never an alias of user data.
    #[cfg(unix)]
    pub(super) fn validate_root(
        &self,
        resources: &[super::resources::Resource],
        plan: &ArtifactPlan,
        parent: ObjectId,
        root: ObjectId,
    ) -> io::Result<()> {
        if !root.same_volume(parent)
            || root == parent
            || root == self.source_version.object
            || self
                .target_original
                .as_ref()
                .is_some_and(|original| original.object == root)
            || resources.iter().any(|resource| {
                resource.object == Some(root) && resource.path.0 != plan.path.0
            })
        {
            return Err(invalid(
                "Move artifact root aliases a user object or lies on another device",
            ));
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(super) fn validate(&self, resources: &[super::resources::Resource]) -> io::Result<()> {
        use super::resources::{Access, ConflictIndex, Resource, Scope};
        self.source_version.validate()?;
        if let Some(original) = &self.target_original {
            original.validate()?;
        }
        let cross_volume = !self.source_parent.same_volume(self.target_parent);
        if (self.strategy == Strategy::CopyParked) != cross_volume
            || self.source_root.is_some() != cross_volume
            || self.target_root.is_some() != (cross_volume || self.target_original.is_some())
        {
            return Err(invalid("Move strategy or artifact layout disagrees with its native volumes and overwrite intent"));
        }
        let mut unique = std::collections::BTreeSet::new();
        if resources
            .iter()
            .any(|resource| !unique.insert(&resource.path.0))
        {
            return Err(invalid("Move intent repeats a semantic resource path"));
        }
        let claim = |path: &NativePath,
                     parent: ObjectId,
                     object: Option<ObjectId>|
         -> io::Result<&Resource> {
            let resource = resources
                .iter()
                .find(|resource| {
                    &resource.path == path
                        && resource.scope == Scope::Subtree
                        && resource.access == Access::Write
                })
                .ok_or_else(|| invalid("Move intent lacks its required subtree write authority"))?;
            if resource.object != object
                || resource.ancestors.first() != Some(&parent)
                || path.0.parent().map(|parent| parent.ancestors().count())
                    != Some(resource.ancestors.len())
            {
                return Err(invalid(
                    "Move intent disagrees with its captured object or parent identity",
                ));
            }
            Ok(resource)
        };
        let source = claim(
            &self.source,
            self.source_parent,
            Some(self.source_version.object),
        )?;
        let target = claim(
            &self.target,
            self.target_parent,
            self.target_original.as_ref().map(|entry| entry.object),
        )?;
        if !self.source_version.object.same_volume(self.source_parent)
            || self
                .target_original
                .as_ref()
                .is_some_and(|entry| !entry.object.same_volume(self.target_parent))
        {
            return Err(invalid("Move entries disagree with their parent volumes"));
        }
        let mut index = ConflictIndex::default();
        index.insert(source);
        if index.conflicts(target) {
            return Err(invalid("Move source overlaps or aliases its target"));
        }
        index.insert(target);
        let mut tokens = std::collections::HashSet::new();
        for (plan, user_path, parent) in self
            .source_root
            .iter()
            .map(|root| (root, &self.source, self.source_parent))
            .chain(
                self.target_root
                    .iter()
                    .map(|root| (root, &self.target, self.target_parent)),
            )
        {
            if plan.token.len() != 64
                || !plan
                    .token
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !tokens.insert(&plan.token)
                || plan.path.0.parent() != user_path.0.parent()
                || plan.path.0.file_name()
                    != Some(OsStr::new(&format!(
                        ".tauri-explorer-recovery-{}",
                        plan.token
                    )))
            {
                return Err(invalid(
                    "Move artifact is not its exact native-planned private namespace",
                ));
            }
            let root = claim(&plan.path, parent, None)?;
            let user = if user_path == &self.source {
                source
            } else {
                target
            };
            if root.ancestors != user.ancestors {
                return Err(invalid(
                    "Move artifact ancestry differs from its owning parent",
                ));
            }
            if index.conflicts(root) {
                return Err(invalid(
                    "Move private artifact overlaps a selected entry or another artifact",
                ));
            }
            index.insert(root);
        }
        Ok(())
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_move_model.rs"]
mod tests;
