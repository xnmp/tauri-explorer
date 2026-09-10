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

/// Initial durable ownership has no user-file effects. Executable phases will
/// be admitted only with their corresponding native reconciliation support.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveState {}

impl MoveSpec {
    pub(super) fn roots(&self) -> impl Iterator<Item = &ArtifactPlan> {
        self.source_root.iter().chain(&self.target_root)
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
