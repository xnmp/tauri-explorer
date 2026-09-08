//! Atomic admission for independently promotable operation children.
//! Capture user-volume bindings outside the gate; commit all children together.
use super::super::journal::NewRecord;
use super::*;

struct CapturedChild {
    resources: Vec<Resource>,
    request_count: usize,
}

impl Coordinator {
    pub(in crate::files::recovery) fn reserve(
        self: &Arc<Self>,
        requests: Vec<Request>,
    ) -> Result<Reservation, AppError> {
        self.reserve_batch(vec![requests])
            .map(|mut children| children.pop().expect("one requested child"))
    }

    /// Each returned child owns a disjoint write set and can independently
    /// promote into durable recovery. The caller owns every unstarted child.
    /// Order-dependent conflicts require a higher-level plan, never a bypass.
    pub(in crate::files::recovery) fn reserve_batch(
        self: &Arc<Self>,
        groups: Vec<Vec<Request>>,
    ) -> Result<Vec<Reservation>, AppError> {
        self.reserve_batch_with(groups, || {})
    }

    fn reserve_batch_with(
        self: &Arc<Self>,
        groups: Vec<Vec<Request>>,
        mut after_capture: impl FnMut(),
    ) -> Result<Vec<Reservation>, AppError> {
        if groups.is_empty() || groups.len() > MAX_RECORDS {
            return Err(invalid("Recovery batch has an invalid operation count"));
        }
        resources::validate_request_groups(&groups)?;
        for _ in 0..4 {
            let revision = self.admitted(|inner| inner.journal.revision())?;
            let captured = resources::capture_request_groups(&groups)
                .map(|captured| {
                    captured
                        .into_iter()
                        .zip(&groups)
                        .map(|(resources, requests)| CapturedChild {
                            resources,
                            request_count: requests.len(),
                        })
                        .collect()
                })
                .map_err(AppError::from);
            after_capture();
            if let Some(children) = self.try_reserve_batch_with(captured, revision, || {})? {
                return Ok(children);
            }
        }
        Err(invalid("Filesystem ownership changed repeatedly while preparing the operation; retry the request"))
    }

    #[cfg(test)]
    pub(super) fn reserve_with(
        self: &Arc<Self>,
        requests: Vec<Request>,
        after_capture: impl FnMut(),
    ) -> Result<Reservation, AppError> {
        self.reserve_batch_with(vec![requests], after_capture)
            .map(|mut children| children.pop().expect("one requested child"))
    }

    #[cfg(test)]
    pub(super) fn try_reserve_with(
        self: &Arc<Self>,
        resources: Result<Vec<Resource>, AppError>,
        captured_revision: u64,
        request_count: usize,
        after_claims: impl FnOnce(),
    ) -> Result<Option<Reservation>, AppError> {
        self.try_reserve_batch_with(
            resources.map(|resources| {
                vec![CapturedChild {
                    resources,
                    request_count,
                }]
            }),
            captured_revision,
            after_claims,
        )
        .map(|children| children.map(|mut children| children.pop().expect("one captured child")))
    }

    fn try_reserve_batch_with(
        self: &Arc<Self>,
        captured: Result<Vec<CapturedChild>, AppError>,
        captured_revision: u64,
        after_claims: impl FnOnce(),
    ) -> Result<Option<Vec<Reservation>>, AppError> {
        self.admitted(|inner| {
            let evidence = inner.catalog.records()?;
            let intents = decode_catalog(&evidence, &inner.protected)?;
            let mut rows = inner.journal.records()?;
            let mut ownership = inner.operation_claims(&intents, &rows, None)?;
            after_claims();
            for row in &rows {
                if row.kind == RecordKind::Reservation {
                    let record: ReservationRecord = decode(&row.payload)?;
                    validate_reservation(&row.id, &record)?;
                    match OperationLock::acquire(&inner.locks, &record.lock)? {
                        LockAttempt::Busy => {
                            ownership.references.insert(record.lock.name);
                            for resource in &record.resources { ownership.index.insert(resource); }
                        }
                        LockAttempt::Acquired(_abandoned) => { inner.journal.remove(&row.id, row.generation)?; }
                    }
                }
            }
            if inner.journal.revision()? != captured_revision { return Ok(None); }
            let captured = captured?;
            let mut siblings = ConflictIndex::default();
            for child in &captured {
                if child.resources.iter().any(|resource| ownership.index.conflicts(resource)) {
                    return Err(invalid("Another operation or unresolved recovery owns these files"));
                }
                if child.resources.iter().any(|resource| siblings.conflicts(resource)) {
                    return Err(invalid("Recovery batch children have overlapping write authority; explicit ordering is required"));
                }
                // Read/read overlap is allowed. Within one child, the existing
                // operation-specific validator still owns its internal semantics.
                for resource in &child.resources { siblings.insert(resource); }
            }
            inner.retire_unreferenced(&ownership.references)?;
            rows = inner.journal.records()?;
            if rows.len() + captured.len() > MAX_RECORDS {
                return Err(invalid("Recovery operation limit reached"));
            }
            let mut owned = Vec::with_capacity(captured.len());
            for child in captured {
                let owner = OperationLock::create(&inner.locks)?;
                let id = owner.identity.name.trim_end_matches(".lock").to_owned();
                let record = ReservationRecord { version: 1, resources: child.resources, lock: owner.identity.clone() };
                let payload = serde_json::to_vec(&record).map_err(|error| invalid(&error.to_string()))?;
                owned.push((owner, id, record.resources, child.request_count, payload));
            }
            let inputs: Vec<_> = owned.iter().map(|(_, id, _, _, payload)| NewRecord {
                id, kind: RecordKind::Reservation, payload,
            }).collect();
            let inserted = inner.journal.insert_batch(&inputs)?;
            Ok(Some(owned.into_iter().zip(inserted).map(|((owner, id, resources, request_count, _), row)| Reservation {
                coordinator: Arc::clone(self), owner, id, generation: row.generation, resources, request_count,
            }).collect()))
        })
    }
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_batch_admission.rs"]
mod tests;
