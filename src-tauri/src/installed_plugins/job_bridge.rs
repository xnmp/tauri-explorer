//! Durable host-qualified jobs. Backend notifications never author ownership.
use super::{
    backend::{self, Broker, CallLease},
    service_host,
};
use crate::{
    error::AppError,
    service_state::{
        job::{JobRecord, JobState},
        model::PackageGeneration,
        Store,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
fn error(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}
fn opaque(bytes: usize) -> Result<String, AppError> {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value)
        .map_err(|_| error("Could not allocate background operation identity"))?;
    Ok(hex::encode(value))
}
static BOOT: OnceLock<String> = OnceLock::new();
static RECONCILER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
pub(super) fn origin(label: &str) -> Result<String, AppError> {
    if label.len() > 64
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(error("Invalid background operation window"));
    }
    if BOOT.get().is_none() {
        let _ = BOOT.set(opaque(24)?);
    }
    Ok(format!("{label}.{}", BOOT.get().expect("initialized")))
}
pub(super) fn register(
    owner: PackageGeneration,
    operation: &str,
    kind: &str,
    origin_window: &str,
) -> Result<JobRecord, AppError> {
    let store = service_host::store()?;
    for _ in 0..8 {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes)
            .map_err(|_| error("Could not allocate background operation ID"))?;
        let id = (u64::from_le_bytes(bytes) & ((1 << 51) - 1)) | (1 << 51);
        let timestamp = now();
        let record = JobRecord {
            job_key: opaque(24)?,
            owner: owner.clone(),
            operation_id: operation.into(),
            job_id: id,
            kind: kind.into(),
            label: if kind == "openai-image" {
                "AI image".into()
            } else {
                kind.into()
            },
            origin_window: origin_window.into(),
            revision: 0,
            source_revision: 0,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            state: JobState::Accepting,
            phase: Some("preparing".into()),
            output_path: None,
            run_id: None,
            error: None,
        };
        // Collision refusal happens before plugin dispatch. Never reuse a key.
        match store.register_job(record) {
            Ok(record) => {
                emit(&record);
                return Ok(record);
            }
            Err(cause) if cause.to_string().contains("identity already belongs") => continue,
            Err(cause) => return Err(cause),
        }
    }
    Err(error("Background operation identity capacity reached"))
}
fn emit(record: &JobRecord) {
    backend::emit_job_event(json!({"type":"updated","job":record}));
}
fn observe(record: &JobRecord, status: &Value) -> Result<JobRecord, AppError> {
    if status["jobId"].as_u64() != Some(record.job_id)
        || status["operationId"].as_str() != Some(&record.operation_id)
    {
        return Err(error("Consumer job receipt has a different native binding"));
    }
    let phase = status["recoveryState"].as_str().unwrap_or("recovering");
    let state = match status["status"].as_str() {
        Some("succeeded")
            if status["outputPath"].as_str().is_some_and(|v| !v.is_empty())
                && status["runId"].as_i64().is_some_and(|v| v > 0) =>
        {
            JobState::Completed
        }
        Some("failed") if status["providerExecution"]["state"] == "failed" => JobState::Error,
        Some("cancelled") => JobState::Cancelled,
        Some("discarded") => JobState::Discarded,
        Some("running") if phase != "needs_attention" => JobState::Running,
        Some("pending") => JobState::Accepting,
        _ if phase == "needs_attention" => JobState::NeedsAttention,
        _ => JobState::Recovering,
    };
    let output = if state == JobState::Completed {
        status["outputPath"].as_str().map(str::to_owned)
    } else {
        None
    };
    let message = status["error"].as_str().map(str::to_owned);
    let current = service_host::store()?
        .job(&record.job_key)?
        .ok_or_else(|| error("Background job is not retained"))?;
    if current.phase.as_deref() == Some("stopped")
        || current.phase.as_deref() == Some("provider_result_discarded")
            && state != JobState::Discarded
    {
        return Ok(current);
    }
    if current.run_id.is_some() && current.run_id != status["runId"].as_i64() {
        return Err(error("Consumer job receipt changed its original Trace run"));
    }
    service_host::store()?.observe_job(
        &record.owner,
        &record.job_key,
        status["revision"]
            .as_u64()
            .ok_or_else(|| error("Consumer job receipt has no revision"))?,
        state,
        Some(phase.into()),
        output,
        status["runId"].as_i64(),
        message,
    )
}
static STATUS_WORKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
struct StatusWorker(String);
impl Drop for StatusWorker {
    fn drop(&mut self) {
        STATUS_WORKERS
            .get()
            .expect("initialized")
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}
pub(super) fn schedule_status(broker: Arc<Broker>, record: JobRecord) {
    schedule_reconcile(Some(broker), record);
}
fn schedule_reconcile(broker: Option<Arc<Broker>>, record: JobRecord) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let workers = STATUS_WORKERS.get_or_init(Default::default);
    {
        let mut live = workers.lock().unwrap_or_else(|e| e.into_inner());
        if live.len() >= 8 || !live.insert(record.job_key.clone()) {
            return;
        }
    }
    let owned = StatusWorker(record.job_key.clone());
    let spawned = std::thread::Builder::new()
        .name("native-job-status".into())
        .spawn(move || {
            let _done = owned;
            let result = crate::native_deadline::scoped(deadline, || {
                let broker = match broker {
                    Some(broker) => broker,
                    None => backend::ensure(&record.owner.package_id)?,
                };
                let _lease = {
                    let _gate = super::read_lifecycle()?;
                    if !broker.is_active() {
                        return Err(error("Consumer unavailable"));
                    }
                    CallLease::acquire_method(&record.owner.package_id, "jobs.status")?
                };
                let current = broker.generation();
                if current.package_id != record.owner.package_id
                    || current.digest != record.owner.digest
                {
                    return Err(error("Consumer package changed"));
                }
                let status =
                    broker.call("jobs.status", json!({"operationId":record.operation_id}))?;
                if status.is_null() {
                    // A start still in flight in this process owns its answer,
                    // including one registered but not yet dispatched.
                    if broker.owns_job(record.job_id)
                        || now().saturating_sub(record.created_at_ms) < DISPATCH_GRACE_MS
                    {
                        return Err(error("Consumer is still accepting this operation"));
                    }
                    let settled = settle_unaccepted(
                        service_host::store()?,
                        &record,
                        &status,
                        &mut |method| {
                            broker.call(method, json!({"operationId":record.operation_id}))
                        },
                    )?
                    .ok_or_else(|| error("Consumer has not reported this operation"))?;
                    broker.finish_job(settled.job_id);
                    return Ok(settled);
                }
                let updated = observe(&record, &status)?;
                if updated.state.terminal() {
                    broker.finish_job(updated.job_id);
                }
                Ok::<_, AppError>(updated)
            });
            if let Ok(updated) = result {
                emit(&updated);
            }
        });
    if spawned.is_err() {
        backend::emit_operations_changed();
    }
}
pub(super) fn event(broker: Arc<Broker>, name: &str, payload: &Value) -> Result<(), AppError> {
    let Some(operation) = payload["operationId"].as_str() else {
        return Ok(());
    };
    let owner = broker.generation();
    let Some(record) = service_host::store()?.job_for_operation(&owner.package_id, operation)?
    else {
        return Ok(());
    };
    if owner.digest != record.owner.digest
        || payload["jobId"].as_u64() != Some(record.job_id)
        || ![
            format!("{}-complete", record.kind),
            format!("{}-error", record.kind),
            format!("{}-progress", record.kind),
        ]
        .iter()
        .any(|expected| expected == name)
    {
        return Err(error("Plugin event does not match its durable native job"));
    }
    if record.phase.as_deref() == Some("stopped") {
        return Ok(());
    }
    if name.ends_with("-progress") {
        if record.state.terminal() {
            return Ok(());
        }
        let updated = observe(&record, payload)?;
        emit(&updated);
    } else {
        schedule_status(broker, record);
    }
    Ok(())
}
pub(super) fn disconnected(owner: &PackageGeneration) {
    if let Ok(snapshot) = service_host::store().and_then(|s| s.snapshot_jobs()) {
        for record in snapshot.jobs.into_iter().filter(|r| {
            r.owner == *owner
                && !r.state.terminal()
                && !matches!(
                    r.phase.as_deref(),
                    Some("stopped" | "provider_result_discarded")
                )
        }) {
            if let Ok(record) = service_host::store().and_then(|s| {
                s.update_job(
                    &record.owner,
                    &record.job_key,
                    JobState::Recovering,
                    Some("recovering".into()),
                    None,
                    record.run_id,
                    None,
                )
            }) {
                emit(&record);
            }
        }
    }
}
pub(super) fn initialize() -> Result<(), AppError> {
    for record in service_host::store()?.recover_jobs(None)? {
        emit(&record)
    }
    // Snapshot/status reconciliation is unpaid and owns at most eight workers.
    // Attention records remain retained until an explicit recovery action.
    let mut reconciler = RECONCILER
        .lock()
        .map_err(|_| error("Background operation worker ownership is unavailable"))?;
    if reconciler.is_some() {
        return Ok(());
    }
    let worker = std::thread::Builder::new().name("native-job-reconciler".into()).spawn(|| {
        while !backend::is_closing() {
            if let Ok(snapshot)=service_host::store().and_then(|s|s.snapshot_jobs()) {
                for record in snapshot.jobs {
                    if record.state == JobState::NeedsAttention && unacknowledged(&record) {
                        // Probe only a consumer that is already running, e.g.
                        // after it restarts; never respawn one for attention.
                        if let Some(broker) = backend::active_instance(&record.owner.package_id, &record.owner.digest) {
                            schedule_reconcile(Some(broker), record);
                        }
                        continue;
                    }
                    if !matches!(record.state,JobState::Accepting|JobState::Running|JobState::Recovering) {
                        continue;
                    }
                    if now().saturating_sub(record.created_at_ms)>600_000 {
                        if let Ok(updated)=service_host::store().and_then(|s|s.update_job(&record.owner,&record.job_key,JobState::NeedsAttention,Some("needs_attention".into()),None,record.run_id,Some("Recovery requires attention; the original operation has not been replayed".into()))) {emit(&updated);}
                        continue;
                    }
                    schedule_reconcile(None,record);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }).map_err(|_| error("Background operation reconciliation worker could not start"))?;
    *reconciler = Some(worker);
    Ok(())
}
pub(super) fn shutdown() {
    let worker = {
        RECONCILER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take()
    };
    if let Some(worker) = worker {
        let _ = worker.join();
    }
}
pub(super) fn snapshot(label: &str) -> Result<Value, AppError> {
    let snapshot = service_host::store()?.snapshot_jobs()?;
    Ok(json!({"originWindow":origin(label)?,"watermark":snapshot.watermark,"jobs":snapshot.jobs}))
}
pub(super) fn cancel(key: &str) -> Result<Value, AppError> {
    let record = service_host::store()?
        .job(key)?
        .ok_or_else(|| error("Background operation is no longer retained"))?;
    if record.state.terminal() {
        return Ok(json!(record));
    }
    if record.phase.as_deref() == Some("stopped") {
        return Err(error("Automatic recovery was explicitly stopped; its unknown execution evidence remains retained"));
    }
    let broker = backend::ensure(&record.owner.package_id)?;
    if broker.generation().digest != record.owner.digest {
        return Err(error(
            "Enable the original consumer package before cancelling this operation",
        ));
    }
    let _lease = {
        let _gate = super::read_lifecycle()?;
        if !broker.is_active() {
            return Err(error("Consumer is unavailable"));
        }
        CallLease::acquire_method(&record.owner.package_id, "jobs.cancelOperation")?
    };
    broker.call(
        "jobs.cancelOperation",
        json!({"operationId":record.operation_id}),
    )?;
    schedule_status(broker, record.clone());
    Ok(json!(record))
}
pub(super) fn resume(key: &str) -> Result<Value, AppError> {
    let _action = super::ai_operations::action_guard()?;
    let record = service_host::store()?
        .job(key)?
        .ok_or_else(|| error("Background operation is no longer retained"))?;
    if record.state.terminal() {
        return Ok(json!(record));
    }
    if record.phase.as_deref() == Some("stopped") {
        return Err(error("Automatic recovery was explicitly stopped; its unknown execution evidence remains retained"));
    }
    let broker = backend::ensure(&record.owner.package_id)?;
    if broker.generation().digest != record.owner.digest {
        return Err(error(
            "Enable the original consumer package before recovering this operation",
        ));
    }
    let _lease = {
        let _gate = super::read_lifecycle()?;
        if !broker.is_active() {
            return Err(error("Consumer is unavailable"));
        }
        CallLease::acquire_method(&record.owner.package_id, "jobs.resumeOperation")?
    };
    broker.call(
        "jobs.resumeOperation",
        json!({"operationId":record.operation_id}),
    )?;
    let updated = service_host::store()?.update_job(
        &record.owner,
        &record.job_key,
        JobState::Recovering,
        Some("recovering".into()),
        None,
        record.run_id,
        None,
    )?;
    emit(&updated);
    schedule_status(broker, updated.clone());
    Ok(json!(updated))
}

/// The consumer never acknowledged this operation: no receipt revision was
/// observed and no run was pinned. Host-settled stop/discard is excluded.
fn unacknowledged(record: &JobRecord) -> bool {
    record.source_revision == 0
        && record.run_id.is_none()
        && matches!(
            record.state,
            JobState::Accepting | JobState::Recovering | JobState::NeedsAttention
        )
        && !matches!(
            record.phase.as_deref(),
            Some("stopped" | "provider_result_discarded")
        )
}
/// Longer than the SDK 3 reply deadline: an older unanswered start has failed
/// in its own caller, which settles or reconciles it.
const DISPATCH_GRACE_MS: u64 = 30_000;
const NOT_ACCEPTED: &str =
    "Image request was not accepted; nothing was started. Review its inputs and connection settings before retrying";
fn settle(store: &Store, record: &JobRecord) -> Result<JobRecord, AppError> {
    store.update_job(
        &record.owner,
        &record.job_key,
        JobState::Error,
        Some("not_accepted".into()),
        None,
        None,
        Some(NOT_ACCEPTED.into()),
    )
}
fn admitted(store: &Store, record: &JobRecord) -> Result<bool, AppError> {
    Ok(store
        .get(&record.owner.package_id, &record.operation_id)?
        .is_some())
}
/// Settles a job its consumer authoritatively does not know. The consumer
/// first fences the original operation ID, so no late or repeated start can
/// accept it, then must still report it unknown. A service admission means
/// the provider may have work: such a job is never settled here.
fn settle_unaccepted(
    store: &Store,
    record: &JobRecord,
    status: &Value,
    consumer: &mut dyn FnMut(&str) -> Result<Value, AppError>,
) -> Result<Option<JobRecord>, AppError> {
    let eligible = |store: &Store| -> Result<Option<JobRecord>, AppError> {
        match store.job(&record.job_key)? {
            Some(current) if unacknowledged(&current) && !admitted(store, &current)? => {
                Ok(Some(current))
            }
            _ => Ok(None),
        }
    };
    if !status.is_null() || eligible(store)?.is_none() {
        return Ok(None);
    }
    consumer("jobs.cancelOperation")?;
    if !consumer("jobs.status")?.is_null() {
        return Ok(None);
    }
    eligible(store)?
        .map(|current| settle(store, &current))
        .transpose()
}
/// A start refused before its request reached the backend is definite.
fn settle_unsent(store: &Store, record: &JobRecord) -> Result<Option<JobRecord>, AppError> {
    match store.job(&record.job_key)? {
        Some(current) if unacknowledged(&current) && !admitted(store, &current)? => {
            settle(store, &current).map(Some)
        }
        _ => Ok(None),
    }
}
pub(super) fn unsent(record: &JobRecord, broker: &Broker) -> Result<(), AppError> {
    if let Some(updated) = settle_unsent(service_host::store()?, record)? {
        broker.finish_job(record.job_id);
        emit(&updated);
    }
    Ok(())
}
/// A failed `jobs.start` whose request reached the backend. `current` is the
/// consumer that answered `status`, possibly a replacement after a crash.
pub(super) fn rejected(
    record: &JobRecord,
    current: &Broker,
    status: &Value,
) -> Result<(), AppError> {
    let generation = current.generation();
    if !current.is_active()
        || generation.package_id != record.owner.package_id
        || generation.digest != record.owner.digest
    {
        return Ok(());
    }
    if let Some(updated) =
        settle_unaccepted(service_host::store()?, record, status, &mut |method| {
            current.call(method, json!({"operationId":record.operation_id}))
        })?
    {
        backend::release_job(&record.owner, record.job_id);
        emit(&updated);
    }
    Ok(())
}
/// Dismissal removes presentation only; operation and receipt evidence stay.
pub(super) fn dismiss(key: &str) -> Result<Value, AppError> {
    let store = service_host::store()?;
    let record = store.job(key)?;
    if let Some(revision) = store.dismiss_job(key)? {
        if let Some(record) = record {
            backend::release_job(&record.owner, record.job_id);
        }
        backend::emit_job_event(json!({"type":"dismissed","jobKey":key,"revision":revision}));
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service_state::model::{Admission, AdmissionPhase, Limits, ServiceTarget};
    const OPERATION: &str = "0123456789abcdef0123456789abcdef";
    fn owner() -> PackageGeneration {
        PackageGeneration {
            package_id: "xnmp.trace-explorer".into(),
            digest: "a".repeat(64),
            incarnation: 7,
        }
    }
    fn fixture() -> (tempfile::TempDir, Store, JobRecord) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("service-state"), Limits::default()).unwrap();
        let created = now().saturating_sub(60_000);
        // Exactly what register() persists before dispatch.
        let record = store
            .register_job(JobRecord {
                job_key: opaque(24).unwrap(),
                owner: owner(),
                operation_id: OPERATION.into(),
                job_id: (1u64 << 51) | 5,
                kind: "openai-image".into(),
                label: "AI image".into(),
                origin_window: "main.x".into(),
                revision: 0,
                source_revision: 0,
                created_at_ms: created,
                updated_at_ms: created,
                state: JobState::Accepting,
                phase: Some("preparing".into()),
                output_path: None,
                run_id: None,
                error: None,
            })
            .unwrap();
        (dir, store, record)
    }
    /// A consumer that does not know the operation: it records every call.
    fn unknown<'a>(calls: &'a mut Vec<String>) -> impl FnMut(&str) -> Result<Value, AppError> + 'a {
        move |method| {
            calls.push(method.into());
            Ok(Value::Null)
        }
    }
    fn admit(store: &Store) {
        let provider = PackageGeneration {
            package_id: "xnmp.image-generation".into(),
            digest: "c".repeat(64),
            incarnation: 1,
        };
        store
            .reserve(Admission {
                consumer: owner(),
                provider: provider.clone(),
                target: ServiceTarget {
                    package_id: provider.package_id.clone(),
                    service_id: "image-generation".into(),
                    major: 1,
                },
                operation_id: OPERATION.into(),
                fingerprint: "b".repeat(64),
                phase: AdmissionPhase::Reserved,
                inputs: vec![],
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            })
            .unwrap();
        assert!(store.get(&owner().package_id, OPERATION).unwrap().is_some());
    }

    #[test]
    fn a_job_the_consumer_never_accepted_settles_after_its_fence_and_unblocks_the_package() {
        let (_dir, store, record) = fixture();
        // A crashed or timed-out start: the host saw no definite rejection.
        let attention = store
            .update_job(
                &record.owner,
                &record.job_key,
                JobState::NeedsAttention,
                Some("needs_attention".into()),
                None,
                None,
                Some("Recovery requires attention".into()),
            )
            .unwrap();
        assert!(store.busy("xnmp.trace-explorer").unwrap());
        let mut calls = vec![];
        let settled = settle_unaccepted(&store, &attention, &Value::Null, &mut unknown(&mut calls))
            .unwrap()
            .expect("settled");
        // The original ID is fenced before its absence is trusted.
        assert_eq!(calls, ["jobs.cancelOperation", "jobs.status"]);
        assert_eq!(settled.state, JobState::Error);
        assert_eq!(settled.phase.as_deref(), Some("not_accepted"));
        assert!(!store.busy("xnmp.trace-explorer").unwrap());
        assert!(store.dismiss_job(&settled.job_key).unwrap().is_some());
    }

    #[test]
    fn an_admitted_operation_is_never_settled_as_not_accepted() {
        let (_dir, store, record) = fixture();
        admit(&store);
        let mut calls = vec![];
        assert!(
            settle_unaccepted(&store, &record, &Value::Null, &mut unknown(&mut calls))
                .unwrap()
                .is_none()
        );
        assert!(settle_unsent(&store, &record).unwrap().is_none());
        assert_eq!(
            store.job(&record.job_key).unwrap().unwrap().state,
            JobState::Accepting
        );
        assert!(calls.is_empty());
    }

    #[test]
    fn only_an_authoritative_unknown_after_the_fence_settles() {
        let (_dir, store, record) = fixture();
        // Acknowledged at the fence: the consumer now owns its answer.
        let mut calls = 0;
        let mut acknowledged = |method: &str| {
            calls += 1;
            Ok(if method == "jobs.status" {
                json!({"jobId":record.job_id,"operationId":OPERATION,"status":"pending","revision":1})
            } else {
                Value::Null
            })
        };
        assert!(
            settle_unaccepted(&store, &record, &Value::Null, &mut acknowledged)
                .unwrap()
                .is_none()
        );
        assert_eq!(calls, 2);
        // The fence itself failed: no settlement from an unfenced absence.
        let mut unreachable =
            |_: &str| -> Result<Value, AppError> { Err(error("Plugin backend is unavailable")) };
        assert!(settle_unaccepted(&store, &record, &Value::Null, &mut unreachable).is_err());
        // A non-null first answer is a receipt for observe(), never a settlement.
        let mut calls = vec![];
        assert!(settle_unaccepted(
            &store,
            &record,
            &json!({"jobId":record.job_id,"operationId":OPERATION,"status":"running"}),
            &mut unknown(&mut calls)
        )
        .unwrap()
        .is_none());
        assert!(calls.is_empty());
        assert_eq!(
            store.job(&record.job_key).unwrap().unwrap().state,
            JobState::Accepting
        );
    }

    #[test]
    fn a_job_the_consumer_once_reported_is_never_settled_as_not_accepted() {
        let (_dir, store, record) = fixture();
        let observed = store
            .observe_job(
                &record.owner,
                &record.job_key,
                1,
                JobState::Recovering,
                Some("recovering".into()),
                None,
                None,
                None,
            )
            .unwrap();
        let mut calls = vec![];
        assert!(
            settle_unaccepted(&store, &observed, &Value::Null, &mut unknown(&mut calls))
                .unwrap()
                .is_none()
        );
        assert!(settle_unsent(&store, &observed).unwrap().is_none());
        assert!(calls.is_empty());
        assert_eq!(
            store.job(&record.job_key).unwrap().unwrap().state,
            JobState::Recovering
        );
    }

    #[test]
    fn a_start_refused_before_it_was_sent_settles_without_a_consumer() {
        let (_dir, store, record) = fixture();
        let settled = settle_unsent(&store, &record).unwrap().expect("settled");
        assert_eq!(settled.state, JobState::Error);
        assert_eq!(settled.phase.as_deref(), Some("not_accepted"));
        assert!(!store.busy("xnmp.trace-explorer").unwrap());
        // Settling again is a no-op, never a second terminal transition.
        assert!(settle_unsent(&store, &record).unwrap().is_none());
    }
}
