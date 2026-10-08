//! Native journal authority and record formats for the Unix recovery executor.
use super::checkpoint::{
    Checkpoint, DurableKind, Endpoint, Event, PlannedRoot, Shape, Side, State,
};
use super::model::NativePath;
use super::retention::Disposal;
pub(crate) use crate::files::{entry_version::EntryVersion, object_id::ObjectId};
use serde::{Deserialize, Serialize};

/// Every kind's intent and checkpoint format (ADR 0026). Versions 1 (copy) and
/// 2 (move) predate the unified checkpoint and are rejected, never migrated.
pub(super) const RECORD_VERSION: u32 = 3;

pub(super) const MAX_ERROR_BYTES: usize = 16 * 1024;

/// A recorded error cut to the journal's bound at a character boundary.
pub(super) fn bounded_error(mut message: String) -> String {
    let mut end = message.len().min(MAX_ERROR_BYTES);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message
}

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationRecord {
    pub intent: DurableIntent,
    pub state: State,
}

/// Mutable journal data binds to exact immutable catalog bytes. It deliberately
/// excludes paths and resource claims, which must not be rewritten per phase.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OperationCheckpoint {
    pub intent_digest: [u8; 32],
    pub state: State,
}

impl OperationSpec {
    /// The single dispatch point from catalog evidence to its kind (ADR 0026).
    pub(super) fn kind(&self) -> &dyn DurableKind {
        match self {
            Self::CopyReplacement(spec) => spec,
            Self::Move(spec) => spec,
        }
    }

    pub(super) fn replacement(&self) -> std::io::Result<&ReplacementSpec> {
        match self {
            Self::CopyReplacement(spec) => Ok(spec),
            _ => Err(invalid(
                "This authority cannot execute as a copy replacement",
            )),
        }
    }

    pub(super) fn move_spec(&self) -> std::io::Result<&super::move_model::MoveSpec> {
        match self {
            Self::Move(spec) => Ok(spec),
            _ => Err(invalid("This authority cannot execute as a move")),
        }
    }
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
        Self {
            intent,
            state: State::default(),
        }
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
        if !valid_token(&self.id) || self.lock.name != format!("{}.lock", self.id) {
            return Err(invalid(
                "Recovery intent has an invalid ID or owner binding",
            ));
        }
        self.lock.validate()?;
        super::resources::validate(&self.resources)?;
        // One format serves every kind; any other version, including a future
        // one, is rejected rather than guessed at.
        if self.version != RECORD_VERSION {
            return Err(invalid("Recovery intent has an unsupported record version"));
        }
        self.operation.kind().validate(&self.resources)
    }

    pub(super) fn checkpoint<'a>(
        &'a self,
        state: &'a State,
    ) -> Checkpoint<'a, dyn DurableKind + 'a> {
        Checkpoint {
            spec: self.operation.kind(),
            state,
        }
    }

    /// The one legal transition for every kind, from validated authority.
    pub(super) fn transition(&self, state: &State, event: Event) -> std::io::Result<State> {
        self.validate()?;
        self.checkpoint(state).next(event)
    }
}

/// A copy replacement: one private root beside its target holds the displaced
/// original, then the parked copy after restoration.
impl DurableKind for ReplacementSpec {
    fn shape(&self) -> Shape {
        Shape {
            stages: true,
            overwrites: true,
            parks: false,
            reapplies: true,
        }
    }

    fn root(&self, side: Side) -> Option<PlannedRoot<'_>> {
        (side == Side::Target).then_some(PlannedRoot {
            path: &self.root,
            token: &self.artifact_token,
            user: &self.target,
            parent: self.parent,
        })
    }

    fn probes(&self) -> Vec<PlannedRoot<'_>> {
        Vec::new()
    }

    fn subjects(&self) -> Vec<ObjectId> {
        vec![self.source_version.object, self.original.object]
    }

    fn parents(&self) -> Vec<ObjectId> {
        vec![self.parent]
    }

    fn source_version(&self) -> &EntryVersion {
        &self.source_version
    }

    fn displaced(&self) -> Option<&EntryVersion> {
        Some(&self.original)
    }

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

    /// `EntryVersion` is not a recursive snapshot, so an unchanged directory
    /// source cannot prove the parked copy redundant (ADR 0023).
    fn restored_disposal(&self) -> Disposal {
        if self.source_version.directory {
            Disposal::ExplicitOnly
        } else {
            Disposal::AutomaticWhenSourceIntact
        }
    }

    /// Only the destination proves a discard safe: the copy while it is
    /// published, the original once restored. The source may change freely.
    fn endpoints(&self, state: &State) -> std::io::Result<Vec<Endpoint<'_>>> {
        let versions = match (state.phase, &state.staged) {
            (super::checkpoint::Phase::Published, Some(staged)) => {
                vec![staged.version.clone(), staged.published_version()?]
            }
            (super::checkpoint::Phase::Restored, _) => vec![self.original.clone()],
            _ => return Err(invalid("Unsettled replacement has no retirement endpoints")),
        };
        Ok(vec![Endpoint {
            path: &self.target,
            parent: Some(self.parent),
            versions,
        }])
    }

    /// A parked copy is redundant only while its recorded source survives.
    fn witness(&self) -> Option<Endpoint<'_>> {
        Some(Endpoint {
            path: &self.source,
            parent: None,
            versions: vec![self.source_version.clone()],
        })
    }

    fn listed_path(&self) -> &NativePath {
        &self.target
    }
}

impl OperationRecord {
    pub(super) fn validate(&self) -> std::io::Result<()> {
        self.intent.validate()?;
        self.intent.checkpoint(&self.state).validate()
    }
}

impl OperationCheckpoint {
    pub(super) fn validate(&self, intent: &DurableIntent, digest: [u8; 32]) -> std::io::Result<()> {
        if self.intent_digest != digest {
            return Err(invalid(
                "Recovery checkpoint does not match its catalog evidence",
            ));
        }
        intent.validate()?;
        intent.checkpoint(&self.state).validate()
    }
}

impl LocalManifest {
    #[cfg(test)]
    pub(super) fn validate(&self, opened_root: ObjectId) -> std::io::Result<()> {
        self.intent.validate()?;
        let state = State::default();
        let checkpoint = self.intent.checkpoint(&state);
        let kind = self.intent.operation.kind();
        if ![Side::Source, Side::Target].into_iter().any(|side| {
            kind.root(side)
                .is_some_and(|root| checkpoint.validate_root(root.parent, self.root).is_ok())
        }) {
            return Err(invalid(
                "Recovery artifact root aliases a user object or lies on another device",
            ));
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
