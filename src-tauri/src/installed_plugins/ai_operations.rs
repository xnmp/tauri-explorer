//! Explicit host recovery/disposition controls, independent of consumer frontend.
use super::{
    backend::{self, CallLease},
    job_bridge, package, service_bridge, service_host,
};
use crate::{
    error::AppError,
    service_state::{
        job::JobState,
        model::{Admission, PackageGeneration},
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
    let rows=store.retained_operations()?.into_iter().map(|(a,created,stopped)| {
        let receipt=store.provider_receipt(&a.consumer.package_id,&a.operation_id)?;
        let execution=receipt.as_ref().and_then(|r|r["execution"]["state"].as_str()).unwrap_or("unconfirmed");
        let delivery=receipt.as_ref().and_then(|r|r["delivery"]["state"].as_str()).unwrap_or("none");
        let consumer=compatible(&packages,&a.consumer);let provider=compatible(&packages,&a.provider);
        let reason=if stopped {"Automatic recovery stopped; unknown execution evidence is retained"}
            else if !provider {"Install or enable the original provider package to recover this operation"}
            else if !consumer {"Install or enable the original consumer package to recover its retained output"}
            else if execution=="unknown" {"Remote execution outcome is unknown; this operation will not be replayed"}
            else if delivery=="unavailable" {"Retained output is unavailable; resume original local recovery or explicitly discard it"}
            else {"The original operation is awaiting execution or local delivery reconciliation"};
        Ok(json!({"operationId":a.operation_id,"consumerPackage":a.consumer.package_id,"providerPackage":a.provider.package_id,"createdAtMs":(created!=0).then_some(created),"execution":execution,"delivery":delivery,"reason":reason,"canResume":consumer&&!stopped,"canDiscard":provider&&execution=="succeeded"&&matches!(delivery,"available"|"unavailable"),"canStop":provider&&execution=="unknown"&&delivery=="none"&&!stopped}))
    }).collect::<Result<Vec<_>,AppError>>()?;
    let migration=crate::ai::image_migration::status(&crate::config::config_dir()?).unwrap_or_else(|_|json!({"state":"pending","error":"Image migration storage requires repair; original settings are retained"}));
    Ok(json!({"version":1,"operations":rows,"migration":migration}))
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
    if !matches!(action, "resume" | "discard" | "stop") {
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
        service_bridge::reconcile_at(store, &provider.generation(), &a, &receipt)?;
        let released = store
            .get(consumer, operation)?
            .ok_or_else(|| error("Discard receipt disappeared"))?;
        if released.disposition.as_deref() != Some("discarded") {
            return Err(error(
                "Provider discard did not commit; retained bytes were not released",
            ));
        }
        if let Some(job) = store.job_for_operation(consumer, operation)? {
            if !job.state.terminal() {
                let updated=store.update_job(&job.owner,&job.job_key,JobState::NeedsAttention,Some("provider_result_discarded".into()),None,job.run_id,Some("Provider result explicitly discarded; awaiting original consumer reconciliation".into()))?;
                backend::emit_job_event(json!({"type":"updated","job":updated}));
            }
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
            backend::emit_job_event(json!({"type":"updated","job":job}));
        }
    }
    backend::emit_operations_changed();
    snapshot()
}
