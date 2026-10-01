//! Immutable relocation authority. A moved source is not an independent copy.
use super::checkpoint::{DurableKind, Endpoint, Phase, PlannedRoot, Shape, Side, State};
use super::model::{EntryVersion, NativePath, ObjectId};
use super::retention::Disposal;
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
    pub rename_probes: super::move_capability_model::Plans,
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

impl MoveSpec {
    pub(super) fn probe_plans(
        &self,
    ) -> impl Iterator<Item = (&ArtifactPlan, &NativePath, ObjectId)> {
        let plans = &self.rename_probes;
        std::iter::once((&plans.source, &self.source, self.source_parent)).chain(
            plans
                .target
                .iter()
                .map(|plan| (plan, &self.target, self.target_parent)),
        )
    }

    fn validate_spec(&self, resources: &[super::resources::Resource]) -> io::Result<()> {
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
        if self.rename_probes.target.is_some() != cross_volume {
            return Err(invalid("Rename probe coverage disagrees with move volumes"));
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
            .chain(self.probe_plans())
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

/// A relocation parks no artifact on the same filesystem: one rename publishes
/// it. Ordering is the crash contract: publication always precedes parking.
impl DurableKind for MoveSpec {
    fn shape(&self) -> Shape {
        let copying = self.strategy == Strategy::CopyParked;
        Shape {
            stages: copying,
            overwrites: self.target_original.is_some(),
            parks: copying,
            reapplies: false,
        }
    }

    fn root(&self, side: Side) -> Option<PlannedRoot<'_>> {
        let (plan, user, parent) = match side {
            Side::Source => (&self.source_root, &self.source, self.source_parent),
            Side::Target => (&self.target_root, &self.target, self.target_parent),
        };
        plan.as_ref().map(|plan| PlannedRoot {
            path: &plan.path,
            token: &plan.token,
            user,
            parent,
        })
    }

    fn probes(&self) -> Vec<PlannedRoot<'_>> {
        self.probe_plans()
            .map(|(plan, user, parent)| PlannedRoot {
                path: &plan.path,
                token: &plan.token,
                user,
                parent,
            })
            .collect()
    }

    fn subjects(&self) -> Vec<ObjectId> {
        std::iter::once(self.source_version.object)
            .chain(
                self.target_original
                    .as_ref()
                    .map(|original| original.object),
            )
            .collect()
    }

    fn source_version(&self) -> &EntryVersion {
        &self.source_version
    }

    fn displaced(&self) -> Option<&EntryVersion> {
        self.target_original.as_ref()
    }

    fn validate(&self, resources: &[super::resources::Resource]) -> io::Result<()> {
        self.validate_spec(resources)
    }

    /// A restored rename retains only verified residue. A copied directory or
    /// symlink cannot prove its parked publication redundant.
    fn restored_disposal(&self) -> Disposal {
        if self.strategy == Strategy::CopyParked
            && (self.source_version.directory || self.source_version.symlink)
        {
            Disposal::ExplicitOnly
        } else {
            Disposal::AutomaticWhenSourceIntact
        }
    }

    fn endpoints(&self, state: &State) -> io::Result<Vec<Endpoint<'_>>> {
        let (source, target) = if state.phase == Phase::Restored {
            (
                vec![self.source_version.clone()],
                self.target_original.iter().cloned().collect(),
            )
        } else {
            let published = match (self.strategy, &state.staged) {
                (Strategy::Rename, _) => self.source_version.clone(),
                (Strategy::CopyParked, Some(staged)) => staged.published_version()?,
                (Strategy::CopyParked, None) => return Err(invalid("Move has no staged evidence")),
            };
            (Vec::new(), vec![published])
        };
        Ok(vec![
            Endpoint {
                path: &self.source,
                parent: Some(self.source_parent),
                versions: source,
            },
            Endpoint {
                path: &self.target,
                parent: Some(self.target_parent),
                versions: target,
            },
        ])
    }

    fn listed_path(&self) -> &NativePath {
        &self.source
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_move_model.rs"]
mod tests;
