//! Effective durable ownership used by ordinary admission and recovery claims.
use super::*;
use crate::files::recovery::model::{NativePath, OperationState, Phase, ReplacementState};

pub(super) struct OperationClaims {
    pub(super) index: ConflictIndex,
    pub(super) references: HashSet<String>,
}

impl Inner {
    /// Called only within `Coordinator::admitted`: every path which acquires
    /// effect authority takes that same persistent gate before an owner lock.
    /// An idle-owner probe can therefore close immediately, keeping descriptor
    /// use constant even when the bounded catalog contains 1,024 operations.
    pub(super) fn operation_claims(
        &self,
        intents: &HashMap<String, CatalogIntent>,
        rows: &[super::super::journal::Record],
        exclude: Option<&str>,
    ) -> Result<OperationClaims, AppError> {
        let mut checkpoints = HashMap::new();
        for row in rows.iter().filter(|row| row.kind == RecordKind::Operation) {
            checkpoints.insert(row.id.as_str(), decode_checkpoint(row, intents)?);
        }
        let mut claims = OperationClaims {
            index: ConflictIndex::default(),
            references: HashSet::with_capacity(intents.len()),
        };
        claims.index.insert(&self.protected);
        for (id, entry) in intents {
            claims.references.insert(entry.intent.lock.name.clone());
            if exclude == Some(id.as_str()) {
                continue;
            }
            let checkpoint = checkpoints.get(id.as_str());
            let artifacts =
                checkpoint.and_then(|checkpoint| known_artifacts(&entry.intent, &checkpoint.state));
            let idle_completed = match checkpoint {
                Some(checkpoint) if completed(&checkpoint.state) => {
                    match OperationLock::acquire(&self.locks, &entry.intent.lock)? {
                        LockAttempt::Busy => false,
                        LockAttempt::Acquired(owner) => {
                            owner.verify(&self.locks)?;
                            drop(owner); // The admission gate still excludes new claimants.
                            true
                        }
                    }
                }
                _ => false,
            };
            if idle_completed {
                let state = checkpoint.unwrap().state.replacement()?;
                // Completed copying leaves the original private; completed
                // restoration leaves the copied publication private instead.
                let artifacts = artifacts.as_ref().expect("validated completed artifacts");
                let retained = if state.phase == Phase::Published {
                    &artifacts.original
                } else {
                    artifacts
                        .publication
                        .as_ref()
                        .expect("validated restored publication")
                };
                claims.index.insert(&artifacts.root);
                claims.index.insert(retained);
            } else {
                for resource in entry
                    .intent
                    .resources
                    .iter()
                    .chain(artifacts.iter().flat_map(ArtifactClaims::iter))
                {
                    claims.index.insert(resource);
                }
            }
        }
        Ok(claims)
    }
}

fn completed(state: &OperationState) -> bool {
    let Ok(state) = state.replacement() else {
        return false;
    };
    matches!(state.phase, Phase::Published | Phase::Restored) && state.error.is_none()
}

/// Validated checkpoints add identities unavailable to the immutable plan,
/// whose artifact root was necessarily absent. These are exclusion claims,
/// never assertions that a named entry currently exists or effect capabilities.
pub(super) struct ArtifactClaims {
    root: Resource,
    original: Resource,
    publication: Option<Resource>,
}

impl ArtifactClaims {
    pub(super) fn iter(&self) -> impl Iterator<Item = &Resource> {
        [
            Some(&self.root),
            Some(&self.original),
            self.publication.as_ref(),
        ]
        .into_iter()
        .flatten()
    }
}

pub(super) fn known_artifacts(
    intent: &DurableIntent,
    state: &OperationState,
) -> Option<ArtifactClaims> {
    let OperationState::Replacement(ReplacementState {
        root, published, ..
    }) = state
    else {
        return None;
    };
    let Some(root_object) = root else {
        return None;
    };
    let spec = intent.operation.replacement().ok()?;
    let mut root = intent
        .resources
        .iter()
        .find(|resource| resource.path == spec.root)
        .expect("validated replacement root claim")
        .clone();
    root.object = Some(*root_object);
    let child = |name: &str, object: ObjectId| Resource {
        path: NativePath(spec.root.0.join(name)),
        object: Some(object),
        ancestors: std::iter::once(*root_object)
            .chain(root.ancestors.iter().copied())
            .collect(),
        access: resources::Access::Write,
        scope: resources::Scope::Subtree,
    };
    let original = child("original", spec.original.object);
    let publication = published
        .as_ref()
        .map(|payload| child("publication", payload.version.object));
    Some(ArtifactClaims {
        root,
        original,
        publication,
    })
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_effective_claims.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../test_support/recovery_effective_claims_adversarial.rs"]
mod adversarial_tests;
