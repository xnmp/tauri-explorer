//! Effective durable ownership used by ordinary admission and recovery claims.
use super::*;
use crate::files::recovery::artifact_layout::{ORIGINAL, PARKED, PUBLICATION};
use crate::files::recovery::checkpoint::{Side, State};
use crate::files::recovery::model::NativePath;

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
            let state = checkpoints
                .get(id.as_str())
                .map(|checkpoint| &checkpoint.state);
            let idle_completed = match state {
                Some(state) if entry.intent.checkpoint(state).completed() => {
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
            let artifacts = state.map_or_else(Vec::new, |state| {
                known_artifacts(&entry.intent, state, idle_completed)
            });
            // A completed record released its user endpoints: the source name is
            // free again and the destination belongs to the user. Only its
            // private roots and their retained payloads stay claimed.
            let public = (!idle_completed).then_some(&entry.intent.resources);
            for resource in public.into_iter().flatten().chain(&artifacts) {
                claims.index.insert(resource);
            }
        }
        Ok(claims)
    }
}

/// Validated checkpoints add identities unavailable to the immutable plan,
/// whose artifact roots were necessarily absent. These are exclusion claims,
/// never assertions that a named entry currently exists or effect capabilities.
/// A settled record claims only the payload it retains; any other position
/// claims every payload its roots can hold.
pub(super) fn known_artifacts(
    intent: &DurableIntent,
    state: &State,
    settled: bool,
) -> Vec<Resource> {
    let kind = intent.operation.kind();
    let checkpoint = intent.checkpoint(state);
    let mut claims = Vec::new();
    for (side, observed) in state.roots.iter() {
        let (Some(object), Some(planned)) = (observed, kind.root(side)) else {
            continue;
        };
        let Some(mut root) = intent
            .resources
            .iter()
            .find(|resource| &resource.path == planned.path)
            .cloned()
        else {
            continue;
        };
        root.object = Some(*object);
        let children: Vec<(&str, ObjectId)> = if settled {
            checkpoint
                .expected_payload(side)
                .ok()
                .flatten()
                .map(|(name, versions)| (name, versions[0].object))
                .into_iter()
                .collect()
        } else if side == Side::Source {
            let parked = kind.shape().parks.then(|| kind.source_version().object);
            parked.map(|object| (PARKED, object)).into_iter().collect()
        } else {
            let original = kind.displaced().map(|version| (ORIGINAL, version.object));
            let staged = state.staged.as_ref();
            original
                .into_iter()
                .chain(staged.map(|payload| (PUBLICATION, payload.version.object)))
                .collect()
        };
        for (name, object) in children {
            claims.push(Resource {
                path: NativePath(planned.path.0.join(name)),
                object: Some(object),
                ancestors: std::iter::once(root.object.expect("observed root"))
                    .chain(root.ancestors.iter().copied())
                    .collect(),
                access: resources::Access::Write,
                scope: resources::Scope::Subtree,
            });
        }
        claims.push(root);
    }
    claims
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_effective_claims.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../test_support/recovery_effective_claims_adversarial.rs"]
mod adversarial_tests;
