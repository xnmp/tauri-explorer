//! Native journal authority and checkpoints for the Unix recovery executor.
use super::model::NativePath;
pub(crate) use crate::files::{entry_version::EntryVersion, object_id::ObjectId};
use serde::{Deserialize, Serialize};

pub(super) const MAX_ERROR_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LockIdentity {
    pub name: String,
    pub object: ObjectId,
    pub nonce: String,
}

/// Common authority published before any user-volume recovery artifact exists.
/// Operation IDs belong to the native owner; artifact names have separate tokens
/// because their complete namespace must be planned before admission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurableIntent {
    pub version: u32,
    pub id: String,
    pub lock: LockIdentity,
    #[cfg(unix)]
    pub resources: Vec<super::resources::Resource>,
    pub operation: OperationSpec,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "spec",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum OperationSpec {
    CopyReplacement(ReplacementSpec),
    Move(super::move_model::MoveSpec),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReplacementSpec {
    pub artifact_token: String,
    pub source: NativePath,
    pub source_version: EntryVersion,
    pub target: NativePath,
    pub root: NativePath,
    pub parent: ObjectId,
    pub original: EntryVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalManifest {
    pub intent: DurableIntent,
    pub root: ObjectId,
}

impl LocalManifest {
    /// The intent's encoded bytes are embedded unchanged. Include the largest
    /// platform identity before accepting an operation whose root does not yet exist.
    pub(super) fn maximum_encoded_bytes(intent_bytes: usize) -> Option<usize> {
        intent_bytes
            .checked_add(b"{\"intent\":,\"root\":}".len())?
            .checked_add(ObjectId::MAX_ENCODED_BYTES)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
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
    RestoreIntent,
    Restored,
    ReapplyIntent,
    DiscardIntent,
    Discarded,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationRecord {
    pub intent: DurableIntent,
    pub state: OperationState,
}

/// Mutable journal data binds to exact immutable catalog bytes. It deliberately
/// excludes paths and resource claims, which must not be rewritten per phase.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationCheckpoint {
    pub intent_digest: [u8; 32],
    pub state: OperationState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "state",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum OperationState {
    Replacement(ReplacementState),
    Move(super::move_model::MoveState),
}

impl OperationSpec {
    pub(super) fn replacement(&self) -> std::io::Result<&ReplacementSpec> {
        match self {
            Self::CopyReplacement(spec) => Ok(spec),
            Self::Move(_) => Err(invalid(
                "Move authority cannot execute as a copy replacement",
            )),
        }
    }
}

impl OperationState {
    pub(super) fn replacement(&self) -> std::io::Result<&ReplacementState> {
        match self {
            Self::Replacement(state) => Ok(state),
            Self::Move(_) => Err(invalid(
                "Move checkpoint cannot execute as a copy replacement",
            )),
        }
    }

    pub(super) fn replacement_mut(&mut self) -> std::io::Result<&mut ReplacementState> {
        match self {
            Self::Replacement(state) => Ok(state),
            Self::Move(_) => Err(invalid(
                "Move checkpoint cannot execute as a copy replacement",
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReplacementState {
    /// Confirmed public-content transitions, independent of ownership claims.
    /// Legacy checkpoints have no history token and begin at revision zero.
    #[serde(default)]
    pub effect_revision: u64,
    /// Measured size of the currently retained private artifact, in bytes.
    /// Legacy checkpoints and every confirmed content transition are
    /// unmeasured: the retained artifact changes identity, so a previous
    /// measurement is evidence about a different payload (ADR 0023).
    #[serde(default)]
    pub retained_bytes: Option<u64>,
    pub root: Option<ObjectId>,
    pub phase: Phase,
    /// Captured when staging completes, before displacement. Identity alone
    /// does not prove that a later publication syscall completed.
    pub published: Option<StagedPayload>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StagedPayload {
    pub version: EntryVersion,
    /// A copied root directory stays owner-accessible while staged. Publication
    /// restores this mode through its retained handle before reporting completion.
    pub final_mode: Option<u32>,
}

#[cfg(unix)]
impl StagedPayload {
    pub(super) fn validate(&self) -> std::io::Result<()> {
        self.version.validate()?;
        let valid_mode = match self.final_mode {
            Some(mode) => {
                self.version.directory
                    && mode & !0o7777 == 0
                    && self.version.mode & 0o7777 == (mode | 0o700)
            }
            None => !self.version.directory,
        };
        if !valid_mode {
            return Err(invalid(
                "Staged payload lacks valid permission finalization evidence",
            ));
        }
        Ok(())
    }

    /// chmod changes ctime, which EntryVersion deliberately excludes. Preserve
    /// every observed payload field while deriving the recorded final mode.
    pub(super) fn published_version(&self) -> std::io::Result<EntryVersion> {
        self.validate()?;
        let mut version = self.version.clone();
        if let Some(mode) = self.final_mode {
            version.mode = (version.mode & !0o7777) | mode;
        }
        Ok(version)
    }
}

impl OperationRecord {
    pub(super) fn planned(intent: DurableIntent) -> Self {
        let state = match &intent.operation {
            OperationSpec::CopyReplacement(_) => OperationState::Replacement(ReplacementState {
                effect_revision: 0,
                retained_bytes: None,
                root: None,
                phase: Phase::Planned,
                published: None,
                error: None,
            }),
            OperationSpec::Move(_) => OperationState::Move(super::move_model::MoveState::default()),
        };
        Self { intent, state }
    }
}

impl LockIdentity {
    pub(super) fn validate(&self) -> std::io::Result<()> {
        let valid_hex = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if !self.name.strip_suffix(".lock").is_some_and(valid_hex) || !valid_hex(&self.nonce) {
            return Err(invalid("Recovery owner lock has an invalid name or nonce"));
        }
        Ok(())
    }
}

#[cfg(unix)]
impl DurableIntent {
    /// Validate durable data without probing a possibly missing user volume.
    pub(super) fn validate(&self) -> std::io::Result<()> {
        if self.version != 1
            || !valid_token(&self.id)
            || self.lock.name != format!("{}.lock", self.id)
        {
            return Err(invalid(
                "Recovery intent has an unsupported version, ID or owner binding",
            ));
        }
        self.lock.validate()?;
        super::resources::validate(&self.resources)?;
        match &self.operation {
            OperationSpec::CopyReplacement(spec) => spec.validate(&self.resources),
            OperationSpec::Move(spec) => spec.validate(&self.resources),
        }
    }
}

#[cfg(unix)]
impl ReplacementSpec {
    fn validate(&self, resources: &[super::resources::Resource]) -> std::io::Result<()> {
        use super::resources::{Access, ConflictIndex, Scope};
        use std::ffi::OsStr;
        if !valid_token(&self.artifact_token)
            || self.root.0.parent() != self.target.0.parent()
            || self.root.0.file_name()
                != Some(OsStr::new(&format!(
                    ".tauri-explorer-recovery-{}",
                    self.artifact_token
                )))
        {
            return Err(invalid(
                "Recovery replacement has an invalid artifact namespace",
            ));
        }
        self.original.validate()?;
        self.source_version.validate()?;
        let mut paths = std::collections::BTreeSet::new();
        if resources
            .iter()
            .any(|resource| !paths.insert(&resource.path.0))
        {
            return Err(invalid("Recovery intent repeats a semantic resource path"));
        }
        let claim = |path: &NativePath, write: bool| {
            resources
                .iter()
                .find(|resource| {
                    &resource.path == path
                        && resource.scope == Scope::Subtree
                        && (!write || resource.access == Access::Write)
                })
                .ok_or_else(|| {
                    invalid("Recovery intent lacks the required subtree resource authority")
                })
        };
        let source = claim(&self.source, false)?;
        let target = claim(&self.target, true)?;
        let root = claim(&self.root, true)?;
        if source.object != Some(self.source_version.object)
            || target.object != Some(self.original.object)
            || root.object.is_some()
            || target.ancestors.first() != Some(&self.parent)
            || root.ancestors.first() != Some(&self.parent)
            || root.ancestors != target.ancestors
            || [source, target, root].iter().any(|resource| {
                resource
                    .path
                    .0
                    .parent()
                    .map(|parent| parent.ancestors().count())
                    != Some(resource.ancestors.len())
            })
        {
            return Err(invalid(
                "Recovery intent disagrees with its captured parent or payload identities",
            ));
        }
        let mut index = ConflictIndex::default();
        index.insert(source);
        if index.conflicts(target) || index.conflicts(root) {
            return Err(invalid(
                "Recovery source overlaps its destination or private artifact root",
            ));
        }
        if self.target.0 == self.root.0 {
            return Err(invalid(
                "Recovery destination cannot be its private artifact root",
            ));
        }
        Ok(())
    }

    fn validate_root(
        &self,
        resources: &[super::resources::Resource],
        root: ObjectId,
    ) -> std::io::Result<()> {
        if !root.same_volume(self.parent)
            || root == self.parent
            || root == self.original.object
            || resources
                .iter()
                .any(|resource| resource.path == self.source && resource.object == Some(root))
        {
            return Err(invalid(
                "Recovery artifact root aliases a user object or lies on another device",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
impl OperationRecord {
    pub(super) fn validate(&self) -> std::io::Result<()> {
        self.intent.validate()?;
        self.state.validate(&self.intent)
    }
}

#[cfg(unix)]
impl OperationCheckpoint {
    pub(super) fn validate(&self, intent: &DurableIntent, digest: [u8; 32]) -> std::io::Result<()> {
        if self.intent_digest != digest {
            return Err(invalid(
                "Recovery checkpoint does not match its catalog evidence",
            ));
        }
        intent.validate()?;
        self.state.validate(intent)
    }
}

#[cfg(unix)]
impl OperationState {
    pub(super) fn validate(&self, intent: &DurableIntent) -> std::io::Result<()> {
        match (&intent.operation, self) {
            (OperationSpec::CopyReplacement(spec), Self::Replacement(state)) => {
                state.validate(spec, &intent.resources)
            }
            (OperationSpec::Move(_), Self::Move(_)) => Ok(()),
            _ => Err(invalid(
                "Recovery checkpoint kind disagrees with its immutable intent",
            )),
        }
    }
}

#[cfg(unix)]
impl ReplacementState {
    fn validate(
        &self,
        spec: &ReplacementSpec,
        resources: &[super::resources::Resource],
    ) -> std::io::Result<()> {
        let root_required = !matches!(self.phase, Phase::Planned | Phase::RootIntent);
        let publication_required = matches!(
            self.phase,
            Phase::Staged
                | Phase::DisplaceIntent
                | Phase::Displaced
                | Phase::PublishIntent
                | Phase::Published
                | Phase::RestoreIntent
                | Phase::Restored
                | Phase::ReapplyIntent
                | Phase::DiscardIntent
                | Phase::Discarded
        );
        // Only a settled retention phase holds a measurable private artifact.
        // `Discarded` has removed it, so a retained size there is contradictory.
        let measurable = matches!(
            self.phase,
            Phase::Published | Phase::Restored | Phase::DiscardIntent
        );
        if self.root.is_some() != root_required
            || publication_required && self.published.is_none()
            || !publication_required && self.published.is_some()
            || self.retained_bytes.is_some() && !measurable
            || self
                .error
                .as_ref()
                .is_some_and(|error| error.len() > MAX_ERROR_BYTES)
        {
            return Err(invalid(
                "Recovery phase lacks its required evidence or exceeds the error budget",
            ));
        }
        if let Some(root) = self.root {
            spec.validate_root(resources, root)?;
        }
        if let Some(published) = &self.published {
            published.validate()?;
            let published = &published.version;
            if !published.object.same_volume(spec.parent)
                || published.object == spec.original.object
                || published.object == spec.source_version.object
                || published.object == spec.parent
                || Some(published.object) == self.root
            {
                return Err(invalid(
                    "Recovery publication aliases retained evidence or lies on another device",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
impl LocalManifest {
    #[cfg(test)]
    pub(super) fn validate(&self, opened_root: ObjectId) -> std::io::Result<()> {
        self.intent.validate()?;
        match &self.intent.operation {
            OperationSpec::CopyReplacement(spec) => {
                spec.validate_root(&self.intent.resources, self.root)?
            }
            OperationSpec::Move(_) => {
                return Err(invalid(
                    "Move artifact manifests require their root-specific native owner",
                ))
            }
        }
        if self.root != opened_root {
            return Err(invalid(
                "Recovery manifest does not belong to the opened artifact root",
            ));
        }
        Ok(())
    }
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}
