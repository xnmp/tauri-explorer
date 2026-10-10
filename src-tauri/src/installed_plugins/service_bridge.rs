//! Native-derived identities and bounded reverse workers. The stdout reader
//! never waits for a provider that may itself call back into this host.
use super::{
    backend::{self, Broker},
    package, service_graph, service_host,
};
use crate::{error::AppError, service_state::model::*};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
static WORKERS: [AtomicUsize; 3] = [
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
];
// A death snapshot and creation of forwarding ownership must not cross.
// This gate covers only native ledger admission/snapshot, never callbacks or IO.
static ADMISSION: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct IoLease(usize);
static IO: [(std::sync::Mutex<usize>, std::sync::Condvar); 2] = [
    (std::sync::Mutex::new(0), std::sync::Condvar::new()),
    (std::sync::Mutex::new(0), std::sync::Condvar::new()),
];
impl IoLease {
    fn acquire(lane: usize, alive: impl Fn() -> bool) -> Result<Self, AppError> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let (mutex, changed) = &IO[lane];
        let mut active = mutex.lock().unwrap_or_else(|cause| cause.into_inner());
        while *active >= [2, 4][lane] {
            if !alive() {
                return Err(error("Native artifact caller disconnected while queued"));
            }
            if std::time::Instant::now() >= deadline {
                return Err(error("Native artifact IO queue deadline reached"));
            }
            active = changed
                .wait_timeout(active, std::time::Duration::from_millis(50))
                .unwrap_or_else(|cause| cause.into_inner())
                .0;
        }
        if !alive() {
            return Err(error("Native artifact caller disconnected before IO"));
        }
        *active += 1;
        Ok(Self(lane))
    }
}
impl Drop for IoLease {
    fn drop(&mut self) {
        let (mutex, changed) = &IO[self.0];
        *mutex.lock().unwrap_or_else(|cause| cause.into_inner()) -= 1;
        changed.notify_one();
    }
}
fn error(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, AppError> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| error("Malformed service request"))
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, AppError> {
    serde_json::from_value(value).map_err(|_| error("Malformed service request"))
}
fn encoded(value: impl serde::Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|_| error("Service response serialization failed"))
}
struct Permit {
    broker: Arc<Broker>,
    lane: usize,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.broker.reverse_pending[self.lane].fetch_sub(1, Ordering::AcqRel);
        WORKERS[self.lane].fetch_sub(1, Ordering::AcqRel);
    }
}
fn permit(broker: Arc<Broker>, lane: usize) -> Result<Permit, AppError> {
    if WORKERS[lane].fetch_add(1, Ordering::AcqRel) >= [64, 16, 32][lane] {
        WORKERS[lane].fetch_sub(1, Ordering::AcqRel);
        return Err(error("Service worker capacity reached"));
    }
    if broker.reverse_pending[lane].fetch_add(1, Ordering::AcqRel) >= [8, 8, 16][lane] {
        broker.reverse_pending[lane].fetch_sub(1, Ordering::AcqRel);
        WORKERS[lane].fetch_sub(1, Ordering::AcqRel);
        return Err(error("Caller service capacity reached"));
    }
    Ok(Permit { broker, lane })
}
pub(super) fn handle(broker: Arc<Broker>, frame: Value) -> Result<(), AppError> {
    handle_inner(broker, frame, true)
}
pub(super) fn event_update(broker: Arc<Broker>, payload: Value) -> Result<(), AppError> {
    handle_inner(
        broker,
        json!({"id":"host:event-update","method":"host.services.provider.update","params":payload}),
        false,
    )
}
fn handle_inner(broker: Arc<Broker>, frame: Value, reply: bool) -> Result<(), AppError> {
    let id = frame["id"]
        .as_str()
        .filter(|id| id.starts_with("host:") && id.len() <= 128)
        .ok_or_else(|| error("Invalid reverse service request ID"))?
        .to_owned();
    let method = text(&frame, "method")?.to_owned();
    let params = frame["params"].clone();
    let callback = matches!(
        method.as_str(),
        "host.services.test.update"
            | "host.services.provider.update"
            | "host.artifacts.acquired"
            | "host.artifacts.release"
            | "host.artifacts.read"
            | "host.artifacts.stage"
            | "host.artifacts.seal"
            | "host.credentials.get"
    );
    let control = method == "host.services.invoke"
        && matches!(
            params["method"].as_str(),
            Some("status" | "cancel" | "acknowledge")
        );
    let recovery_allowed = matches!(
        method.as_str(),
        "host.services.test.update"
            | "host.services.provider.update"
            | "host.artifacts.acquired"
            | "host.artifacts.read"
    ) || method == "host.services.invoke"
        && matches!(
            params["method"].as_str(),
            Some("status" | "cancel" | "acknowledge")
        );
    let lane = if callback { 2 } else { usize::from(control) };
    let admission = permit(broker.clone(), lane);
    match admission {
        Ok(permit) => {
            let rejected_owner = broker.clone();
            let rejected_id = id.clone();
            let worker = backend::spawn_worker("plugin-reverse-service", move || {
                let result = (|| {
                    let lease = {
                        let _gate = super::read_lifecycle()?;
                        if !(broker.is_active() || recovery_allowed && broker.can_recover()) {
                            return Err(error("Plugin service caller is not active"));
                        }
                        backend::CallLease::acquire_direction(&broker.manifest().id, lane)?
                    };
                    let result = dispatch(&broker, &method, params);
                    drop(lease);
                    result
                })();
                if !reply {
                    if let Ok(result) = &result {
                        broker.emit_service_update(
                            result["consumerPackageId"].clone(),
                            result["status"].clone(),
                        );
                    }
                }
                let frame = match result {
                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(cause) => {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":cause.to_string(),"data":{"code":cause.service_code()}}})
                    }
                };
                if reply {
                    let _ = broker.send(&frame);
                }
                drop(permit);
            });
            if worker.is_err() {
                // Builder drops the closure and its Permit before returning.
                // No provider dispatch occurred; durable claims stay retained.
                if reply {
                    rejected_owner.send(&json!({"jsonrpc":"2.0","id":rejected_id,"error":{"code":-32002,"message":"Native service worker could not be started","data":{"code":"worker_failed"}}}))?;
                } else {
                    backend::emit_operations_changed();
                }
            }
        }
        Err(cause) => {
            if reply {
                broker.send(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":cause.to_string(),"data":{"code":"capacity_reached"}}}))?;
            }
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invocation {
    package_id: String,
    service_id: String,
    major: u32,
    method: String,
    params: Value,
}

fn dispatch(broker: &Arc<Broker>, method: &str, params: Value) -> Result<Value, AppError> {
    // Bulk capture never consumes callback IO capacity needed to seal/read an
    // already-admitted result. Permits survive blocking native IO and timeout.
    let _io = if method == "host.artifacts.capture" {
        Some(IoLease::acquire(0, || broker.can_recover())?)
    } else if matches!(
        method,
        "host.artifacts.seal" | "host.artifacts.read" | "host.artifacts.acquired"
    ) {
        Some(IoLease::acquire(1, || broker.can_recover())?)
    } else {
        None
    };
    if !broker.can_recover() {
        return Err(error("Service owner disconnected before native IO"));
    }
    let caller = broker.generation();
    let store = service_host::store()?;
    match method {
        "host.services.describe" => {
            let target: ServiceTarget = decode(params)?;
            if target.service_id != "image-generation" || target.major != 1 {
                return Ok(
                    json!({"version":1,"available":false,"target":target,"reason":{"code":"unsupported_service","message":"This host does not support the requested service protocol"}}),
                );
            }
            let _gate = super::read_lifecycle()?;
            let entries = package::list(&super::root()?)?;
            let selected = service_graph::select(
                &entries,
                broker.manifest(),
                &target.package_id,
                &target.service_id,
                target.major,
            );
            Ok(match selected {
                Ok((provider, _)) => {
                    json!({"version":1,"available":true,"target":target,"providerDigest":provider.digest})
                }
                Err(_) => {
                    json!({"version":1,"available":false,"target":target,"reason":{"code":"service_unavailable","message":"Image Generation package is missing, disabled or incompatible"}})
                }
            })
        }
        "host.services.invoke" => invoke(broker, decode(params)?),
        "host.services.test.context" => {
            test_provider(broker)?;
            Ok(
                json!({"caller":{"packageId":caller.package_id,"packageDigest":caller.digest,"incarnation":caller.incarnation}}),
            )
        }
        "host.services.provider.update" => {
            test_provider(broker)?;
            let consumer = text(&params, "consumerPackageId")?;
            let operation = text(&params["status"], "operationId")?;
            let admission = store.verify_provider(&caller, consumer, operation)?;
            let status = reconcile_receipt(store, &caller, &admission, &params["status"])?;
            Ok(json!({"updated":true,"consumerPackageId":consumer,"status":status}))
        }
        "host.services.test.begin" => {
            let _admission = ADMISSION.lock().unwrap_or_else(|cause| cause.into_inner());
            if !broker.can_recover() {
                return Err(error("Connection test owner disconnected before admission"));
            }
            test_provider(broker)?;
            let operation = text(&params, "operationId")?;
            let fingerprint = text(&params, "effectiveRecipeDigest")?;
            let inputs: Vec<ArtifactDescriptor> = decode(params["inputs"].clone())?;
            if !inputs.is_empty() {
                return Err(error("Connection tests cannot capture input files"));
            }
            let target = ServiceTarget {
                package_id: caller.package_id.clone(),
                service_id: "image-generation".into(),
                major: 1,
            };
            let a = store.reserve(Admission {
                consumer: caller.clone(),
                provider: caller.clone(),
                target,
                operation_id: operation.into(),
                fingerprint: fingerprint.into(),
                phase: AdmissionPhase::Reserved,
                inputs,
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            })?;
            let winner = if a.phase == AdmissionPhase::Reserved {
                store.claim_forwarding(&caller, operation)?.1
            } else {
                false
            };
            if !winner {
                return Err(AppError::MutationUncertain("Connection test forwarding was already recorded; inspect the original operation before testing again".into()));
            }
            Ok(
                json!({"accepted":true,"caller":{"packageId":caller.package_id,"packageDigest":caller.digest,"incarnation":caller.incarnation}}),
            )
        }
        "host.services.test.update" => {
            test_provider(broker)?;
            let operation = text(&params, "operationId")?;
            let a = store.verify_provider(&caller, &caller.package_id, operation)?;
            reconcile(&caller, &a, &params["status"])?;
            Ok(json!({"updated":true}))
        }
        "host.artifacts.capture" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Capture {
                operation_id: String,
                inputs: Vec<CaptureInput>,
            }
            let request: Capture = decode(params)?;
            let inputs = store.capture(&caller, &request.operation_id, request.inputs)?;
            if !broker.can_recover() {
                let _ = store.release_preparations(&caller);
                return Err(error("Capture owner disconnected"));
            }
            Ok(json!({"inputs":inputs}))
        }
        "host.artifacts.stage" => encoded(store.stage(
            &caller,
            text(&params, "consumerPackageId")?,
            text(&params, "operationId")?,
        )?),
        "host.artifacts.seal" => encoded(store.seal(
            &caller,
            text(&params, "consumerPackageId")?,
            text(&params, "operationId")?,
            text(&params, "handle")?,
            text(&params, "mediaType")?,
        )?),
        "host.artifacts.read" => {
            let consumer = params["consumerPackageId"]
                .as_str()
                .unwrap_or(&caller.package_id);
            let descriptor = decode(params["artifact"].clone())?;
            encoded(store.read(
                &caller,
                consumer,
                text(&params, "operationId")?,
                &descriptor,
            )?)
        }
        "host.artifacts.acquired" => {
            let descriptor = decode(params["artifact"].clone())?;
            encoded(
                store.acquired(
                    &caller,
                    text(&params, "operationId")?,
                    &descriptor,
                    params["evidencePath"]
                        .as_str()
                        .filter(|path| {
                            !path.is_empty() && path.len() <= 4096 && !path.contains('\0')
                        })
                        .ok_or_else(|| error("Invalid handoff evidence path"))?,
                )?,
            )
        }
        "host.artifacts.release" => {
            Ok(json!({"released":store.release_unaccepted(&caller,text(&params,"operationId")?)?}))
        }
        method if method.starts_with("host.credentials.") => credential(&caller, method, params),
        _ => Err(error("Unsupported plugin service request")),
    }
}
fn test_provider(broker: &Broker) -> Result<(), AppError> {
    if broker.manifest().id != "xnmp.image-generation"
        || !broker
            .manifest()
            .services
            .iter()
            .any(|export| export.id == "image-generation" && export.major == 1)
    {
        return Err(error("Package does not own image connection tests"));
    }
    Ok(())
}
fn invoke(consumer: &Arc<Broker>, request: Invocation) -> Result<Value, AppError> {
    if request.service_id != "image-generation"
        || request.major != 1
        || !matches!(
            request.method.as_str(),
            "describe" | "prepare" | "start" | "status" | "cancel" | "acknowledge"
        )
    {
        return Err(error("Unsupported service ownership protocol"));
    }
    let (provider, _lease) = {
        let _gate = super::read_lifecycle()?;
        let entries = package::list(&super::root()?)?;
        let (provider, _) = service_graph::route(
            &entries,
            consumer.manifest(),
            &request.package_id,
            &request.service_id,
            request.major,
            &request.method,
        )?;
        (
            provider.clone(),
            backend::CallLease::acquire_lane(
                &provider.manifest.id,
                matches!(request.method.as_str(), "status" | "cancel" | "acknowledge"),
            )?,
        )
    };
    let backend = backend::ensure(&provider.manifest.id)?;
    if backend.generation().digest != provider.digest {
        return Err(error("Provider generation changed"));
    }
    if request.service_id != "image-generation" || request.major != 1 {
        return Err(error("Unsupported service ownership protocol"));
    }
    let store = service_host::store()?;
    let caller = consumer.generation();
    let provider = backend.generation();
    let target = ServiceTarget {
        package_id: request.package_id,
        service_id: request.service_id,
        major: request.major,
    };
    image_call(
        store,
        &caller,
        &provider,
        &target,
        &request.method,
        request.params,
        || consumer.can_recover() && backend.can_recover(),
        |method, params| backend.call(method, params),
    )
}
/// Durable business boundary shared by the real broker and native protocol
/// fixtures. Transport and lifecycle admission remain outside this function.
#[allow(clippy::too_many_arguments)]
pub(super) fn image_call(
    store: &crate::service_state::Store,
    caller: &PackageGeneration,
    provider: &PackageGeneration,
    target: &ServiceTarget,
    method: &str,
    params: Value,
    alive: impl Fn() -> bool,
    invoke: impl Fn(&str, Value) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    if !alive() {
        return Err(error("Service consumer disconnected before admission"));
    }
    let mut dispatch_method = method.to_owned();
    let mut body = params;
    let operation = if matches!(
        dispatch_method.as_str(),
        "start" | "status" | "cancel" | "acknowledge"
    ) {
        Some(text(&body, "operationId")?.to_owned())
    } else {
        None
    };
    let mut admission = operation
        .as_ref()
        .map(|op| store.get(&caller.package_id, op))
        .transpose()?
        .flatten();
    if let Some(a) = &admission {
        store.verify_consumer(caller, &a.operation_id)?;
        store.verify_provider(provider, &caller.package_id, &a.operation_id)?;
    }
    if matches!(dispatch_method.as_str(), "start" | "status")
        && admission.is_some()
        && store.execution_released(
            &caller.package_id,
            operation.as_deref().expect("owned operation"),
        )?
    {
        return Err(AppError::Service{code:"recovery_stopped".into(),message:"Automatic recovery was stopped for this original operation; its unknown execution evidence is retained".into()});
    }
    if dispatch_method == "start" {
        let _admission = ADMISSION.lock().unwrap_or_else(|cause| cause.into_inner());
        if !alive() {
            return Err(error("Service owner disconnected before durable admission"));
        }
        let op = operation.as_ref().expect("start operation");
        let semantic = crate::service_state::request::semantic(&body)?;
        let a = store.reserve_intent(
            Admission {
                consumer: caller.clone(),
                provider: provider.clone(),
                target: target.clone(),
                operation_id: op.clone(),
                fingerprint: text(&body, "effectiveRecipeDigest")?.into(),
                phase: AdmissionPhase::Reserved,
                inputs: decode(body["inputs"].clone())?,
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            },
            &semantic,
        )?;
        let (claimed, winner) = if a.phase == AdmissionPhase::Reserved {
            store.claim_forwarding(caller, op)?
        } else {
            (a, false)
        };
        if winner {
            body["inputs"] = encoded(&claimed.inputs)?;
        }
        admission = Some(claimed);
        if !winner {
            dispatch_method = "status".into();
            body = json!({"operationId":op});
        }
    }
    if dispatch_method == "acknowledge" {
        let op = operation.as_ref().expect("ack operation");
        let a = admission
            .as_ref()
            .ok_or_else(|| error("Operation is not admitted"))?;
        if a.output
            .as_ref()
            .is_none_or(|output| Some(output.sha256.as_str()) != body["outputSha256"].as_str())
        {
            return Err(error("Acknowledgement does not match the admitted output"));
        }
        if body["disposition"] == "acquired" {
            store.verify_acquisition(
                caller,
                op,
                text(&body, "outputSha256")?,
                text(&body, "transferReceipt")?,
            )?;
        } else if body["disposition"] != "discarded" {
            return Err(error("Invalid image handoff disposition"));
        }
    }
    if !alive() {
        return Err(error("Service consumer disconnected before dispatch"));
    }
    let result = invoke(
        &format!(
            "services.{}.v{}.{}",
            target.service_id, target.major, dispatch_method
        ),
        json!({"caller":{"packageId":caller.package_id,"packageDigest":caller.digest,"incarnation":caller.incarnation},"request":body}),
    )?;
    if let Some(a) = admission {
        return reconcile_receipt(store, provider, &a, &result);
    }
    Ok(result)
}
fn reconcile(
    provider: &PackageGeneration,
    admission: &Admission,
    status: &Value,
) -> Result<(), AppError> {
    reconcile_at(service_host::store()?, provider, admission, status)
}
pub(super) fn reconcile_at(
    store: &crate::service_state::Store,
    provider: &PackageGeneration,
    admission: &Admission,
    status: &Value,
) -> Result<(), AppError> {
    reconcile_receipt(store, provider, admission, status).map(|_| ())
}
fn reconcile_receipt(
    store: &crate::service_state::Store,
    provider: &PackageGeneration,
    admission: &Admission,
    status: &Value,
) -> Result<Value, AppError> {
    let validated = crate::service_state::receipt::validate(status, admission)?;
    let latest = store.observe_receipt(
        provider,
        &admission.consumer.package_id,
        &admission.operation_id,
        validated["revision"].as_u64().expect("validated revision"),
        validated,
    )?;
    let status = &latest;
    let consumer = &admission.consumer.package_id;
    let op = &admission.operation_id;
    let current = store.verify_provider(provider, consumer, op)?;
    let admission = &current;
    match status["execution"]["state"].as_str() {
        Some("accepted" | "running") => {
            if admission.phase == AdmissionPhase::Forwarding {
                store.accepted(provider, consumer, op)?;
            }
        }
        Some(state @ ("succeeded" | "failed" | "cancelled" | "unknown")) => {
            let output = if status["delivery"]["state"] == "available" {
                Some(decode(status["delivery"]["output"].clone())?)
            } else {
                admission.output.clone()
            };
            store.terminal(provider, consumer, op, output, state == "unknown")?;
            match status["delivery"]["state"].as_str() {
                Some("acquired") => {
                    store.release(
                        provider,
                        consumer,
                        op,
                        "acquired",
                        Some(text(&status["delivery"], "transferReceipt")?),
                    )?;
                }
                Some("discarded") => {
                    store.release(provider, consumer, op, "discarded", None)?;
                }
                Some("none") if matches!(state, "failed" | "cancelled") => {
                    store.release(provider, consumer, op, "discarded", None)?;
                }
                _ => {}
            }
        }
        _ => return Err(error("Invalid provider execution state")),
    }
    Ok(latest)
}
fn credential(caller: &PackageGeneration, method: &str, params: Value) -> Result<Value, AppError> {
    use crate::ai::credentials::{OsSecrets, SecretStore};
    let profile = text(&params, "profileId")?;
    if !crate::service_state::receipt::identity(profile) {
        return Err(error("Invalid image credential profile"));
    }
    let owner = format!("plugin:{}:{}", caller.package_id, profile);
    match method {
        "host.credentials.put" => {
            let key = params["key"]
                .as_str()
                .filter(|key| {
                    !key.is_empty() && key.len() <= 8192 && !key.chars().any(char::is_control)
                })
                .ok_or_else(|| error("Invalid API credential"))?;
            let mut bytes = [0; 16];
            getrandom::fill(&mut bytes).map_err(|_| error("Credential identity unavailable"))?;
            let id = hex::encode(bytes);
            OsSecrets
                .put(&owner, &id, key)
                .map_err(|_| error("OS credential store unavailable or locked"))?;
            Ok(json!({"id":id}))
        }
        "host.credentials.get" => Ok(
            json!({"key":OsSecrets.get(&owner,text(&params,"id")?).map_err(|_|error("OS credential store unavailable or locked"))?.ok_or_else(||error("Saved credential is unavailable"))?}),
        ),
        "host.credentials.remove" => {
            OsSecrets
                .remove(&owner, text(&params, "id")?)
                .map_err(|_| error("OS credential store unavailable or locked"))?;
            Ok(json!({"removed":true}))
        }
        _ => Err(error("Unsupported credential service method")),
    }
}

/// Transfer reconciliation ownership to the host before replacing a dead
/// backend. Only operations owned by that incarnation enter this worker.
static RECOVERY: std::sync::OnceLock<
    std::io::Result<crate::recovery_actor::RecoveryActor<PackageGeneration>>,
> = std::sync::OnceLock::new();
static RECOVERY_SETUP: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(super) fn shutdown_recovery() {
    // Setup and closing share a gate; no actor can appear after this snapshot.
    let actor = {
        let _setup = RECOVERY_SETUP
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        RECOVERY.get().and_then(|result| result.as_ref().ok())
    };
    if let Some(actor) = actor {
        // Queued signals keep their original durable ownership for restart.
        let _retained = actor.begin_shutdown();
        actor.join();
    }
}
pub(super) fn on_dead(generation: PackageGeneration) {
    use crate::recovery_actor::{Enqueue, RecoveryActor, Task};
    use std::time::{Duration, Instant};
    if backend::is_closing() {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    // A dead broker without durable work cannot consume recovery capacity.
    // Admission/death share this lock, so a paid forwarding winner is visible.
    let retained = crate::native_deadline::scoped(deadline, || -> Result<bool, AppError> {
        let store = service_host::store()?;
        let _admission =
            crate::native_deadline::lock(&ADMISSION, "Recovery admission lock is unavailable")?;
        Ok(store.list_preparations()?.contains(&generation)
            || store
                .claims()?
                .iter()
                .any(|a| a.consumer == generation || a.provider == generation))
    });
    if !matches!(retained, Ok(true)) {
        return;
    }
    let actor = {
        let _setup = RECOVERY_SETUP
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        if backend::is_closing() {
            return;
        }
        let Ok(actor) = RECOVERY.get_or_init(|| RecoveryActor::new(recover_generation)) else {
            backend::emit_operations_changed();
            return;
        };
        actor
    };
    match actor.enqueue(Task {
        generation,
        deadline,
    }) {
        Enqueue::Accepted | Enqueue::Duplicate => {}
        Enqueue::Full(_) | Enqueue::Closed(_) => {
            // Never renew a rejected signal's budget or submit its operation.
            // The durable claim is still visible for explicit recovery/startup.
            let _ = actor.take_rescan_needed();
            backend::emit_operations_changed();
        }
    }
}
fn recover_generation(
    dispatch: crate::recovery_actor::Dispatch<PackageGeneration>,
) -> crate::recovery_actor::RecoveryOutcome {
    use crate::recovery_actor::{Mode, RecoveryOutcome};
    if dispatch.mode == Mode::Expired {
        return RecoveryOutcome::Retained;
    }
    let aggregate_deadline = dispatch.task.deadline;
    let result = crate::native_deadline::scoped(aggregate_deadline, || {
        recover_owned(
            service_host::store()?,
            &LiveRecovery,
            &dispatch.task.generation,
            dispatch.mode,
            dispatch.attempt_deadline,
            aggregate_deadline,
        )
    });
    backend::emit_operations_changed();
    if result.is_ok() {
        RecoveryOutcome::Settled
    } else {
        RecoveryOutcome::Retained
    }
}
/// Provider IO used by the recovery policy. The policy owns every durable
/// transition; a port only reaches the exact pinned provider package.
pub(super) trait RecoveryPort {
    fn closing(&self) -> bool;
    /// Best-effort early cancellation to an already-live provider instance.
    /// Queue acceptance is not execution confirmation.
    fn signal_cancel(&self, admission: &Admission);
    /// One authoritative control call to the admission's pinned provider
    /// package. `settle` runs while the provider call ownership is retained.
    fn control(
        &self,
        admission: &Admission,
        method: &str,
        settle: &mut dyn FnMut(&PackageGeneration, &Value) -> Result<(), AppError>,
    ) -> Result<Value, AppError>;
}
fn control_params(admission: &Admission) -> Value {
    json!({"caller":{"packageId":admission.consumer.package_id,"packageDigest":admission.consumer.digest,"incarnation":admission.consumer.incarnation},"request":{"operationId":admission.operation_id}})
}
fn control_method(admission: &Admission, method: &str) -> String {
    format!(
        "services.{}.v{}.{}",
        admission.target.service_id, admission.target.major, method
    )
}
struct LiveRecovery;
impl RecoveryPort for LiveRecovery {
    fn closing(&self) -> bool {
        backend::is_closing()
    }
    fn signal_cancel(&self, admission: &Admission) {
        if let Some(provider) =
            backend::active_instance(&admission.provider.package_id, &admission.provider.digest)
        {
            let _ = provider.notify_request(
                &control_method(admission, "cancel"),
                control_params(admission),
            );
        }
    }
    fn control(
        &self,
        admission: &Admission,
        method: &str,
        settle: &mut dyn FnMut(&PackageGeneration, &Value) -> Result<(), AppError>,
    ) -> Result<Value, AppError> {
        let _lease = {
            let _gate = super::read_lifecycle()?;
            let entries = package::list(&super::root()?)?;
            if !entries.iter().any(|entry| {
                entry.enabled
                    && entry.manifest.id == admission.provider.package_id
                    && entry.digest == admission.provider.digest
            }) {
                return Err(error("Recovery provider is unavailable"));
            }
            backend::CallLease::acquire_lane(&admission.provider.package_id, true)?
        };
        let provider = backend::ensure(&admission.provider.package_id)?;
        let response = provider.call(
            &control_method(admission, method),
            control_params(admission),
        )?;
        settle(&provider.generation(), &response)?;
        Ok(response)
    }
}
/// Recovery policy for one dead generation's durable claims. A dead consumer's
/// live provider work is cancelled and reconciled; a dead provider's work is
/// reconciled by status. Neither path can start provider work, and unresolved
/// work is marked for attention rather than failed.
pub(super) fn recover_owned(
    store: &crate::service_state::Store,
    port: &impl RecoveryPort,
    generation: &PackageGeneration,
    mode: crate::recovery_actor::Mode,
    attempt_deadline: std::time::Instant,
    aggregate_deadline: std::time::Instant,
) -> Result<(), AppError> {
    use crate::recovery_actor::Mode;
    use std::{collections::HashSet, time::Duration, time::Instant};
    if mode == Mode::Expired {
        return Ok(());
    }
    let _ = store.release_preparations(generation);
    let claims = {
        let _admission =
            crate::native_deadline::lock(&ADMISSION, "Recovery admission lock is unavailable")?;
        store.claims()?
    }
    .into_iter()
    .filter(|a| {
        (a.consumer == *generation || a.provider == *generation)
            && a.phase != AdmissionPhase::Reserved
            && a.phase != AdmissionPhase::Released
    })
    .collect::<Vec<_>>();
    let mut remaining = claims;
    let mut cancelled = HashSet::new();
    // Signal every live shared-provider worker before waiting for any
    // receipt. A slow first status cannot delay the other cancellations.
    for admission in &remaining {
        if mode != Mode::Attempt || port.closing() || Instant::now() >= attempt_deadline {
            break;
        }
        let notify =
            crate::native_deadline::scoped(attempt_deadline, || -> Result<(), AppError> {
                let _action = super::ai_operations::action_guard()?;
                if recovery_retained_status(store, admission)?.is_some() {
                    return Ok(());
                }
                crate::native_deadline::check()?;
                if admission.consumer == *generation {
                    // A saturated provider may reject this burst; the loop below
                    // retries cancel with an authoritative reply.
                    port.signal_cancel(admission);
                }
                Ok(())
            });
        if notify.is_err() && Instant::now() >= attempt_deadline {
            break;
        }
    }
    let deadline = attempt_deadline;
    while !remaining.is_empty() && !port.closing() && Instant::now() < deadline {
        let mut pending = vec![];
        for admission in remaining {
            if port.closing() || Instant::now() >= deadline {
                pending.push(admission);
                continue;
            }
            let identity = (
                admission.consumer.package_id.clone(),
                admission.operation_id.clone(),
            );
            let attempt =
                crate::native_deadline::scoped(deadline, || -> Result<Value, AppError> {
                    let _action = super::ai_operations::action_guard()?;
                    if let Some(status) = recovery_retained_status(store, &admission)? {
                        return Ok(status);
                    }
                    let method =
                        if admission.consumer == *generation && !cancelled.contains(&identity) {
                            "cancel"
                        } else {
                            "status"
                        };
                    let response =
                        port.control(&admission, method, &mut |provider, response| {
                            reconcile_at(store, provider, &admission, response)
                        })?;
                    if method == "cancel" {
                        cancelled.insert(identity);
                    }
                    Ok(response)
                });
            if !attempt.as_ref().is_ok_and(|status| {
                !matches!(
                    status["execution"]["state"].as_str(),
                    Some("accepted" | "running")
                )
            }) {
                pending.push(admission);
            }
        }
        remaining = pending;
        if !remaining.is_empty() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    if port.closing() {
        // Shutdown is not a recovery verdict. Unresolved claims stay exactly
        // as recorded for startup recovery to reattach to.
        return Ok(());
    }
    for admission in remaining {
        crate::native_deadline::check()?;
        let _ = store.mark_attention(
            &admission.provider,
            &admission.consumer.package_id,
            &admission.operation_id,
        );
    }
    while !port.closing()
        && Instant::now() < aggregate_deadline
        && store.list_preparations()?.contains(generation)
    {
        let _ = store.release_preparations(generation);
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
pub(super) fn recovery_retained_status(
    store: &crate::service_state::Store,
    admission: &Admission,
) -> Result<Option<Value>, AppError> {
    let current = store
        .get(&admission.consumer.package_id, &admission.operation_id)?
        .ok_or_else(|| error("Recovery admission disappeared"))?;
    if current.phase == AdmissionPhase::Released
        || store.execution_released(&admission.consumer.package_id, &admission.operation_id)?
    {
        return Ok(Some(
            store
                .provider_receipt(&admission.consumer.package_id, &admission.operation_id)?
                .unwrap_or_else(|| json!({"execution":{"state":"unknown"}})),
        ));
    }
    Ok(None)
}
pub(super) fn recover_startup() -> Result<(), AppError> {
    for owner in startup_owners(service_host::store()?)? {
        on_dead(owner);
    }
    Ok(())
}
/// Every generation that owned unresolved durable work before this process
/// started. Each is proven dead because incarnations never survive a restart.
pub(super) fn startup_owners(
    store: &crate::service_state::Store,
) -> Result<Vec<PackageGeneration>, AppError> {
    let mut owners = store.list_preparations()?;
    owners.extend(
        store
            .claims()?
            .into_iter()
            .filter(|a| a.phase != AdmissionPhase::Released)
            .map(|a| a.consumer),
    );
    owners.sort_by(|a, b| {
        (&a.package_id, &a.digest, a.incarnation).cmp(&(&b.package_id, &b.digest, b.incarnation))
    });
    owners.dedup();
    Ok(owners)
}
#[cfg(all(test, target_os = "linux"))]
#[path = "service_native_kill_tests.rs"]
mod native_kill_tests;
#[cfg(all(test, target_os = "linux"))]
#[path = "service_native_tests.rs"]
mod native_tests;
