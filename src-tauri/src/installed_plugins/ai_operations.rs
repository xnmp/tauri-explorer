//! Automatic host recovery/disposition and compatible backend controls.
use super::{
    backend::{self, CallLease},
    job_bridge, package, service_bridge, service_host,
};
use crate::{
    error::AppError,
    service_state::{
        job::{JobRecord, JobState},
        model::{Admission, PackageGeneration},
        receipt::{
            auto_settlement, dismissable, dismissal_holds, settlement_delivery, AutoSettlement,
        },
    },
};
use serde_json::{json, Value};
static ACTIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
thread_local! {static ACTION_DEPTH:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}
pub(super) struct ActionGuard {
    _guard: Option<std::sync::MutexGuard<'static, ()>>,
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        ACTION_DEPTH.set(ACTION_DEPTH.get() - 1);
    }
}
pub(super) fn action_guard() -> Result<ActionGuard, AppError> {
    let guard = if ACTION_DEPTH.get() == 0 {
        Some(crate::native_deadline::lock(
            &ACTIONS,
            "AI recovery action is unavailable",
        )?)
    } else {
        None
    };
    ACTION_DEPTH.set(ACTION_DEPTH.get() + 1);
    Ok(ActionGuard { _guard: guard })
}
fn error(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn installed() -> Result<Vec<package::Installed>, AppError> {
    let _gate = super::read_lifecycle()?;
    package::list(&super::root()?)
}
fn compatible(packages: &[package::Installed], generation: &PackageGeneration) -> bool {
    packages.iter().any(|p| {
        p.manifest.id == generation.package_id
            && p.enabled
            && p.digest == generation.digest
            && p.manifest.sdk_version >= 3
    })
}
pub(super) fn snapshot() -> Result<Value, AppError> {
    let store = service_host::store()?;
    let packages = installed()?;
    let rows = operation_rows(store, |generation| compatible(&packages, generation))?;
    let migration=crate::ai::image_migration::status(&crate::config::config_dir()?).unwrap_or_else(|_|json!({"state":"pending","error":"Image migration storage requires repair; original settings are retained"}));
    Ok(json!({"version":1,"operations":rows,"migration":migration}))
}
/// True only while a live job is still driving the operation: the job exists,
/// is not terminal, is not parked in `NeedsAttention`, recovery was not
/// stopped, and both pinned packages are installed and enabled (`drivable`), so
/// nothing waits on the user. Accepting/Running/Recovering are host-driven
/// progress; such an operation is in progress, not something to resolve.
pub(super) fn is_active(job: Option<JobState>, stopped: bool, drivable: bool) -> bool {
    drivable && !stopped && job.is_some_and(|s| !s.terminal() && s != JobState::NeedsAttention)
}
/// Unresolved-operation rows from durable host evidence alone; `available`
/// reports whether an exact pinned package generation is installed and enabled.
pub(super) fn operation_rows(
    store: &crate::service_state::Store,
    available: impl Fn(&PackageGeneration) -> bool,
) -> Result<Vec<Value>, AppError> {
    let mut rows = Vec::new();
    for (a, created, stopped) in store.retained_operations()? {
        let receipt = store.provider_receipt(&a.consumer.package_id, &a.operation_id)?;
        let execution = receipt
            .as_ref()
            .and_then(|r| r["execution"]["state"].as_str())
            .unwrap_or("unconfirmed");
        let delivery = receipt
            .as_ref()
            .and_then(|r| r["delivery"]["state"].as_str())
            .unwrap_or("none");
        if dismissal_holds(
            store.dismissed_revision(&a.consumer.package_id, &a.operation_id)?,
            receipt.as_ref().and_then(|r| r["revision"].as_u64()),
            stopped,
            execution,
            delivery,
        ) {
            continue;
        }
        let consumer = available(&a.consumer);
        let provider = available(&a.provider);
        let reason = if stopped {
            "Automatic recovery stopped; unknown execution evidence is retained"
        } else if !provider {
            "Install or enable the original provider package to recover this operation"
        } else if !consumer {
            "Install or enable the original consumer package to recover its retained output"
        } else if execution == "unknown" {
            "Remote execution outcome is unknown; this operation will not be replayed"
        } else if delivery == "unavailable" {
            "Retained output is unavailable; resume original local recovery or explicitly discard it"
        } else {
            "The original operation is awaiting execution or local delivery reconciliation"
        };
        let active = is_active(
            store
                .job_for_operation(&a.consumer.package_id, &a.operation_id)?
                .map(|j| j.state),
            stopped,
            consumer && provider,
        );
        rows.push(json!({"active":active,"operationId":a.operation_id,"consumerPackage":a.consumer.package_id,"providerPackage":a.provider.package_id,"createdAtMs":(created!=0).then_some(created),"execution":execution,"delivery":delivery,"reason":reason,"canResume":consumer&&!stopped,"canDiscard":provider&&execution=="succeeded"&&matches!(delivery,"available"|"unavailable"),"canStop":provider&&execution=="unknown"&&delivery=="none"&&!stopped,"canDismiss":dismissable(stopped,execution,delivery)}));
    }
    Ok(rows)
}
/// IO boundary for automatic disposition. No method can start generation.
pub(super) trait AutomaticPort {
    fn closing(&self) -> bool {
        false
    }
    fn discard(&self, _admission: &Admission) -> Result<(), AppError> {
        Err(error(
            "Original provider is unavailable for output disposition",
        ))
    }
    fn active(
        &self,
        admission: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
    ) -> Result<bool, AppError>;
    fn recover(&self, admission: &Admission, job: Option<&JobRecord>) -> Result<(), AppError>;
}
/// Run the same policy for live changes and startup backlog. Failure on one
/// operation leaves its durable evidence intact and does not block the rest.
pub(super) fn auto_reconcile_in(
    store: &crate::service_state::Store,
    port: &impl AutomaticPort,
) -> Result<Vec<JobRecord>, AppError> {
    let mut settled = Vec::new();
    let mut candidates = store.auto_settlement_operations()?;
    // A slow or unavailable original package must not monopolize each pass.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    if !candidates.is_empty() {
        let offset = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % candidates.len();
        candidates.rotate_left(offset);
    }
    candidates.sort_by_key(|(_, _, stopped)| !*stopped);
    for (a, _, stopped) in candidates {
        if port.closing() {
            break;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let result = crate::native_deadline::scoped(deadline, || -> Result<(), AppError> {
            let _action = action_guard()?;
            let receipt = store.provider_receipt(&a.consumer.package_id, &a.operation_id)?;
            let execution = receipt
                .as_ref()
                .and_then(|r| r["execution"]["state"].as_str())
                .unwrap_or("unconfirmed");
            let delivery = receipt
                .as_ref()
                .and_then(|r| r["delivery"]["state"].as_str())
                .unwrap_or("none");
            let job = store.job_for_operation(&a.consumer.package_id, &a.operation_id)?;
            if a.phase == crate::service_state::model::AdmissionPhase::Released
                && job.as_ref().is_some_and(|j| j.state == JobState::Completed)
            {
                return Ok(());
            }
            let active = port.active(&a, job.as_ref(), stopped, execution)?;
            let classified_delivery = receipt
                .as_ref()
                .map(|r| settlement_delivery(&r["delivery"]))
                .unwrap_or(delivery);
            let unavailable = classified_delivery == "unrecoverable";
            let decision = auto_settlement(a.phase, execution, classified_delivery, active);
            match decision {
                AutoSettlement::Leave => (),
                AutoSettlement::Recover => port.recover(&a, job.as_ref())?,
                AutoSettlement::Settle => {
                    if unavailable {
                        port.discard(&a)?;
                    }
                    if let Some(job) = service_bridge::settle_idle_dispatch(
                        store,
                        &a.consumer.package_id,
                        &a.operation_id,
                    )? {
                        settled.push(job);
                    }
                }
            }
            Ok(())
        });
        if let Err(cause) = result {
            log::debug!(
                "Automatic AI settlement deferred for {}: {cause}",
                a.operation_id
            );
        }
    }
    Ok(settled)
}
struct LiveAutomatic;
impl AutomaticPort for LiveAutomatic {
    fn closing(&self) -> bool {
        backend::is_closing()
    }
    fn discard(&self, a: &Admission) -> Result<(), AppError> {
        let broker = provider(a)?;
        let _lease = {
            let _gate = super::read_lifecycle()?;
            if !broker.is_active() {
                return Err(error("Original provider is unavailable"));
            }
            CallLease::acquire_method(&a.provider.package_id, "control.discardOperation")?
        };
        let receipt = broker.control_call(
            "control.discardOperation",
            json!({"consumerPackage":a.consumer.package_id,"operationId":a.operation_id}),
        )?;
        service_bridge::reconcile_at(service_host::store()?, &broker.generation(), a, &receipt)?;
        Ok(())
    }
    fn active(
        &self,
        a: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
    ) -> Result<bool, AppError> {
        if stopped {
            return Ok(false); // durable worker-termination proof from Stop
        }
        let packages = installed()?;
        if is_active(
            job.map(|j| j.state),
            false,
            compatible(&packages, &a.consumer) && compatible(&packages, &a.provider),
        ) && matches!(execution, "accepted" | "running" | "unconfirmed")
        {
            return Ok(true);
        }
        // A terminal provider outcome does not prove the consumer's local
        // publication has ended. Both proofs are held under call leases.
        if compatible(&packages, &a.provider) {
            let broker = provider(a)?;
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !broker.is_active() {
                    return Ok(true);
                }
                CallLease::acquire_method(&a.provider.package_id, "control.operationIdle")?
            };
            let idle = broker.control_call(
                "control.operationIdle",
                json!({"consumerPackage":a.consumer.package_id,"operationId":a.operation_id}),
            )?;
            if idle["idle"] != true || !broker.owned_processes_idle() {
                return Ok(true);
            }
        }
        if a.consumer.package_id != a.provider.package_id && compatible(&packages, &a.consumer) {
            let broker = backend::ensure(&a.consumer.package_id)?;
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !broker.is_active() || broker.generation().digest != a.consumer.digest {
                    return Ok(true);
                }
                CallLease::acquire_method(&a.consumer.package_id, "jobs.status")?
            };
            let status = broker.call("jobs.status", json!({"operationId":a.operation_id}))?;
            if !status.is_null()
                && (status["operationId"].as_str() != Some(&a.operation_id)
                    || status["workerActive"] != false)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
        if a.consumer.package_id == a.provider.package_id {
            let broker = provider(a)?;
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !broker.is_active() {
                    return Err(error("Original provider is unavailable"));
                }
                CallLease::acquire_method(
                    &a.provider.package_id,
                    "services.image-generation.v1.status",
                )?
            };
            let receipt = broker.call("services.image-generation.v1.status", json!({"caller":{"packageId":a.consumer.package_id,"packageDigest":a.consumer.digest,"incarnation":a.consumer.incarnation},"request":{"operationId":a.operation_id}}))?;
            service_bridge::reconcile_at(
                service_host::store()?,
                &broker.generation(),
                a,
                &receipt,
            )?;
        } else if let Some(job) = job.filter(|j| !j.state.terminal()) {
            job_bridge::resume(&job.job_key)?;
        } else {
            // A finished presentation can still have an unacknowledged output.
            // Drive the original handoff while preserving its terminal job outcome.
            let broker = backend::ensure(&a.consumer.package_id)?;
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !broker.is_active() || broker.generation().digest != a.consumer.digest {
                    return Err(error("Original consumer is unavailable for local recovery"));
                }
                CallLease::acquire_method(&a.consumer.package_id, "jobs.resumeOperation")?
            };
            broker.call(
                "jobs.resumeOperation",
                json!({"operationId":a.operation_id}),
            )?;
        }
        Ok(())
    }
}
pub(super) fn auto_reconcile() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let result = crate::native_deadline::scoped(deadline, || {
        service_host::store().and_then(|store| auto_reconcile_in(store, &LiveAutomatic))
    });
    if let Ok(jobs) = result {
        for job in jobs {
            backend::release_job(&job.owner, job.job_id);
            backend::emit_job_event(json!({"type":"updated","job":job}));
        }
    }
}
/// Bootstrap holds the lifecycle write gate: stopped records already carry
/// durable termination proof, so settle them without spawning plugin RPC.
pub(super) fn settle_stopped_backlog(store: &crate::service_state::Store) -> Result<(), AppError> {
    for (a, _, stopped) in store.auto_settlement_operations()? {
        if stopped {
            if let Some(job) =
                store.auto_settle_operation(&a.consumer.package_id, &a.operation_id, true)?
            {
                backend::emit_job_event(json!({"type":"updated","job":job}));
            }
        }
    }
    Ok(())
}
/// Commits the provider's discard receipt. Bytes and claims are released only
/// by that durable observation; a job awaiting its consumer is marked, never
/// fabricated as a consumer-side discard.
pub(super) fn commit_discard(
    store: &crate::service_state::Store,
    provider: &PackageGeneration,
    a: &Admission,
    receipt: &Value,
) -> Result<Option<crate::service_state::job::JobRecord>, AppError> {
    service_bridge::reconcile_at(store, provider, a, receipt)?;
    let released = store
        .get(&a.consumer.package_id, &a.operation_id)?
        .ok_or_else(|| error("Discard receipt disappeared"))?;
    if released.disposition.as_deref() != Some("discarded") {
        return Err(error(
            "Provider discard did not commit; retained bytes were not released",
        ));
    }
    match store.job_for_operation(&a.consumer.package_id, &a.operation_id)? {
        Some(job) if !job.state.terminal() => Ok(Some(store.update_job(&job.owner,&job.job_key,JobState::NeedsAttention,Some("provider_result_discarded".into()),None,job.run_id,Some("Provider result explicitly discarded; awaiting original consumer reconciliation".into()))?)),
        _ => Ok(None),
    }
}
fn provider(a: &Admission) -> Result<std::sync::Arc<backend::Broker>, AppError> {
    let broker = backend::ensure(&a.provider.package_id)?;
    if broker.generation().digest != a.provider.digest {
        return Err(error(
            "Enable the original provider package before resolving this operation",
        ));
    }
    Ok(broker)
}
pub(super) fn resolve(consumer: &str, operation: &str, action: &str) -> Result<Value, AppError> {
    let _action = action_guard()?;
    if !matches!(action, "resume" | "discard" | "stop" | "dismiss") {
        return Err(error("Unknown AI recovery action"));
    }
    let store = service_host::store()?;
    let a = store
        .get(consumer, operation)?
        .ok_or_else(|| error("AI operation is not retained"))?;
    if action == "resume" {
        if store.execution_released(consumer, operation)? {
            return Err(error(
                "Automatic recovery was explicitly stopped; its evidence is retained",
            ));
        }
        if a.consumer.package_id == a.provider.package_id {
            let provider = provider(&a)?;
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !provider.is_active() {
                    return Err(error("Provider is unavailable"));
                }
                CallLease::acquire_method(
                    &a.provider.package_id,
                    "services.image-generation.v1.status",
                )?
            };
            let receipt=provider.call("services.image-generation.v1.status",json!({"caller":{"packageId":a.consumer.package_id,"packageDigest":a.consumer.digest,"incarnation":a.consumer.incarnation},"request":{"operationId":operation}}))?;
            service_bridge::reconcile_at(store, &provider.generation(), &a, &receipt)?;
            return snapshot();
        }
        if let Some(job) = store.job_for_operation(consumer, operation)? {
            job_bridge::resume(&job.job_key)?;
        } else {
            let consumer = backend::ensure(consumer)?;
            if consumer.generation().digest != a.consumer.digest {
                return Err(error(
                    "Enable the original consumer package before resuming local recovery",
                ));
            }
            let _lease = {
                let _gate = super::read_lifecycle()?;
                if !consumer.is_active() {
                    return Err(error("Consumer is unavailable"));
                }
                CallLease::acquire_method(&a.consumer.package_id, "jobs.resumeOperation")?
            };
            consumer.call("jobs.resumeOperation", json!({"operationId":operation}))?;
        }
        return snapshot();
    }
    if action == "dismiss" {
        // Host-only: the provider's `acknowledge` releases a *successful*
        // output (it rejects anything else), and an unknown/none operation
        // has no retained provider state to release. The marker is the
        // host's own durable disposition; receipts stay untouched.
        if let Some(job) = store.dismiss_operation(consumer, operation)? {
            backend::emit_job_event(json!({"type":"updated","job":job}));
        }
        backend::emit_operations_changed();
        return snapshot();
    }
    let provider = provider(&a)?;
    let _lease = {
        let _gate = super::read_lifecycle()?;
        if !provider.is_active() {
            return Err(error("Provider is unavailable"));
        }
        CallLease::acquire_method(
            &a.provider.package_id,
            if action == "discard" {
                "control.discardOperation"
            } else {
                "control.operationIdle"
            },
        )?
    };
    if action == "discard" {
        // Host authorization follows operation-specific user intent. The provider
        // resolves its original candidate digest, never bytes supplied by UI.
        let receipt = provider.control_call(
            "control.discardOperation",
            json!({"consumerPackage":consumer,"operationId":operation}),
        )?;
        if let Some(updated) = commit_discard(store, &provider.generation(), &a, &receipt)? {
            backend::emit_job_event(json!({"type":"updated","job":updated}));
        }
    } else {
        let receipt=store.provider_receipt(consumer,operation)?.ok_or_else(||error("An authoritative unknown execution receipt is required before stopping recovery"))?;
        if receipt["execution"]["state"] != "unknown" || receipt["delivery"]["state"] != "none" {
            return Err(error(
                "Only unresolved unknown execution can stop automatic recovery",
            ));
        }
        let idle = provider.control_call(
            "control.operationIdle",
            json!({"consumerPackage":consumer,"operationId":operation}),
        )?;
        if idle["idle"] != true || !provider.owned_processes_idle() {
            return Err(error(
                "The provider still owns local work; wait for termination before stopping recovery",
            ));
        }
        if a.consumer.package_id != a.provider.package_id && compatible(&installed()?, &a.consumer)
        {
            let consumer_broker = backend::ensure(consumer)?;
            let _consumer_lease = {
                let _gate = super::read_lifecycle()?;
                if !consumer_broker.is_active()
                    || consumer_broker.generation().digest != a.consumer.digest
                {
                    return Err(error("Consumer is unavailable"));
                }
                CallLease::acquire_method(consumer, "jobs.status")?
            };
            let status = consumer_broker.call("jobs.status", json!({"operationId":operation}))?;
            if status["operationId"].as_str() != Some(operation) || status["workerActive"] != false
            {
                return Err(error("The consumer still owns local recovery work; wait for termination before stopping recovery"));
            }
        }
        let (_, updated) =
            store.stop_recovery(&provider.generation(), consumer, operation, true)?;
        if let Some(job) = updated {
            // No live worker was proven above; the stopped job holds nothing.
            backend::release_job(&job.owner, job.job_id);
            backend::emit_job_event(json!({"type":"updated","job":job}));
        }
    }
    backend::emit_operations_changed();
    snapshot()
}

#[cfg(test)]
mod active_tests {
    use super::{is_active, JobState};
    #[test]
    fn live_job_states_are_active() {
        for s in [JobState::Accepting, JobState::Running, JobState::Recovering] {
            assert!(is_active(Some(s), false, true), "{s:?}");
        }
    }
    #[test]
    fn no_job_is_not_active() {
        assert!(!is_active(None, false, true));
    }
    #[test]
    fn needs_attention_is_not_active() {
        assert!(!is_active(Some(JobState::NeedsAttention), false, true));
    }
    #[test]
    fn terminal_jobs_are_not_active() {
        for s in [
            JobState::Completed,
            JobState::Error,
            JobState::Cancelled,
            JobState::Discarded,
        ] {
            assert!(!is_active(Some(s), false, true), "{s:?}");
        }
    }
    #[test]
    fn stopped_recovery_is_not_active() {
        assert!(!is_active(Some(JobState::Recovering), true, true));
        assert!(!is_active(Some(JobState::Running), true, true));
    }
    #[test]
    fn a_job_whose_package_is_missing_is_not_active() {
        for s in [JobState::Accepting, JobState::Running, JobState::Recovering] {
            assert!(!is_active(Some(s), false, false), "{s:?}");
        }
    }
}
