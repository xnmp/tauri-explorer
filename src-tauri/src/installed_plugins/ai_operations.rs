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
        receipt::{auto_settlement, dismissable, dismissal_holds, AutoSettlement},
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
/// A production process hosts one profile, so `ACTIONS` and the other
/// process-wide AI gates are never shared between independent ledgers. Test
/// profiles share one process: a fixture that drives those gates holds this
/// for its lifetime, or a parallel fixture's recovery work consumes its native
/// budget and automatic settlement is deferred (#1405). Threads inside one
/// fixture still race the real gates. Nested fixtures on one thread share it.
#[cfg(test)]
pub(super) type HostProfile = std::rc::Rc<std::sync::MutexGuard<'static, ()>>;
#[cfg(test)]
pub(super) fn exclusive_host_profile() -> HostProfile {
    static PROFILES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    thread_local! {
        static HELD: std::cell::RefCell<std::rc::Weak<std::sync::MutexGuard<'static, ()>>> =
            const { std::cell::RefCell::new(std::rc::Weak::new()) };
    }
    HELD.with(|held| {
        if let Some(profile) = held.borrow().upgrade() {
            return profile;
        }
        let profile = std::rc::Rc::new(PROFILES.lock().unwrap_or_else(|e| e.into_inner()));
        *held.borrow_mut() = std::rc::Rc::downgrade(&profile);
        profile
    })
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
/// One phase-independent replacement policy for lifecycle and both recovery
/// authorities. Original admission identities and the no-replay fence survive.
pub(super) fn replacement_recovers(manifest: &package::Manifest, a: &Admission) -> bool {
    (manifest.id != a.consumer.package_id
        || a.consumer.package_id == a.provider.package_id
        || super::service_graph::consumer_recovers(manifest, &a.target))
        && (manifest.id != a.provider.package_id
            || super::service_graph::provider_recovers(manifest, &a.target))
        && (manifest.id == a.consumer.package_id || manifest.id == a.provider.package_id)
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
/// Idle answers belong to the responding incarnation, not merely its package.
pub(super) fn verified_idle_generation(
    observed: &PackageGeneration,
    current: &PackageGeneration,
    idle: bool,
    live: bool,
) -> bool {
    observed == current && idle && live
}

pub(super) trait AutomaticPort {
    fn closing(&self) -> bool {
        false
    }
    fn active(
        &self,
        admission: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
    ) -> Result<bool, AppError>;
    /// The callback runs while both worker proofs and their admission fence
    /// remain owned. Implementations refresh authoritative provider status
    /// before invoking it; recovery is driven after this fence is dropped.
    fn with_activity(
        &self,
        _store: &crate::service_state::Store,
        admission: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
        apply: &mut dyn FnMut(bool) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let _fence = backend::IdleCallFence::acquire(&[
            &admission.consumer.package_id,
            &admission.provider.package_id,
        ])?;
        apply(self.active(admission, job, stopped, execution)?)
    }
    fn recover(&self, admission: &Admission, job: Option<&JobRecord>) -> Result<(), AppError>;
}
/// Run the same policy for live changes and startup backlog. Failure on one
/// operation leaves its durable evidence intact and does not block the rest.
pub(super) fn auto_reconcile_in(
    store: &crate::service_state::Store,
    port: &impl AutomaticPort,
) -> Result<Vec<JobRecord>, AppError> {
    // Pending collection remains quota-visible and is retried by the existing
    // two-second automatic sweep even when no recovery candidates remain.
    store.gc()?;
    store.sweep_host_spools(backend::generation_live)?;
    service_bridge::retry_removal_cancellations(store)?;
    auto_reconcile_candidates(store, port, store.auto_settlement_operations()?)
}
fn auto_reconcile_candidates(
    store: &crate::service_state::Store,
    port: &impl AutomaticPort,
    mut candidates: Vec<(Admission, u64, bool)>,
) -> Result<Vec<JobRecord>, AppError> {
    let mut settled = Vec::new();
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
            let job = store.job_for_operation(&a.consumer.package_id, &a.operation_id)?;
            {
                // Committed delivery is local authority to retire custody. Do
                // not let an unavailable provider or an expired RPC deadline
                // prevent proof-backed bookkeeping repair.
                let _fence = backend::IdleCallFence::acquire(&[
                    &a.consumer.package_id,
                    &a.provider.package_id,
                ])?;
                if let Some(completed) =
                    store.reconcile_terminal_job(&a.consumer.package_id, &a.operation_id)?
                {
                    settled.push(completed);
                    return Ok(());
                }
                if let Some(current) = store.get(&a.consumer.package_id, &a.operation_id)? {
                    if current.phase == crate::service_state::model::AdmissionPhase::Released {
                        // Release is custody bookkeeping, not presentation
                        // settlement. Never-forwarded intents have no provider
                        // execution to probe; finish through the idle/dispatch
                        // fence and its no-output checks, without prompting.
                        if current.disposition.as_deref() == Some("never_forwarded") {
                            if let Some(job) = service_bridge::settle_idle_dispatch(
                                store,
                                &a.consumer.package_id,
                                &a.operation_id,
                            )? {
                                settled.push(job);
                            }
                        }
                        if store
                            .job_for_operation(&a.consumer.package_id, &a.operation_id)?
                            .is_none_or(|job| job.state.terminal())
                        {
                            return Ok(());
                        }
                    }
                }
            }
            let mut recovery = None;
            port.with_activity(store, &a, job.as_ref(), stopped, execution, &mut |active| {
                if active
                    || service_bridge::dispatch_active(&a.consumer.package_id, &a.operation_id)?
                {
                    return Ok(());
                }
                if let Some(completed) =
                    store.reconcile_terminal_job(&a.consumer.package_id, &a.operation_id)?
                {
                    settled.push(completed);
                    return Ok(());
                }
                // Probes/status can advance the receipt and admission. Decide
                // from that latest evidence, never the pre-probe snapshot.
                let current = store
                    .get(&a.consumer.package_id, &a.operation_id)?
                    .ok_or_else(|| error("AI admission disappeared"))?;
                let receipt = store.provider_receipt(&a.consumer.package_id, &a.operation_id)?;
                if current.phase != crate::service_state::model::AdmissionPhase::Released
                    && receipt.as_ref().is_some_and(|r| {
                        r["execution"]["state"] == "succeeded"
                            && r["delivery"]["state"] == "unavailable"
                    })
                {
                    // Recover any validated original copy, including acquired
                    // consumer evidence. Loss only defers delivery; success can
                    // never authorize automatic discard.
                    if store
                        .recover_original_output(
                            &current.provider,
                            &current.consumer.package_id,
                            &current.operation_id,
                        )?
                        .is_none()
                    {
                        if let Some(job) = job.as_ref() {
                            if let Some(failed) = store.fail_output_delivery(job)? {
                                settled.push(failed);
                            }
                        }
                    }
                }
                let current = store
                    .get(&a.consumer.package_id, &a.operation_id)?
                    .ok_or_else(|| error("AI admission disappeared"))?;
                let execution = receipt
                    .as_ref()
                    .and_then(|r| r["execution"]["state"].as_str())
                    .unwrap_or("unconfirmed");
                let delivery = receipt
                    .as_ref()
                    .and_then(|r| r["delivery"]["state"].as_str())
                    .unwrap_or("none");
                if current.phase != crate::service_state::model::AdmissionPhase::Released
                    && store
                        .has_retained_output(&current.consumer.package_id, &current.operation_id)?
                {
                    // A validated original can precede receipt delivery.
                    // Drive only its original unpaid handoff; Unknown never
                    // authorizes another paid start.
                    recovery = Some(current);
                    return Ok(());
                }
                match auto_settlement(current.phase, execution, delivery, false) {
                    AutoSettlement::Leave => (),
                    AutoSettlement::Recover => recovery = Some(current),
                    AutoSettlement::Settle => {
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
            })?;
            if let Some(a) = recovery {
                // An unavailable delivery may have just finished its job as
                // Failed. Use that presentation to drive terminal handoff too.
                let job = store.job_for_operation(&a.consumer.package_id, &a.operation_id)?;
                port.recover(&a, job.as_ref())?;
            }
            Ok(())
        });
        if let Err(cause) = result {
            if matches!(&cause,AppError::Service { code,.. } if code=="storage_full") {
                if let Some(job) =
                    store.job_for_operation(&a.consumer.package_id, &a.operation_id)?
                {
                    settled.push(job);
                }
            }
            log::debug!(
                "Automatic AI settlement deferred for {}: {cause}",
                a.operation_id
            );
        }
    }
    Ok(settled)
}
pub(super) struct LiveAutomatic;
const RECONCILIATION_ATTEMPTS: usize = 3;
type ReconciliationKey = (String, String, String);
#[derive(Clone, Default)]
struct ReconciliationAttempt {
    startup_failures: usize,
    status_failures: usize,
    status_incarnation: Option<u64>,
}
#[derive(Clone, Copy)]
enum ReconciliationPhase {
    Startup,
    Status,
}
static RECONCILIATION_FAILURES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<ReconciliationKey, ReconciliationAttempt>>,
> = std::sync::LazyLock::new(Default::default);
fn reconciliation_key(a: &Admission) -> ReconciliationKey {
    (
        a.consumer.package_id.clone(),
        a.operation_id.clone(),
        a.provider.digest.clone(),
    )
}
fn reconciliation_attempt(a: &Admission) -> Result<ReconciliationAttempt, AppError> {
    Ok(RECONCILIATION_FAILURES
        .lock()
        .map_err(|_| error("Provider reconciliation ownership is unavailable"))?
        .get(&reconciliation_key(a))
        .cloned()
        .unwrap_or_default())
}
fn update_reconciliation(
    a: &Admission,
    update: impl FnOnce(&mut ReconciliationAttempt),
) -> Result<(), AppError> {
    // Completion must be recorded even when the RPC exhausted its deadline.
    // This mutex protects only bounded in-memory bookkeeping, never IO.
    let mut failures = RECONCILIATION_FAILURES
        .lock()
        .map_err(|_| error("Provider reconciliation ownership is unavailable"))?;
    update(failures.entry(reconciliation_key(a)).or_default());
    Ok(())
}
fn reconciliation_failed(a: &Admission, phase: ReconciliationPhase) -> Result<usize, AppError> {
    let mut result = 0;
    update_reconciliation(a, |attempt| {
        let count = match phase {
            ReconciliationPhase::Startup => &mut attempt.startup_failures,
            ReconciliationPhase::Status => &mut attempt.status_failures,
        };
        *count = count.saturating_add(1).min(RECONCILIATION_ATTEMPTS);
        result = *count;
    })?;
    Ok(result)
}
fn forget_reconciliation(a: &Admission) -> Result<(), AppError> {
    RECONCILIATION_FAILURES
        .lock()
        .map_err(|_| error("Provider reconciliation ownership is unavailable"))?
        .remove(&reconciliation_key(a));
    Ok(())
}
pub(super) fn reset_replacement_reconciliation(
    store: &crate::service_state::Store,
    package: &str,
) -> Result<(), AppError> {
    for a in store.package_operations(package)? {
        forget_reconciliation(&a)?;
    }
    Ok(())
}
impl ReconciliationAttempt {
    fn exhausted(&self) -> bool {
        self.startup_failures >= RECONCILIATION_ATTEMPTS
            || self.status_failures >= RECONCILIATION_ATTEMPTS
    }
}
fn output_free(store: &crate::service_state::Store, a: &Admission) -> Result<bool, AppError> {
    Ok(a.output.is_none()
        && !store.has_retained_output(&a.consumer.package_id, &a.operation_id)?
        && store
            .provider_receipt(&a.consumer.package_id, &a.operation_id)?
            .is_some_and(|r| {
                matches!(
                    r["execution"]["state"].as_str(),
                    Some("failed" | "cancelled")
                ) && r["delivery"]["state"] == "none"
            }))
}
impl AutomaticPort for LiveAutomatic {
    fn closing(&self) -> bool {
        backend::is_closing()
    }
    fn active(
        &self,
        _: &Admission,
        _: Option<&JobRecord>,
        _: bool,
        _: &str,
    ) -> Result<bool, AppError> {
        Err(error("Live worker proofs require scoped ownership"))
    }
    fn with_activity(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
        _job: Option<&JobRecord>,
        _stopped: bool,
        _execution: &str,
        apply: &mut dyn FnMut(bool) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        // A valid successful answer is custody evidence even when the host's
        // receipt transaction failed. Retry that observation before any new
        // unavailable-provider verdict; a storage error is not a failed answer.
        if let Some(receipt) = store.pending_success(a)? {
            if service_bridge::reconcile_at(store, &a.provider, a, &receipt).is_ok() {
                forget_reconciliation(a)?;
            }
            // Unsealed or lost evidence can be repaired by the next status
            // query. Keep the success witness until that repair commits.
        }
        // Native death proves inactivity, never absence of a retained result.
        // Start only the original provider's unpaid recovery before fencing
        // admission (activation cannot run while an IdleCallFence is held).
        let uncertain = !output_free(store, a)?;
        let installed_provider = if uncertain {
            installed()?
                .into_iter()
                .find(|p| p.manifest.id == a.provider.package_id)
        } else {
            None
        };
        let provider_present = installed_provider.is_some();
        let storage_blocked = store
            .job_for_operation(&a.consumer.package_id, &a.operation_id)?
            .is_some_and(|j| j.phase.as_deref() == Some("storage_full"));
        let retained_output = store.has_retained_output(&a.consumer.package_id, &a.operation_id)?
            || store.has_unbound_host_output(&a.provider)?
            || store.has_operation_unbound_host_output(&a.consumer.package_id, &a.operation_id)?;
        let mut provider_owner = a.provider.clone();
        let provider_compatible = installed_provider.as_ref().is_some_and(|p| {
            let current = PackageGeneration {
                digest: p.digest.clone(),
                ..a.provider.clone()
            };
            if p.enabled
                && service_bridge::recovery_provider(
                    store,
                    &p.manifest,
                    &current,
                    &a.consumer.package_id,
                    &a.operation_id,
                )
                .is_ok()
            {
                provider_owner = current;
                true
            } else {
                false
            }
        });
        let attempt = reconciliation_attempt(a)?;
        if provider_present
            && (!attempt.exhausted()
                || store.success_known(a)?
                || retained_output
                || storage_blocked)
            && (!provider_compatible || backend::ensure(&a.provider.package_id).is_err())
        {
            reconciliation_failed(a, ReconciliationPhase::Startup)?;
        }
        let _fence =
            backend::IdleCallFence::acquire(&[&a.consumer.package_id, &a.provider.package_id])?;
        let provider = backend::settlement_broker(&provider_owner)?;
        if provider.is_none() && provider_present && !reconciliation_attempt(a)?.exhausted() {
            return apply(true);
        }
        let consumer = if a.consumer.package_id != a.provider.package_id {
            let mut owner = a.consumer.clone();
            if let Some(p) = installed()?
                .into_iter()
                .find(|p| p.enabled && p.manifest.id == owner.package_id)
            {
                let current = PackageGeneration {
                    digest: p.digest.clone(),
                    ..owner.clone()
                };
                if service_bridge::recovery_caller(store, &p.manifest, &current, &a.operation_id)
                    .is_ok()
                {
                    owner = current;
                }
            }
            backend::settlement_broker(&owner)?
        } else {
            None
        };
        let mut leases = Vec::new();
        {
            let _gate = super::read_lifecycle()?;
            if let Some(broker) = &provider {
                if !broker.is_active() {
                    return apply(true);
                }
                leases.push(CallLease::acquire_method(
                    &a.provider.package_id,
                    "control.operationIdle",
                )?);
            }
            if let Some(broker) = &consumer {
                if !broker.is_active() {
                    return apply(true);
                }
                leases.push(CallLease::acquire_method(
                    &a.consumer.package_id,
                    "jobs.status",
                )?);
            }
        }
        if service_bridge::dispatch_active(&a.consumer.package_id, &a.operation_id)? {
            return apply(true);
        }
        if let Some(broker) = &provider {
            let observed_owner = broker.generation();
            let idle = broker.control_call(
                "control.operationIdle",
                json!({"consumerPackage":a.consumer.package_id,"operationId":a.operation_id}),
            )?;
            if !verified_idle_generation(
                &observed_owner,
                &broker.generation(),
                idle["idle"] == true && broker.owned_processes_idle(),
                broker.is_active(),
            ) {
                return apply(true);
            }
            // Status performs the provider's original local read/seal recovery
            // and reconciles a success whose separate publisher was delayed.
            let attempt = reconciliation_attempt(a)?;
            let incarnation = broker.generation().incarnation;
            if attempt.status_failures < RECONCILIATION_ATTEMPTS
                || attempt.status_incarnation != Some(incarnation)
                || store.success_known(a)?
                || retained_output
                || storage_blocked
            {
                let _output_recovery = store.output_recovery_guard(a)?;
                let mut sent = false;
                let status = broker.call_reporting("services.image-generation.v1.status", json!({"caller":{"packageId":a.consumer.package_id,"packageDigest":a.consumer.digest,"incarnation":a.consumer.incarnation},"request":{"operationId":a.operation_id}}), &mut sent)
                    .and_then(|receipt| crate::service_state::receipt::validate(&receipt, a));
                if sent {
                    update_reconciliation(a, |attempt| {
                        attempt.status_incarnation = Some(incarnation)
                    })?;
                }
                match status {
                    Ok(receipt) => {
                        if let Some(previous) = &store.pending_success(a)? {
                            if receipt["revision"].as_u64() < previous["revision"].as_u64()
                                || receipt["execution"]["state"] != "succeeded"
                            {
                                return apply(true);
                            }
                            if receipt["revision"] == previous["revision"] {
                                if &receipt != previous {
                                    return Err(error(
                                        "Provider success conflicts at the same revision",
                                    ));
                                }
                            } else {
                                crate::service_state::receipt::validate_transition(
                                    previous, &receipt,
                                )?;
                            }
                        }
                        let authority = service_bridge::recovery_provider(
                            store,
                            broker.manifest(),
                            &broker.generation(),
                            &a.consumer.package_id,
                            &a.operation_id,
                        )?;
                        service_bridge::reconcile_at(store, &authority, a, &receipt)?;
                        forget_reconciliation(a)?;
                    }
                    Err(cause) => {
                        let storage_full = storage_blocked
                            || matches!(&cause,AppError::Service { code,.. } if code=="storage_full");
                        // A sent RPC may consume its entire deadline. Record
                        // that completed attempt before deadline-bound store
                        // reads, so a fresh pass can prove inactivity without
                        // issuing an unbounded series of timed-out status RPCs.
                        let failures = if sent && !storage_full {
                            reconciliation_failed(a, ReconciliationPhase::Status)?
                        } else {
                            0
                        };
                        // A quota refusal is local delivery backpressure, not
                        // evidence that the original remote result is absent.
                        // Keep using the existing recovery passes after release.
                        if storage_full
                            || store
                                .job_for_operation(&a.consumer.package_id, &a.operation_id)?
                                .is_some_and(|j| j.phase.as_deref() == Some("storage_full"))
                        {
                            return Err(AppError::Service {
                                code: "storage_full".into(),
                                message:
                                    "AI image storage is full; recovery will retry automatically"
                                        .into(),
                            });
                        }
                        if !sent || failures < RECONCILIATION_ATTEMPTS {
                            return Err(cause);
                        }
                    }
                }
            }
        }
        if store.pending_success(a)?.is_some() {
            return apply(true);
        }
        if let Some(broker) = &consumer {
            let observed_owner = broker.generation();
            let status = broker.call("jobs.status", json!({"operationId":a.operation_id}))?;
            let idle = status.is_null()
                || status["operationId"].as_str() == Some(&a.operation_id)
                    && status["workerActive"] == false;
            if !verified_idle_generation(
                &observed_owner,
                &broker.generation(),
                idle,
                broker.is_active(),
            ) {
                return apply(true);
            }
        }
        if provider
            .iter()
            .chain(consumer.iter())
            .any(|broker| !broker.is_active())
        {
            return apply(true);
        }
        apply(false)?;
        if store.execution_released(&a.consumer.package_id, &a.operation_id)? {
            forget_reconciliation(a)?;
        }
        Ok(())
    }
    fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
        recover_in(service_host::store()?, a, job, &LiveRecovery)
    }
}

/// Recovery routing shared by the native RPC adapter and the model transport.
/// The adapter owns only the provider/consumer protocol; admission/receipt
/// reconciliation and the selected recovery route remain host decisions.
pub(super) trait RecoveryPort {
    fn provider_status(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
    ) -> Result<(PackageGeneration, Value), AppError>;
    fn resume(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
        job: &JobRecord,
    ) -> Result<(), AppError>;
    fn terminal_resume(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
        job: Option<&JobRecord>,
    ) -> Result<(), AppError>;
}
pub(super) fn recover_in(
    store: &crate::service_state::Store,
    a: &Admission,
    job: Option<&JobRecord>,
    port: &impl RecoveryPort,
) -> Result<(), AppError> {
    if a.consumer.package_id == a.provider.package_id {
        let (owner, receipt) = port.provider_status(store, a)?;
        service_bridge::reconcile_at(store, &owner, a, &receipt)?;
    } else if let Some(job) = job.filter(|j| !j.state.terminal()) {
        port.resume(store, a, job)?;
    } else {
        port.terminal_resume(store, a, job)?;
    }
    Ok(())
}
struct LiveRecovery;
impl RecoveryPort for LiveRecovery {
    fn provider_status(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
    ) -> Result<(PackageGeneration, Value), AppError> {
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
        let _output_recovery = store.output_recovery_guard(a)?;
        let receipt = broker.call("services.image-generation.v1.status", json!({"caller":{"packageId":a.consumer.package_id,"packageDigest":a.consumer.digest,"incarnation":a.consumer.incarnation},"request":{"operationId":a.operation_id}}))?;
        let authority = service_bridge::recovery_provider(
            store,
            broker.manifest(),
            &broker.generation(),
            &a.consumer.package_id,
            &a.operation_id,
        )?;
        Ok((authority, receipt))
    }
    fn resume(
        &self,
        _: &crate::service_state::Store,
        _: &Admission,
        job: &JobRecord,
    ) -> Result<(), AppError> {
        job_bridge::resume(&job.job_key).map(|_| ())
    }
    fn terminal_resume(
        &self,
        store: &crate::service_state::Store,
        a: &Admission,
        job: Option<&JobRecord>,
    ) -> Result<(), AppError> {
        // A finished presentation can still have an unacknowledged output.
        // Drive the original handoff while preserving its terminal job outcome.
        let broker = backend::ensure(&a.consumer.package_id)?;
        let _lease = {
            let _gate = super::read_lifecycle()?;
            if !broker.is_active()
                || service_bridge::recovery_caller(
                    store,
                    broker.manifest(),
                    &broker.generation(),
                    &a.operation_id,
                )?
                .digest
                    != a.consumer.digest
            {
                return Err(error("Original consumer is unavailable for local recovery"));
            }
            CallLease::acquire_method(&a.consumer.package_id, "jobs.resumeOperation")?
        };
        broker.call(
            "jobs.resumeOperation",
            json!({"operationId":a.operation_id}),
        )?;
        if let Some(job) = job {
            job_bridge::schedule_status(broker, job.clone());
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
/// Bootstrap holds the lifecycle write gate. Only definitive output-free
/// terminal evidence can settle here; uncertain outcomes await provider RPC.
pub(super) fn settle_stopped_backlog(store: &crate::service_state::Store) -> Result<(), AppError> {
    for (a, _, stopped) in store.auto_settlement_operations()? {
        if stopped && output_free(store, &a)? {
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
    service_bridge::recovery_provider(
        service_host::store()?,
        broker.manifest(),
        &broker.generation(),
        &a.consumer.package_id,
        &a.operation_id,
    )?;
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
