//! Reference-state-machine exploration over production Store, image_call,
//! automatic reconciliation and lifecycle mutations. Only native preflight and
//! provider transport are fake. Paid outcomes and original bytes are oracle
//! state, independent of host receipts; delivery is checked by reading bytes.
use super::{Fixture, Role};
use crate::{
    error::AppError,
    installed_plugins::{
        ai_operations, backend, job_bridge, package, service_bridge, service_graph,
    },
    service_state::{
        job::{JobRecord, JobState},
        model::*,
        Store,
    },
};
use proptest::{
    prelude::*,
    test_runner::{Config, TestCaseError, TestRunner},
};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    fs,
    io::Cursor,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
const SLOTS: usize = 3;
static NEXT_CASE: AtomicUsize = AtomicUsize::new(0);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Running,
    Unknown,
    Failed,
    Cancelled,
    Succeeded,
}
#[derive(Clone, Copy, Debug)]
enum Command {
    Admit(u8, bool),
    Register(u8),
    Capture(u8),
    Dispatch(u8),
    CancelPreparation(u8),
    CustodylessReserve(u8),
    CustodylessReply(u8, u8),
    CustodylessRelease(u8),
    Stage(u8, bool, bool),
    RecoveryWriterGc(u8),
    CrashMidWrite(u8),
    Seal(u8),
    ProviderComplete(u8),
    Publish(u8, u8, bool),
    Spool(u8),
    UnboundRepair(u8),
    ReplacementSpool(u8),
    AmbiguousSpool(u8),
    ReplacementCollision(u8),
    Probe(bool),
    WorkerActive(u8, bool, bool),
    Acquire(u8),
    Ack(u8, bool),
    ConsumerReceive(u8, bool),
    Replay(u8),
    Upgrade(bool, bool, bool),
    Enable(bool, bool),
    Uninstall(bool),
    Sweep,
    Gc,
    UnlinkFailure(bool),
    DirectorySyncFailure(bool),
    Restart,
    PowerLoss,
    DelayedReceipt(u8, bool),
    SharedConsumerAdmit,
    SpoolReserve(u8, bool, bool),
    SpoolReply(u8),
    SpoolReplyStep(u8, u8),
    SpoolPending(u8),
    SpoolFsync(u8),
    SpoolManifest(u8),
    SpoolManifestStep(u8, u8),
    SpoolSeal(u8),
    SettlementCrash(u8),
    SpoolCrash(u8, u8),
    LifecycleCrash(bool, u8),
    PausedMutation(u8, u8, u8),
}
impl Command {
    fn family(&self) -> &'static str {
        match self {
            Self::Admit(..) => "admit",
            Self::Register(_) => "presentation-register",
            Self::Capture(_) => "preparation-capture",
            Self::Dispatch(_) => "service-dispatch",
            Self::CancelPreparation(_) => "preparation-cancel",
            Self::CustodylessReserve(_) => "custodyless-reserve",
            Self::CustodylessReply(_, _) => "custodyless-reply-boundary",
            Self::CustodylessRelease(_) => "custodyless-release",
            Self::Stage(_, true, true) => "stage-durable",
            Self::Stage(_, true, false) => "stage-unsynced",
            Self::Stage(_, false, _) => "stage-partial",
            Self::RecoveryWriterGc(_) => "active-recovery-writer-gc",
            Self::CrashMidWrite(_) => "crash-midwrite",
            Self::Seal(_) => "seal",
            Self::ProviderComplete(_) => "provider-complete",
            Self::Publish(_, _, true) => "publication-failure",
            Self::Publish(_, 0, false) => "publish-success",
            Self::Publish(_, 1, false) => "publish-unknown",
            Self::Publish(_, 2, false) => "publish-failed",
            Self::Publish(_, 3, false) => "publish-cancelled",
            Self::Publish(..) => "publish",
            Self::Spool(_) => "host-spool",
            Self::UnboundRepair(_) => "fenced-unbound-repair",
            Self::ReplacementSpool(_) => "replacement-provider-unbound-spool",
            Self::AmbiguousSpool(_) => "ambiguous-unbound-refusal",
            Self::ReplacementCollision(_) => "provider-request-counter-collision",
            Self::Probe(true) => "healthy-probe",
            Self::Probe(false) => "unhealthy-probe",
            Self::WorkerActive(_, true, true) => "provider-active",
            Self::WorkerActive(_, false, true) => "consumer-active",
            Self::WorkerActive(_, _, false) => "worker-idle",
            Self::Acquire(_) => "acquire",
            Self::Ack(_, true) => "ack-crash",
            Self::Ack(_, false) => "ack-complete",
            Self::ConsumerReceive(_, true) => "consumer-receive-crash",
            Self::ConsumerReceive(_, false) => "consumer-receive-complete",
            Self::Replay(_) => "replay-fence",
            Self::Upgrade(true, true, _) => "provider-compatible",
            Self::Upgrade(false, true, _) => "consumer-compatible",
            Self::Upgrade(true, false, _) => "provider-incompatible",
            Self::Upgrade(false, false, _) => "consumer-incompatible",
            Self::Enable(_, false) => "disable",
            Self::Enable(_, true) => "reenable",
            Self::Uninstall(_) => "uninstall",
            Self::Sweep => "sweep",
            Self::Gc => "gc",
            Self::UnlinkFailure(_) => "unlink-fault",
            Self::DirectorySyncFailure(_) => "directory-sync-fault",
            Self::Restart => "restart",
            Self::PowerLoss => "power-loss",
            Self::DelayedReceipt(_, true) => "equal-conflicting-receipt",
            Self::DelayedReceipt(_, false) => "delayed-lower-receipt",
            Self::SharedConsumerAdmit => "shared-provider-consumers",
            Self::SpoolReserve(_, true, false) => "bound-spool-reserve",
            Self::SpoolReserve(_, false, false) => "unbound-spool-reserve",
            Self::SpoolReserve(_, _, true) => "nonzero-spool-reserve",
            Self::SpoolReply(_) => "spool-intent-commit",
            Self::SpoolReplyStep(_, point) => reply_boundary(*point),
            Self::SpoolPending(_) => "spool-pending-commit",
            Self::SpoolFsync(_) => "spool-output-fsync",
            Self::SpoolManifest(_) => "spool-manifest-temp-create",
            Self::SpoolManifestStep(_, point) => manifest_boundary(*point),
            Self::SpoolSeal(_) => "spool-seal-commit",
            Self::SettlementCrash(_) => "settlement-crash-before-collection",
            Self::SpoolCrash(_, 1) => "crash-after-spool-reserve",
            Self::SpoolCrash(_, 2..=18) => "crash-within-reply-persistence",
            Self::SpoolCrash(_, 19) => "crash-after-spool-pending",
            Self::SpoolCrash(_, 20) => "crash-after-spool-fsync",
            Self::SpoolCrash(_, 21..=28) => "crash-within-spool-manifest",
            Self::SpoolCrash(..) => "crash-after-spool-seal",
            Self::LifecycleCrash(_, 0) => "crash-lifecycle-intent",
            Self::LifecycleCrash(_, 1) => "crash-lifecycle-index",
            Self::LifecycleCrash(_, 2) => "crash-lifecycle-abandonment",
            Self::LifecycleCrash(_, 3) => "crash-lifecycle-cleanup",
            Self::LifecycleCrash(_, 4) => "crash-upgrade-prepared",
            Self::LifecycleCrash(_, 5) => "crash-upgrade-committed",
            Self::LifecycleCrash(_, 6) => "crash-upgrade-published",
            Self::LifecycleCrash(..) => "crash-replacement-abandoned",
            Self::PausedMutation(_, 0, 0) => "recovery-rpc-paused-disable",
            Self::PausedMutation(_, 0, 1) => "recovery-rpc-paused-uninstall",
            Self::PausedMutation(_, 0, 2) => "recovery-rpc-paused-compatible-upgrade",
            Self::PausedMutation(_, 0, _) => "recovery-rpc-paused-incompatible-upgrade",
            Self::PausedMutation(_, 1, 0) => "acquisition-paused-disable",
            Self::PausedMutation(_, 1, 1) => "acquisition-paused-uninstall",
            Self::PausedMutation(_, 1, 2) => "acquisition-paused-compatible-upgrade",
            Self::PausedMutation(_, 1, _) => "acquisition-paused-incompatible-upgrade",
            Self::PausedMutation(_, _, 0) => "native-writer-paused-disable",
            Self::PausedMutation(_, _, 1) => "native-writer-paused-uninstall",
            Self::PausedMutation(_, _, 2) => "native-writer-paused-compatible-upgrade",
            Self::PausedMutation(..) => "native-writer-paused-incompatible-upgrade",
        }
    }
}
fn reply_boundary(point: u8) -> &'static str {
    [
        "spool-intent-commit",
        "spool-pending-create",
        "spool-pending-partial",
        "spool-pending-full",
        "spool-pending-file-sync",
        "spool-pending-directory-sync",
        "spool-stdout-create",
        "spool-stdout-partial",
        "spool-stdout-full",
        "spool-stdout-file-sync",
        "spool-stderr-create",
        "spool-stderr-partial",
        "spool-stderr-full",
        "spool-stderr-file-sync",
        "spool-witness-file-sync",
        "spool-directory-sync",
        "spool-parent-directory-sync",
    ][usize::from(point - 1)]
}
fn manifest_boundary(point: u8) -> &'static str {
    [
        "spool-manifest-temp-create",
        "spool-manifest-partial",
        "spool-manifest-full",
        "spool-manifest-temp-sync",
        "spool-manifest-rename",
        "spool-manifest-target-sync",
        "spool-manifest-directory-sync",
        "spool-manifest-parent-sync",
    ][usize::from(point - 1)]
}
fn manifest_commands(slot: u8) -> Vec<Command> {
    std::iter::once(Command::SpoolManifest(slot))
        .chain((2..=8).map(|p| Command::SpoolManifestStep(slot, p)))
        .collect()
}
fn reply_commands(slot: u8) -> Vec<Command> {
    std::iter::once(Command::SpoolReply(slot))
        .chain((2..=17).map(|point| Command::SpoolReplyStep(slot, point)))
        .collect()
}
fn completion_commands(slot: u8) -> Vec<Command> {
    reply_commands(slot)
        .into_iter()
        .chain([Command::SpoolPending(slot), Command::SpoolFsync(slot)])
        .chain(manifest_commands(slot))
        .chain([Command::SpoolSeal(slot)])
        .collect()
}
fn commands(max_steps: usize) -> impl Strategy<Value = Vec<Command>> {
    let slot = 0u8..SLOTS as u8;
    proptest::collection::vec(
        prop_oneof![
            5 => (slot.clone(), any::<bool>()).prop_map(|(s,i)| Command::Admit(s,i)),
            4 => slot.clone().prop_map(Command::Register),
            4 => slot.clone().prop_map(Command::Capture),
            4 => slot.clone().prop_map(Command::Dispatch),
            2 => slot.clone().prop_map(Command::CancelPreparation),
            3 => slot.clone().prop_map(Command::CustodylessReserve),
            3 => (slot.clone(), 1u8..=28).prop_map(|(s,p)| Command::CustodylessReply(s,p)),
            2 => slot.clone().prop_map(Command::CustodylessRelease),
            6 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,c,d)| Command::Stage(s,c,d)),
            2 => slot.clone().prop_map(Command::RecoveryWriterGc),
            2 => slot.clone().prop_map(Command::CrashMidWrite),
            4 => slot.clone().prop_map(Command::Seal),
            4 => slot.clone().prop_map(Command::ProviderComplete),
            6 => (slot.clone(), 0u8..4, any::<bool>()).prop_map(|(s,o,f)| Command::Publish(s,o,f)),
            2 => slot.clone().prop_map(Command::Spool), 3 => any::<bool>().prop_map(Command::Probe),
            2 => slot.clone().prop_map(Command::UnboundRepair),
            2 => slot.clone().prop_map(Command::ReplacementSpool),
            2 => slot.clone().prop_map(Command::AmbiguousSpool),
            2 => slot.clone().prop_map(Command::ReplacementCollision),
            3 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,p,a)| Command::WorkerActive(s,p,a)),
            3 => slot.clone().prop_map(Command::Acquire),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,c)| Command::Ack(s,c)),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,c)| Command::ConsumerReceive(s,c)),
            2 => slot.clone().prop_map(Command::Replay),
            4 => (any::<bool>(),any::<bool>(),any::<bool>()).prop_map(|(r,c,q)| Command::Upgrade(r,c,q)),
            3 => (any::<bool>(),any::<bool>()).prop_map(|(r,e)| Command::Enable(r,e)),
            1 => any::<bool>().prop_map(Command::Uninstall), 5 => Just(Command::Sweep), 2 => Just(Command::Gc),
            2 => any::<bool>().prop_map(Command::UnlinkFailure),
            2 => any::<bool>().prop_map(Command::DirectorySyncFailure),
            3 => Just(Command::Restart), 3 => Just(Command::PowerLoss),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,e)| Command::DelayedReceipt(s,e)),
            2 => Just(Command::SharedConsumerAdmit),
            3 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,b,n)| Command::SpoolReserve(s,b,n)),
            3 => slot.clone().prop_map(Command::SpoolReply),
            4 => (slot.clone(), 2u8..=17).prop_map(|(s,p)| Command::SpoolReplyStep(s,p)),
            3 => slot.clone().prop_map(Command::SpoolPending),
            3 => slot.clone().prop_map(Command::SpoolFsync),
            3 => slot.clone().prop_map(Command::SpoolManifest),
            3 => (slot.clone(), 2u8..=8).prop_map(|(s,p)| Command::SpoolManifestStep(s,p)),
            3 => slot.clone().prop_map(Command::SpoolSeal),
            2 => slot.clone().prop_map(Command::SettlementCrash),
            3 => (slot.clone(), 1u8..=29).prop_map(|(s,p)| Command::SpoolCrash(s,p)),
            3 => (any::<bool>(), 0u8..=7).prop_map(|(r,p)| Command::LifecycleCrash(r,p)),
            3 => (slot.clone(), 0u8..=2, 0u8..=3).prop_map(|(s,k,a)| Command::PausedMutation(s,k,a)),
        ],
        1..=max_steps,
    )
}
/// A fake native process owns a *real* Store writer permit across model
/// transitions. Messages pause at durability boundaries; a crash drops the
/// owning thread and permit before reopening the host.
#[derive(Debug)]
struct SpoolActor {
    commands: std::sync::mpsc::Sender<Option<u8>>,
    replies: std::sync::mpsc::Receiver<Result<(), AppError>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl SpoolActor {
    fn new(
        root: PathBuf,
        limits: Limits,
        provider: PackageGeneration,
        handle: String,
        bytes: Vec<u8>,
        status: i64,
    ) -> Result<Self, AppError> {
        let (commands, incoming) = std::sync::mpsc::channel();
        let (responses, replies) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let opened = Store::open(root, limits);
            let store = match opened {
                Ok(store) => store,
                Err(error) => {
                    let _ = responses.send(Err(error));
                    return;
                }
            };
            let writer = match store.pin_host_spool(&handle) {
                Ok(writer) => writer,
                Err(error) => {
                    let _ = responses.send(Err(error));
                    return;
                }
            };
            if responses.send(Ok(())).is_err() {
                return;
            }
            while let Ok(Some(phase)) = incoming.recv() {
                if phase == 1 {
                    let mut next = 1;
                    let mut cancelled = false;
                    let completed = store.write_pinned_host_reply_observed(
                        &provider,
                        &writer,
                        &bytes,
                        b"",
                        status,
                        |point| {
                            if point != next {
                                return Err(AppError::Other(
                                    "fixture reply checkpoint out of order".into(),
                                ));
                            }
                            if responses.send(Ok(())).is_err() {
                                return Err(AppError::Other(
                                    "fixture reply checkpoint receiver dropped".into(),
                                ));
                            }
                            // The write is paused after the real mutation/barrier. Dropping
                            // the actor unwinds here, before the next production mutation.
                            match incoming.recv() {
                                Ok(Some(value)) if point < 17 && value == point + 1 => {
                                    next = value;
                                    Ok(())
                                }
                                Ok(Some(18)) if point == 17 => {
                                    next = 18;
                                    Ok(())
                                }
                                _ => {
                                    cancelled = true;
                                    Err(AppError::Other("fixture crash at reply checkpoint".into()))
                                }
                            }
                        },
                    );
                    if completed.is_err() {
                        // Checkpoint cancellation is a crash, not a second phase reply.
                        if !cancelled {
                            let _ = responses.send(completed);
                        }
                        return;
                    }
                    let result = store
                        .retain_pinned_host_execution(&provider, &writer, status)
                        .map(|_| ());
                    if responses.send(result).is_err() {
                        return;
                    }
                    continue;
                }
                if phase == 20 {
                    let mut next = 20;
                    let mut cancelled = false;
                    let completed = store.publish_pinned_host_manifest_observed(
                        &provider,
                        &writer,
                        status,
                        |point| {
                            if next != 19 + point {
                                return Err(AppError::Other(
                                    "fixture manifest checkpoint out of order".into(),
                                ));
                            }
                            if responses.send(Ok(())).is_err() {
                                return Err(AppError::Other(
                                    "fixture manifest checkpoint receiver dropped".into(),
                                ));
                            }
                            match incoming.recv() {
                                Ok(Some(value)) if value == 20 + point => {
                                    next = value;
                                    Ok(())
                                }
                                _ => {
                                    cancelled = true;
                                    Err(AppError::Other(
                                        "fixture crash at manifest checkpoint".into(),
                                    ))
                                }
                            }
                        },
                    );
                    if completed.is_err() {
                        if !cancelled {
                            let _ = responses.send(completed);
                        }
                        return;
                    }
                    let result = store.commit_pinned_host_seal(&provider, &writer);
                    if responses.send(result).is_err() {
                        return;
                    }
                    continue;
                }
                let result = match phase {
                    19 => store.sync_pinned_host_reply(&writer),
                    _ => Err(AppError::Other(
                        "fixture completion checkpoint out of order".into(),
                    )),
                };
                if responses.send(result).is_err() {
                    return;
                }
            }
        });
        let actor = Self {
            commands,
            replies,
            worker: Some(worker),
        };
        actor
            .replies
            .recv()
            .map_err(|_| AppError::Other("Fixture writer failed to start".into()))??;
        Ok(actor)
    }
    fn phase(&self, phase: u8) -> Result<(), AppError> {
        self.commands
            .send(Some(phase))
            .map_err(|_| AppError::Other("Fixture native writer died".into()))?;
        self.replies
            .recv()
            .map_err(|_| AppError::Other("Fixture native writer lost phase reply".into()))?
    }
}
impl Drop for SpoolActor {
    fn drop(&mut self) {
        let _ = self.commands.send(None);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("fixture native writer panicked")
        }
    }
}
#[derive(Debug)]
struct Operation {
    id: String,
    dispatched: bool,
    captured_inputs: Vec<ArtifactDescriptor>,
    request: Value,
    recovery_native_starts: Cell<usize>,
    native_paid_starts: Cell<usize>,
    native_local_repairs: Cell<usize>,
    native_context: NativeContext,
    native_intent: NativeIntent,
    resume_calls: Cell<usize>,
    consumer_runs: Cell<usize>,
    consumer: PackageGeneration,
    provider: PackageGeneration,
    outcome: Outcome,
    captured_process_reply: bool,
    paid_success: bool,
    valid_original: bool,
    durable_original: bool,
    original: Vec<u8>,
    removed: bool,
    stage: Option<OutputStage>,
    descriptor: Option<ArtifactDescriptor>,
    spool: Option<String>,
    spool_owner: Option<PackageGeneration>,
    extra_spools: Vec<String>,
    native_attempts: u64,
    unpaid_repair: bool,
    spool_phase: u8,
    spool_status: i64,
    spool_request: String,
    writer: Option<SpoolActor>,
    transfer: Option<String>,
    copy: PathBuf,
    acknowledged: bool,
    provider_live: bool,
    consumer_live: bool,
    revision: Cell<u64>,
    last_receipt: RefCell<Option<Value>>,
    starts: Cell<usize>,
    stopped: Cell<bool>,
    delivery_effects: Cell<usize>,
}
impl Operation {
    fn provider_rejected(&self) -> bool {
        matches!(self.outcome, Outcome::Failed | Outcome::Cancelled)
    }
    fn receipt(&self, delivery: Value) -> Value {
        let execution = match self.outcome {
            Outcome::Running => json!({"state":"running"}),
            Outcome::Unknown => {
                json!({"state":"unknown","error":{"code":"interrupted","message":"Unconfirmed","correlationId":null}})
            }
            Outcome::Failed => {
                json!({"state":"failed","error":{"code":"failed","message":"Provider failed","correlationId":null}})
            }
            Outcome::Cancelled => json!({"state":"cancelled"}),
            Outcome::Succeeded => {
                json!({"state":"succeeded","metadata":{"adapter":"model-fixture","endpointIdentity":"https://fixture.test/images","requestedModel":null,"actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}})
            }
        };
        if let Some(previous) = self.last_receipt.borrow().as_ref() {
            if previous["execution"] == execution && previous["delivery"] == delivery {
                return previous.clone();
            }
        }
        self.revision.set(self.revision.get() + 1);
        let receipt = json!({"version":1,"operationId":self.id,"requestFingerprint":"b".repeat(64),"provider":{"packageId":self.provider.package_id,"serviceId":"image-generation","major":1},"revision":self.revision.get(),"execution":execution,"delivery":delivery});
        *self.last_receipt.borrow_mut() = Some(receipt.clone());
        receipt
    }
    fn delivery(&self) -> Value {
        if self.outcome != Outcome::Succeeded {
            return json!({"state":"none"});
        }
        if self.acknowledged {
            return json!({"state":"acquired","transferReceipt":self.transfer});
        }
        self.descriptor.as_ref().map_or_else(
            || json!({"state":"unavailable","reason":"missing"}),
            |d| json!({"state":"available","output":d}),
        )
    }
}
#[derive(Clone, Copy, Debug)]
enum NativeContext {
    InitialDispatch,
    Recovery,
}
#[derive(Clone, Copy, Debug)]
enum NativeIntent {
    PaidGeneration,
    LocalReconstruction,
}
/// Meter the fixture's native-work invocation independently of service .start.
/// Intent is an explicit fake-provider recipe, never inferred from a custody
/// release decision. Real executable admission is checked in native tests.
fn native_work_started(op: &Operation, context: NativeContext, intent: NativeIntent) {
    match intent {
        NativeIntent::PaidGeneration => {
            op.native_paid_starts.set(op.native_paid_starts.get() + 1);
            if matches!(context, NativeContext::Recovery) {
                op.recovery_native_starts
                    .set(op.recovery_native_starts.get() + 1);
            }
        }
        NativeIntent::LocalReconstruction => op
            .native_local_repairs
            .set(op.native_local_repairs.get() + 1),
    }
}
struct ProfileFixture {
    profile: tempfile::TempDir,
    root: PathBuf,
    consumer: package::Installed,
    provider: package::Installed,
    second_consumer: package::Installed,
    next: [PathBuf; 2],
}
impl ProfileFixture {
    fn id(&self, role: Role) -> &str {
        match role {
            Role::Consumer => &self.consumer.manifest.id,
            Role::Provider => &self.provider.manifest.id,
        }
    }
    fn installed(&self, role: Role) -> Option<package::Installed> {
        package::list(&self.root)
            .unwrap()
            .into_iter()
            .find(|p| p.manifest.id == self.id(role))
    }
}
struct CustodylessSpool {
    owner: PackageGeneration,
    handle: String,
    original: Vec<u8>,
    phase: u8,
    writer: Option<SpoolActor>,
    removed: bool,
    released: bool,
    valid: bool,
    durable: bool,
}
struct Machine {
    limits: Limits,
    coverage: BTreeMap<&'static str, u64>,
    fixture: ProfileFixture,
    store: Option<Store>,
    oracle: std::sync::Arc<crate::service_state::test_fs::TestFs>,
    operations: RefCell<Vec<Operation>>,
    slots: [Option<usize>; SLOTS],
    healthy: bool,
    unlink_failure: bool,
    sync_failure: bool,
    incarnation: u64,
    provider_incarnation: u64,
    dirty_writes: BTreeMap<PathBuf, Vec<u8>>,
    custodyless: Vec<CustodylessSpool>,
    raw_slots: [Option<usize>; SLOTS],
    jobs: BTreeMap<String, JobRecord>,
    notices: BTreeMap<String, usize>,
    applied: usize,
}
impl Drop for Machine {
    fn drop(&mut self) {
        // Native writers must relinquish locks before TempDir removes the
        // profile, especially on Windows.
        for spool in &mut self.custodyless {
            spool.writer.take();
        }
        for operation in self.operations.get_mut() {
            operation.writer.take();
        }
    }
}
fn fail(message: impl Into<String>) -> TestCaseError {
    TestCaseError::fail(message.into())
}
fn expected_capacity(error: &AppError) -> bool {
    matches!(error,AppError::Service{code,..} if code=="storage_full")
        || error.to_string().contains("operation capacity reached")
}
fn checked<T>(value: Result<T, AppError>) -> Result<T, TestCaseError> {
    value.map_err(|e| fail(e.to_string()))
}
fn image_bytes(identity: u8) -> Vec<u8> {
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        3,
        image::Rgba([identity, 34, 56, 255]),
    ))
    .write_to(&mut encoded, image::ImageFormat::Png)
    .unwrap();
    encoded.into_inner()
}
fn role(provider: bool) -> Role {
    if provider {
        Role::Provider
    } else {
        Role::Consumer
    }
}
impl Machine {
    fn new() -> Self {
        let Fixture {
            profile,
            root,
            store,
            consumer,
            provider,
            next,
        } = Fixture::new(&format!(
            "model-{}",
            NEXT_CASE.fetch_add(1, Ordering::Relaxed)
        ));
        let second_id = format!("{}.second", consumer.manifest.id);
        let second_archive = package::tests::archive_named(
            &profile.path().join("archives"),
            "second-consumer.teplugin",
            |m| {
                m.id = second_id.clone();
                m.sdk_version = 3;
                m.contributions = vec![second_id.replace('.', "-")];
                m.service_dependencies = serde_json::from_value(json!([{
                    "packageId":provider.manifest.id,"serviceId":"image-generation","major":1,"optional":true
                }])).unwrap();
            },
        );
        let second_consumer =
            package::publish(&root, package::prepare(&root, &second_archive).unwrap()).unwrap();
        let fixture = ProfileFixture {
            profile,
            root,
            consumer,
            provider,
            second_consumer,
            next,
        };
        let limits = Limits {
            disk_bytes: 200 * 1024 * 1024 + 16 * 1024,
            operations: 4,
            per_consumer: 3,
        };
        drop(store);
        let store = Store::open(fixture.profile.path().join("service-state"), limits).unwrap();
        let data = fixture.profile.path().join("consumer-data");
        fs::create_dir(&data).unwrap();
        store
            .register_consumer_root(fixture.id(Role::Consumer), data)
            .unwrap();
        let second_data = fixture.profile.path().join("second-consumer-data");
        fs::create_dir(&second_data).unwrap();
        store
            .register_consumer_root(&fixture.second_consumer.manifest.id, second_data)
            .unwrap();
        let oracle = store.test_fs.clone();
        Self {
            limits,
            coverage: BTreeMap::new(),
            fixture,
            store: Some(store),
            oracle,
            operations: RefCell::new(vec![]),
            slots: [None; SLOTS],
            healthy: true,
            unlink_failure: false,
            sync_failure: false,
            incarnation: 10,
            provider_incarnation: 10,
            dirty_writes: BTreeMap::new(),
            custodyless: vec![],
            raw_slots: [None; SLOTS],
            jobs: BTreeMap::new(),
            notices: BTreeMap::new(),
            applied: 0,
        }
    }
    fn index(&self, slot: u8) -> Option<usize> {
        self.slots[slot as usize]
    }
    fn store(&self) -> &Store {
        self.store.as_ref().expect("model store is online")
    }
    fn profile(&self) -> super::super::Profile<'_> {
        super::super::Profile {
            root: &self.fixture.root,
            store: self.store(),
        }
    }
    fn generation(&self, role: Role) -> Option<PackageGeneration> {
        self.fixture
            .installed(role)
            .filter(|p| p.enabled)
            .map(|p| PackageGeneration {
                package_id: p.manifest.id,
                digest: p.digest,
                incarnation: if matches!(role, Role::Provider) {
                    self.provider_incarnation
                } else {
                    self.incarnation
                },
            })
    }
    fn publish(&self, index: usize, failure: bool) -> Result<(), AppError> {
        let ops = self.operations.borrow();
        let op = &ops[index];
        if op.removed {
            return Ok(());
        }
        let a = self.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        if failure {
            self.store().fail_next_write()
        }
        let result = service_bridge::reconcile_at(
            self.store(),
            &op.provider,
            &a,
            &op.receipt(op.delivery()),
        );
        if failure {
            self.store().clear_write_failure();
        }
        result
    }
    fn sweep(&self) -> Result<(), AppError> {
        for job in ai_operations::auto_reconcile_in(self.store(), &Transport { machine: self })? {
            backend::emit_job_event(json!({"type":"updated","job":job}));
        }
        Ok(())
    }
    fn request(op: &Operation) -> Value {
        json!({"operationId":op.id,"connectionId":"model-profile","expectedConnectionRevision":"revision-1","model":null,"prompt":"model test","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"local-token","effectiveRecipeDigest":"b".repeat(64)})
    }
    fn register(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let consumer = if slot as usize == SLOTS - 1 {
            package::list(&self.fixture.root)
                .unwrap()
                .into_iter()
                .find(|p| p.manifest.id == self.fixture.second_consumer.manifest.id && p.enabled)
                .map(|p| PackageGeneration {
                    package_id: p.manifest.id,
                    digest: p.digest,
                    incarnation: self.incarnation + 1,
                })
        } else {
            self.generation(Role::Consumer)
        };
        let Some(mut consumer) = consumer else {
            return Ok(());
        };
        if self.generation(Role::Provider).is_none() {
            return Ok(());
        }
        let target = ServiceTarget {
            package_id: self.fixture.id(Role::Provider).to_owned(),
            service_id: "image-generation".into(),
            major: 1,
        };
        let installed = package::list(&self.fixture.root).unwrap();
        if !installed.iter().any(|p| {
            p.manifest.id == consumer.package_id
                && service_graph::consumer_recovers(&p.manifest, &target)
        }) || !installed.iter().any(|p| {
            p.manifest.id == target.package_id
                && service_graph::provider_recovers(&p.manifest, &target)
        }) {
            return Ok(());
        }
        if let Some(index) = self.index(slot) {
            let ops = self.operations.borrow();
            let op = &ops[index];
            if !op.removed
                && (!op.dispatched
                    || !op.acknowledged
                        && !self
                            .store()
                            .execution_released(&op.consumer.package_id, &op.id)
                            .unwrap())
            {
                return Ok(());
            }
        }
        self.incarnation += 1;
        let index = self.operations.borrow().len();
        // Rejected preparation also tombstones its request identity. Each
        // generated admission attempt therefore gets a fresh ID.
        let id = format!("model-operation-{}-{index}", self.incarnation);
        consumer.incarnation = self.incarnation;
        let provider = self.generation(Role::Provider).unwrap();
        let op = Operation {
            id: id.clone(),
            dispatched: false,
            captured_inputs: vec![],
            request: Value::Null,
            recovery_native_starts: Cell::new(0),
            native_paid_starts: Cell::new(0),
            native_local_repairs: Cell::new(0),
            native_context: NativeContext::InitialDispatch,
            native_intent: NativeIntent::PaidGeneration,
            resume_calls: Cell::new(0),
            consumer_runs: Cell::new(0),
            consumer: consumer.clone(),
            provider: provider.clone(),
            outcome: Outcome::Running,
            captured_process_reply: false,
            paid_success: false,
            valid_original: false,
            durable_original: false,
            original: image_bytes(index as u8),
            removed: false,
            stage: None,
            descriptor: None,
            spool: None,
            spool_owner: None,
            extra_spools: vec![],
            native_attempts: 0,
            unpaid_repair: false,
            spool_phase: 0,
            spool_status: 0,
            spool_request: id.clone(),
            writer: None,
            transfer: None,
            copy: self
                .fixture
                .profile
                .path()
                .join(if slot as usize == SLOTS - 1 {
                    "second-consumer-data"
                } else {
                    "consumer-data"
                })
                .join(format!("{id}.png")),
            acknowledged: false,
            provider_live: false,
            consumer_live: false,
            revision: Cell::new(0),
            last_receipt: RefCell::new(None),
            starts: Cell::new(0),
            stopped: Cell::new(false),
            delivery_effects: Cell::new(0),
        };
        let job = JobRecord {
            job_key: format!("{:048x}", index + 1),
            owner: consumer,
            operation_id: id,
            job_id: index as u64 + 1,
            kind: "model-image".into(),
            label: "model.png".into(),
            origin_window: "main".into(),
            revision: 0,
            source_revision: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: Some("accepting".into()),
            output_path: None,
            run_id: None,
            error: None,
        };
        checked(self.store().register_job(job))?;
        self.operations.borrow_mut().push(op);
        self.slots[slot as usize] = Some(index);
        self.applied += 1;
        Ok(())
    }
    fn admit(&mut self, slot: u8, input: bool) -> Result<(), TestCaseError> {
        self.register(slot)?;
        if input {
            self.capture(slot)?;
        }
        self.dispatch(slot)
    }
    fn preparation_callback_owner(
        &self,
        op: &Operation,
    ) -> Result<PackageGeneration, TestCaseError> {
        let installed = package::list(&self.fixture.root)
            .unwrap()
            .into_iter()
            .find(|p| p.manifest.id == op.consumer.package_id && p.enabled)
            .ok_or_else(|| fail("consumer callback has no enabled package"))?;
        let current = if op.consumer.package_id == self.fixture.id(Role::Consumer) {
            self.generation(Role::Consumer)
                .ok_or_else(|| fail("consumer callback has no current generation"))?
        } else {
            op.consumer.clone()
        };
        let job = checked(
            self.store()
                .job_for_operation(&op.consumer.package_id, &op.id),
        )?
        .ok_or_else(|| fail("consumer callback lost its presentation"))?;
        Ok(checked(job_bridge::recovery_job(
            self.store(),
            &installed.manifest,
            &current,
            &job,
        ))?
        .owner)
    }
    fn capture(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.dispatched || !op.captured_inputs.is_empty() {
            return Ok(());
        }
        op.consumer = self.preparation_callback_owner(op)?;
        let path = self
            .fixture
            .profile
            .path()
            .join(format!("{}-input.png", op.id));
        fs::write(&path, &op.original).unwrap();
        match self.store().capture(
            &op.consumer,
            &op.id,
            vec![CaptureInput {
                path: path.to_string_lossy().into(),
                expected_digest: None,
            }],
        ) {
            Ok(captures) => {
                op.captured_inputs = captures.into_iter().map(|c| c.artifact).collect();
                self.applied += 1;
            }
            Err(error) if expected_capacity(&error) || self.sync_failure || self.unlink_failure => {
            }
            Err(error) => return Err(fail(format!("unexpected input capture rejection: {error}"))),
        }
        Ok(())
    }
    fn dispatch(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.dispatched {
            return Ok(());
        }
        let consumer = self.preparation_callback_owner(op)?;
        let Some(provider) = self.generation(Role::Provider) else {
            return Ok(());
        };
        let target = ServiceTarget {
            package_id: provider.package_id.clone(),
            service_id: "image-generation".into(),
            major: 1,
        };
        if !self
            .fixture
            .installed(Role::Provider)
            .is_some_and(|p| service_graph::provider_recovers(&p.manifest, &target))
        {
            return Ok(());
        }
        let mut request = Self::request(op);
        request["inputs"] = json!(op.captured_inputs);
        let target = ServiceTarget {
            package_id: provider.package_id.clone(),
            service_id: "image-generation".into(),
            major: 1,
        };
        match service_bridge::image_call(
            self.store(),
            &consumer,
            &provider,
            &target,
            "start",
            request.clone(),
            || true,
            |method, _| {
                if method.ends_with(".start") {
                    op.starts.set(op.starts.get() + 1);
                }
                Ok(op.receipt(json!({"state":"none"})))
            },
        ) {
            Ok(_) => {
                op.dispatched = true;
                op.consumer = consumer;
                op.provider = provider;
                op.request = request;
                self.applied += 1;
            }
            Err(error) if expected_capacity(&error) || self.sync_failure || self.unlink_failure => {
            }
            Err(error) => return Err(fail(format!("unexpected admission rejection: {error}"))),
        }
        Ok(())
    }
    fn cancel_preparation(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.dispatched || op.removed {
            return Ok(());
        }
        let caller = self.preparation_callback_owner(op)?;
        let _ = checked(self.store().release_unaccepted(&caller, &op.id))?;
        let job = checked(
            self.store()
                .job_for_operation(&op.consumer.package_id, &op.id),
        )?
        .unwrap();
        checked(self.store().update_job(
            &job.owner,
            &job.job_key,
            JobState::Cancelled,
            Some("not_accepted".into()),
            None,
            None,
            None,
        ))?;
        op.removed = true;
        self.applied += 1;
        Ok(())
    }
    fn stage(&mut self, slot: u8, complete: bool, synced: bool) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed
            || op.acknowledged
            || !complete && op.valid_original
            || op.descriptor.is_some()
            || matches!(op.outcome, Outcome::Failed | Outcome::Cancelled)
        {
            return Ok(());
        }
        let store = self.store.as_ref().unwrap();
        let a = checked(store.get(&op.consumer.package_id, &op.id))?.unwrap();
        let _permit = checked(store.output_recovery_guard(&a))?;
        let stage = match store.stage(&op.provider, &op.consumer.package_id, &op.id) {
            Ok(s) => s,
            Err(cause) if expected_capacity(&cause) || self.sync_failure || self.unlink_failure => {
                return Ok(())
            }
            Err(cause) => return Err(fail(format!("unexpected stage rejection: {cause}"))),
        };
        let path = PathBuf::from(&stage.path);
        let baseline = fs::read(&path).map_err(|_| {
            fail("stage writable path disappeared while recovery permit remained owned")
        })?;
        self.dirty_writes.entry(path.clone()).or_insert(baseline);
        fs::write(
            &path,
            if complete {
                op.original.clone()
            } else {
                op.original[..op.original.len() / 2].to_vec()
            },
        )
        .unwrap();
        if synced {
            crate::durable_dir::sync_file(&path).unwrap();
            self.dirty_writes.remove(&path);
        }
        if complete {
            op.paid_success = true;
            op.valid_original = true;
            op.durable_original |= synced;
        }
        op.stage = Some(stage);
        self.applied += 1;
        Ok(())
    }
    fn seal(&self, slot: u8) {
        let Some(index) = self.index(slot) else {
            return;
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.acknowledged {
            return;
        }
        let Some(stage) = &op.stage else { return };
        let a = self
            .store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap();
        let _permit = self.store().output_recovery_guard(&a).unwrap();
        if let Ok(d) = self.store().seal(
            &op.provider,
            &op.consumer.package_id,
            &op.id,
            &stage.handle,
            "image/png",
        ) {
            op.descriptor = Some(d);
            op.valid_original = true;
            op.durable_original = true;
        }
    }
    fn recovery_writer_gc(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed
            || op.valid_original
            || op.acknowledged
            || matches!(op.outcome, Outcome::Failed | Outcome::Cancelled)
        {
            return Ok(());
        }
        let store = self.store.as_ref().unwrap();
        let a = checked(store.get(&op.consumer.package_id, &op.id))?.unwrap();
        let _permit = checked(store.output_recovery_guard(&a))?;
        let stage = match store.stage(&op.provider, &op.consumer.package_id, &op.id) {
            Ok(stage) => stage,
            Err(error) if expected_capacity(&error) || self.sync_failure || self.unlink_failure => {
                return Ok(())
            }
            Err(error) => return Err(fail(format!("active recovery stage rejected: {error}"))),
        };
        let path = PathBuf::from(&stage.path);
        self.dirty_writes
            .entry(path.clone())
            .or_insert(fs::read(&path).map_err(|_| fail("active recovery stage disappeared"))?);
        fs::write(&path, &op.original[..op.original.len() / 2]).unwrap();
        // A second Store is another host subsystem, not a process restart:
        // validation and GC must respect the original writer's live permit.
        let reopened = match Store::open(
            self.fixture.profile.path().join("service-state"),
            self.limits,
        ) {
            Ok(store) => store,
            Err(_) if self.sync_failure || self.unlink_failure => return Ok(()),
            Err(error) => return Err(fail(format!("concurrent reopen failed: {error}"))),
        };
        checked(reopened.gc())?;
        if fs::read(&path).ok().as_deref() != Some(&op.original[..op.original.len() / 2]) {
            return Err(fail(
                "live recovery writer lost its stage during concurrent reopen/GC",
            ));
        }
        op.stage = Some(stage);
        self.applied += 1;
        Ok(())
    }
    fn acquire(&self, slot: u8) -> Result<(), AppError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.acknowledged || op.transfer.is_some() {
            return Ok(());
        }
        let Some(d) = &op.descriptor else {
            return Ok(());
        };
        let a = self.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        if a.phase != AdmissionPhase::Terminal || a.output.as_ref() != Some(d) {
            return Ok(());
        }
        let source = self
            .store()
            .read(&op.consumer, &op.consumer.package_id, &op.id, d)?;
        op.consumer_runs.set(op.consumer_runs.get() + 1);
        fs::copy(source.path, &op.copy)?;
        op.delivery_effects.set(op.delivery_effects.get() + 1);
        op.transfer = Some(
            self.store()
                .acquired(&op.consumer, &op.id, d, op.copy.to_str().unwrap())?
                .transfer_receipt,
        );
        Ok(())
    }
    fn ack(&self, slot: u8, crash: bool) -> Result<(), AppError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.acknowledged {
            return Ok(());
        }
        let Some(transfer) = op.transfer.as_deref() else {
            return Ok(());
        };
        self.store().release(
            &op.provider,
            &op.consumer.package_id,
            &op.id,
            "acquired",
            Some(transfer),
        )?;
        op.acknowledged = true;
        op.consumer_live = false;
        op.valid_original = true;
        op.durable_original = true;
        if !crash {
            self.store()
                .complete_acquired_job(&op.consumer.package_id, &op.id)?;
        }
        Ok(())
    }
    fn mutation(&mut self, command: Command) -> Result<(), TestCaseError> {
        let (provider, remove, compatible, live) = match command {
            Command::Upgrade(r, c, l) => (r, false, c, l),
            Command::Enable(r, false) | Command::Uninstall(r) => (r, true, false, false),
            _ => unreachable!(),
        };
        let role = role(provider);
        if self.fixture.installed(role).is_none() {
            return Ok(());
        }
        let id = self.fixture.id(role).to_owned();
        let leases = if live {
            vec![backend::CallLease::acquire(&id).unwrap()]
        } else {
            vec![]
        };
        if remove {
            match command {
                Command::Uninstall(_) => checked(super::super::uninstall(&self.profile(), &id))?,
                _ => checked(super::super::set_enabled(&self.profile(), &id, false))?,
            }
        } else {
            let archive = if compatible {
                self.fixture.next[role as usize].clone()
            } else {
                package::tests::archive_named(
                    &self.fixture.profile.path().join("archives"),
                    "model-incompatible.teplugin",
                    |m| {
                        m.id = id.clone();
                        m.version = "3.0.0".into();
                        m.sdk_version = 2;
                        m.contributions = vec![id.replace('.', "-")];
                    },
                )
            };
            checked(super::super::upgrade(
                &self.profile(),
                &archive,
                &|_, _, _| Ok(()),
            ))?;
        }
        drop(leases);
        for op in self.operations.borrow_mut().iter_mut() {
            if (remove || !compatible)
                && !op.removed
                && (op.consumer.package_id == id || op.dispatched && op.provider.package_id == id)
            {
                op.removed = true;
                op.provider_live = false;
                op.consumer_live = false;
            } else if op.provider.package_id == id {
                op.provider_live = false;
            } else if op.consumer.package_id == id {
                op.consumer_live = false;
            }
        }
        for spool in &mut self.custodyless {
            if spool.owner.package_id == id && (remove || !compatible) {
                spool.removed = true;
            }
        }
        self.incarnation += 1;
        if provider {
            self.provider_incarnation = self.incarnation;
        }
        self.applied += 1;
        Ok(())
    }
    fn restart(&mut self, power_loss: bool) -> Result<(), TestCaseError> {
        let oracle = self.oracle.clone();
        for op in self.operations.borrow_mut().iter_mut() {
            op.provider_live = false;
            op.consumer_live = false;
            if op.spool_phase < 10
                && op.writer.is_some()
                && op.descriptor.is_none()
                && op.stage.is_none()
            {
                op.valid_original = false;
            }
            op.writer.take();
            if op.spool.is_some() {
                op.spool_phase = 30;
            }
        }
        for spool in &mut self.custodyless {
            spool.writer.take();
            if power_loss && !spool.durable {
                spool.valid = false;
            }
            spool.phase = 30;
        }
        if power_loss {
            for op in self.operations.borrow_mut().iter_mut() {
                if !op.durable_original {
                    op.valid_original = false;
                }
            }
            oracle.power_loss();
            self.unlink_failure = false;
            self.sync_failure = false;
            for (path, bytes) in std::mem::take(&mut self.dirty_writes) {
                if path.exists() {
                    fs::write(path, bytes).unwrap();
                }
            }
        }
        drop(self.store.take());
        match Store::open(
            self.fixture.profile.path().join("service-state"),
            self.limits,
        ) {
            Ok(store) => self.store = Some(store),
            Err(_) if self.unlink_failure || self.sync_failure => return Ok(()),
            Err(cause) => return Err(fail(format!("restart lost valid store: {cause}"))),
        }
        assert!(std::sync::Arc::ptr_eq(&oracle, &self.store().test_fs));
        checked(super::super::recover(&self.fixture.root))?;
        self.incarnation += 1;
        self.provider_incarnation = self.incarnation;
        Ok(())
    }
    fn spool_phase(&mut self, command: Command) -> Result<(), TestCaseError> {
        let slot = match command {
            Command::SpoolReserve(s, ..)
            | Command::SpoolReply(s)
            | Command::SpoolReplyStep(s, _)
            | Command::SpoolPending(s)
            | Command::SpoolFsync(s)
            | Command::SpoolManifest(s)
            | Command::SpoolManifestStep(s, _)
            | Command::SpoolSeal(s) => s,
            _ => unreachable!(),
        };
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.acknowledged {
            return Ok(());
        }
        if let Command::SpoolReserve(_, bound, nonzero) = command {
            let admission = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
            let execution_released = checked(
                self.store()
                    .execution_released(&op.consumer.package_id, &op.id),
            )?;
            // A normal native dispatch belongs to the still-live original
            // execution. Recovery may invoke only an explicitly unpaid recipe;
            // custody-less process support does not authorize a new paid turn.
            if matches!(op.native_intent, NativeIntent::PaidGeneration)
                && (execution_released
                    || self.generation(Role::Provider).as_ref() != Some(&op.provider))
            {
                return Ok(());
            }
            if op.provider_rejected()
                || op.spool.is_some()
                || if bound {
                    !matches!(
                        admission.phase,
                        AdmissionPhase::Forwarding | AdmissionPhase::Accepted
                    ) || execution_released
                } else {
                    admission.phase == AdmissionPhase::Released
                }
            {
                return Ok(());
            }
            let owner = if bound {
                op.provider.clone()
            } else {
                let Some(owner) = self.generation(Role::Provider) else {
                    return Ok(());
                };
                owner
            };
            // Real SDK reverse-call identities advance on every attempt,
            // including refusals before a process can start.
            op.native_attempts += 1;
            op.spool_request = format!("host:model-{}-{}", op.id, op.native_attempts);
            let custody = bound.then_some((op.consumer.package_id.as_str(), op.id.as_str()));
            match self.store().reserve_host_spool_with_custody(
                &owner,
                &op.spool_request,
                4096,
                custody,
            ) {
                Ok((handle, _)) => {
                    op.spool_status = if nonzero { 17 } else { 0 };
                    op.writer = Some(checked(SpoolActor::new(
                        self.fixture.profile.path().join("service-state"),
                        self.limits,
                        owner.clone(),
                        handle.clone(),
                        op.original.clone(),
                        op.spool_status,
                    ))?);
                    op.spool = Some(handle);
                    op.spool_owner = Some(owner);
                    op.unpaid_repair =
                        matches!(op.native_intent, NativeIntent::LocalReconstruction);
                    native_work_started(op, op.native_context, op.native_intent);
                    op.spool_phase = 1;
                    self.applied += 1;
                }
                Err(error)
                    if expected_capacity(&error)
                        || self.sync_failure
                        || self.unlink_failure
                        || !bound
                            && error
                                .to_string()
                                .contains("host output custody is ambiguous")
                        || error.to_string().contains("plugin incarnation was retired") => {}
                Err(error) => {
                    return Err(fail(format!(
                        "unexpected host spool reservation rejection: {error}"
                    )))
                }
            }
            return Ok(());
        }
        let expected = match command {
            Command::SpoolReply(_) => 1,
            Command::SpoolReplyStep(_, point) => point,
            Command::SpoolPending(_) => 18,
            Command::SpoolFsync(_) => 19,
            Command::SpoolManifest(_) => 20,
            Command::SpoolManifestStep(_, point) => 19 + point,
            Command::SpoolSeal(_) => 28,
            _ => unreachable!(),
        };
        if op.spool_phase != expected {
            return Ok(());
        }
        let Some(writer) = &op.writer else {
            return Ok(());
        };
        if expected == 1 {
            // The process supplied its reply before host IO. A provider that
            // already rejected this attempt still owns raw process output,
            // but those bytes are not an approved image original.
            op.captured_process_reply = true;
            if op.spool_status == 0 && !op.provider_rejected() {
                op.paid_success = true;
                op.valid_original = true;
            }
        }
        let result = writer.phase(expected);
        match result {
            Ok(()) => {
                op.spool_phase += 1;
                if expected == 28 {
                    op.writer.take();
                }
                if expected == 16 && op.valid_original {
                    op.durable_original = true;
                }
                self.applied += 1;
            }
            Err(_) if self.sync_failure || self.unlink_failure => {
                op.writer.take();
                op.spool_phase = 30;
                if op.stage.is_none() && op.descriptor.is_none() {
                    let path = self
                        .fixture
                        .profile
                        .path()
                        .join("service-state/host-spools")
                        .join(op.spool.as_ref().unwrap())
                        .join("stdout");
                    op.valid_original &= fs::read(path).ok().as_ref() == Some(&op.original);
                }
            }
            Err(error)
                if op.provider_rejected()
                    && error
                        .to_string()
                        .contains("host output reservation was cancelled")
                    && checked(self.store().get(&op.consumer.package_id, &op.id))?
                        .is_some_and(|a| a.phase == AdmissionPhase::Released) =>
            {
                // A durable provider rejection fences this late raw reply.
                // It was never an approved image; relinquish the live permit
                // so healthy cleanup can release every charged byte.
                op.writer.take();
                op.spool_phase = 30;
                self.applied += 1;
            }
            Err(error) => {
                return Err(fail(format!(
                    "spool completion phase {command:?} rejected: {error}"
                )))
            }
        }
        Ok(())
    }
    fn complete_spool(&mut self, slot: u8, bound: bool) -> Result<(), TestCaseError> {
        for phase in std::iter::once(Command::SpoolReserve(slot, bound, false))
            .chain(completion_commands(slot))
        {
            self.spool_phase(phase)?;
        }
        Ok(())
    }
    fn custodyless_reserve(&mut self, slot: u8) -> Result<(), TestCaseError> {
        if self.raw_slots[usize::from(slot)]
            .is_some_and(|i| !self.custodyless[i].released && !self.custodyless[i].removed)
        {
            return Ok(());
        }
        let Some(owner) = self.generation(Role::Provider) else {
            return Ok(());
        };
        // This surface is supported independently of image-service admission.
        if !checked(self.store().package_operations(&owner.package_id))?.is_empty() {
            return Ok(());
        }
        let original = image_bytes(200 + slot);
        let request = format!(
            "custodyless-{}-{}",
            self.incarnation,
            self.custodyless.len()
        );
        let handle = match self.store().reserve_host_spool(&owner, &request, 4096) {
            Ok((handle, _)) => handle,
            Err(error) if expected_capacity(&error) || self.sync_failure || self.unlink_failure => {
                return Ok(())
            }
            Err(error) => return Err(fail(format!("custodyless reserve rejected: {error}"))),
        };
        let writer = checked(SpoolActor::new(
            self.fixture.profile.path().join("service-state"),
            self.limits,
            owner.clone(),
            handle.clone(),
            original.clone(),
            0,
        ))?;
        self.raw_slots[usize::from(slot)] = Some(self.custodyless.len());
        self.custodyless.push(CustodylessSpool {
            owner,
            handle,
            original,
            phase: 1,
            writer: Some(writer),
            removed: false,
            released: false,
            valid: false,
            durable: false,
        });
        self.applied += 1;
        Ok(())
    }
    fn custodyless_reply(&mut self, slot: u8, phase: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.raw_slots[usize::from(slot)] else {
            return Ok(());
        };
        let spool = &mut self.custodyless[index];
        if spool.removed || spool.released || spool.phase != phase {
            return Ok(());
        }
        let Some(writer) = &spool.writer else {
            return Ok(());
        };
        match writer.phase(phase) {
            Ok(()) => {
                spool.phase += 1;
                spool.valid |= phase >= 9;
                spool.durable |= phase >= 16;
                if phase == 28 {
                    spool.writer.take();
                }
                self.applied += 1;
            }
            Err(_) if self.sync_failure || self.unlink_failure => {
                spool.writer.take();
                spool.phase = 30;
                let path = self
                    .fixture
                    .profile
                    .path()
                    .join("service-state/host-spools")
                    .join(&spool.handle)
                    .join("stdout");
                spool.valid = fs::read(path).ok().as_ref() == Some(&spool.original);
            }
            Err(error) => return Err(fail(format!("custodyless completion failed: {error}"))),
        }
        Ok(())
    }
    fn custodyless_release(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.raw_slots[usize::from(slot)] else {
            return Ok(());
        };
        let spool = &mut self.custodyless[index];
        if spool.removed || spool.released {
            return Ok(());
        }
        spool.writer.take();
        checked(
            self.store
                .as_ref()
                .unwrap()
                .release_host_spool(&spool.owner.package_id, &spool.handle),
        )?;
        spool.released = true;
        self.applied += 1;
        Ok(())
    }
    fn custodyless_invariants(&self, clean: bool) -> Result<(), TestCaseError> {
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        for spool in &self.custodyless {
            let path = self
                .fixture
                .profile
                .path()
                .join("service-state/host-spools")
                .join(&spool.handle);
            if spool.valid
                && !spool.removed
                && !spool.released
                && fs::read(path.join("stdout")).ok().as_ref() != Some(&spool.original)
            {
                return Err(fail("custodyless verified original disappeared"));
            }
            if clean && (spool.removed || spool.released) {
                let count: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM host_spools WHERE handle=?1",
                        [&spool.handle],
                        |r| r.get(0),
                    )
                    .unwrap();
                if count != 0 || path.exists() {
                    return Err(fail(format!("incompatible replacement retained custodyless spool or quota: {}, rows={count}", spool.handle)));
                }
            }
        }
        Ok(())
    }
    fn replacement_collision(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let Some(owner) = self.generation(Role::Provider) else {
            return Ok(());
        };
        let (consumer, operation, request, original) = {
            let ops = self.operations.borrow();
            let op = &ops[index];
            if op.removed
                || op.acknowledged
                || op.spool_phase != 29
                || !op.extra_spools.is_empty()
                || op.spool_owner.as_ref().unwrap().digest == owner.digest
                || self.sync_failure
                || self.unlink_failure
            {
                return Ok(());
            }
            (
                op.consumer.package_id.clone(),
                op.id.clone(),
                op.spool_request.clone(),
                op.original.clone(),
            )
        };
        // SDK reverse counters reset in a new broker. Its unrelated raw
        // reply can share a request ID with the original paid process.
        let (handle, _) = match self.store().reserve_host_spool(&owner, &request, 4096) {
            Ok(reservation) => reservation,
            Err(error)
                if expected_capacity(&error)
                    || error
                        .to_string()
                        .contains("host output custody is ambiguous") =>
            {
                return Ok(())
            }
            Err(error) => return Err(fail(error.to_string())),
        };
        let actor = checked(SpoolActor::new(
            self.fixture.profile.path().join("service-state"),
            self.limits,
            owner.clone(),
            handle.clone(),
            image_bytes(251),
            0,
        ))?;
        for phase in 1..=28 {
            checked(actor.phase(phase))?;
        }
        drop(actor);
        self.operations.borrow_mut()[index]
            .extra_spools
            .push(handle);
        let result = checked(self.store().host_spool_result_for_operation(
            &owner.package_id,
            &request,
            &consumer,
            &operation,
            None,
        ))?
        .ok_or_else(|| fail("request-counter collision hid the original reply"))?;
        if fs::read(result["stdout"].as_str().unwrap()).ok().as_ref() != Some(&original) {
            return Err(fail(
                "request-counter collision selected unrelated replacement output",
            ));
        }
        self.applied += 1;
        Ok(())
    }
    fn paused_mutation(&mut self, slot: u8, kind: u8, action: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        if self.operations.borrow()[index].removed
            || self.operations.borrow()[index].acknowledged
            || self.operations.borrow()[index].consumer.package_id
                != self.fixture.id(Role::Consumer)
        {
            return Ok(());
        }
        // A separately opened Store shares the actual lease/fence registry,
        // allowing its paused owner to outlive a lifecycle call on this host.
        let held = match Store::open(
            self.fixture.profile.path().join("service-state"),
            self.limits,
        ) {
            Ok(store) => store,
            Err(_) if self.sync_failure || self.unlink_failure => return Ok(()),
            Err(error) => return Err(fail(error.to_string())),
        };
        let (consumer, operation) = {
            let ops = self.operations.borrow();
            (
                ops[index].consumer.package_id.clone(),
                ops[index].id.clone(),
            )
        };
        let admission = checked(held.get(&consumer, &operation))?.unwrap();
        let job = checked(held.job_for_operation(&consumer, &operation))?;
        let mutation = match action {
            0 => Command::Enable(false, false),
            1 => Command::Uninstall(false),
            2 => Command::Upgrade(false, true, false),
            _ => Command::Upgrade(false, false, false),
        };
        match kind {
            0 => {
                let before = self.operations.borrow()[index].delivery_effects.get();
                let port = PausedRecoveryRpc {
                    machine: RefCell::new(&mut *self),
                    mutation,
                    entered: Cell::new(false),
                    violation: RefCell::new(None),
                };
                let _ = ai_operations::recover_in(&held, &admission, job.as_ref(), &port);
                let entered = port.entered.get();
                let violation = port.violation.borrow_mut().take();
                drop(port);
                if let Some(message) = violation {
                    return Err(fail(message));
                }
                if !entered {
                    return Ok(());
                }
                if self.operations.borrow()[index].removed
                    && self.operations.borrow()[index].delivery_effects.get() != before
                {
                    return Err(fail("in-flight recovery RPC delivered after removal"));
                }
            }
            1 => {
                if admission.output.is_none() || self.operations.borrow()[index].transfer.is_some()
                {
                    return Ok(());
                }
                let d = admission.output.as_ref().unwrap();
                let source = checked(held.read(&admission.consumer, &consumer, &operation, d))?;
                let source_bytes = fs::read(&source.path).map_err(|e| fail(e.to_string()))?;
                self.mutation(mutation)?;
                let (copy, removed) = {
                    let ops = self.operations.borrow();
                    (ops[index].copy.clone(), ops[index].removed)
                };
                fs::write(&copy, &source_bytes).map_err(|e| fail(e.to_string()))?;
                {
                    let ops = self.operations.borrow();
                    ops[index]
                        .consumer_runs
                        .set(ops[index].consumer_runs.get() + 1);
                    ops[index]
                        .delivery_effects
                        .set(ops[index].delivery_effects.get() + 1);
                }
                let acquired =
                    held.acquired(&admission.consumer, &operation, d, copy.to_str().unwrap());
                if removed && acquired.is_ok() {
                    return Err(fail("paused acquisition revived removed custody"));
                }
                if let Ok(proof) = acquired {
                    self.operations.borrow_mut()[index].transfer = Some(proof.transfer_receipt);
                }
            }
            _ => {
                if self.operations.borrow()[index].spool.is_none() {
                    self.spool_phase(Command::SpoolReserve(slot, true, false))?;
                }
                let Some(handle) = self.operations.borrow()[index].spool.clone() else {
                    return Ok(());
                };
                self.operations.borrow_mut()[index].writer.take();
                let writer = checked(held.pin_host_spool(&handle))?;
                self.mutation(mutation)?;
                let mut ops = self.operations.borrow_mut();
                let op = &mut ops[index];
                op.captured_process_reply = true;
                if !op.removed && !op.provider_rejected() {
                    op.paid_success = true;
                    op.valid_original = true;
                }
                let completed = held.write_pinned_host_reply(
                    op.spool_owner.as_ref().unwrap_or(&op.provider),
                    &writer,
                    &op.original,
                    b"",
                    0,
                );
                if op.removed && completed.is_ok() {
                    return Err(fail("paused native writer published after removal"));
                }
                let completed = completed.is_ok();
                drop(ops);
                if completed {
                    let mut ops = self.operations.borrow_mut();
                    let op = &mut ops[index];
                    op.durable_original |= op.valid_original;
                    op.spool_phase = 18;
                }
                drop(writer);
                checked(held.sweep_host_spools(|_| false))?;
            }
        }
        self.applied += 1;
        Ok(())
    }
    fn observable(&self) -> Vec<u64> {
        let ops = self.operations.borrow();
        vec![
            self.applied as u64,
            self.incarnation,
            self.healthy as u64,
            self.unlink_failure as u64,
            self.sync_failure as u64,
            ops.iter().map(|o| o.revision.get()).sum(),
            ops.iter().filter(|o| o.descriptor.is_some()).count() as u64,
            ops.iter().filter(|o| o.stage.is_some()).count() as u64,
            ops.iter().map(|o| u64::from(o.spool_phase)).sum(),
            ops.iter().filter(|o| o.captured_process_reply).count() as u64,
            ops.iter().map(|o| o.native_attempts).sum(),
            ops.iter().map(|o| o.native_paid_starts.get() as u64).sum(),
            ops.iter()
                .map(|o| o.native_local_repairs.get() as u64)
                .sum(),
            ops.iter()
                .map(|o| o.recovery_native_starts.get() as u64)
                .sum(),
            ops.iter().map(|o| o.consumer_runs.get() as u64).sum(),
            ops.iter().map(|o| o.resume_calls.get() as u64).sum(),
            ops.iter().filter(|o| o.transfer.is_some()).count() as u64,
            ops.iter().filter(|o| o.acknowledged).count() as u64,
            ops.iter()
                .filter(|o| o.provider_live || o.consumer_live)
                .count() as u64,
            self.store
                .as_ref()
                .map_or(0, |s| s.snapshot_jobs().unwrap().watermark),
            self.store.as_ref().map_or(0, |_| self.charges() as u64),
            self.disk_bytes(),
            self.custodyless.iter().map(|s| u64::from(s.phase)).sum(),
            self.custodyless
                .iter()
                .filter(|s| s.released || s.removed)
                .count() as u64,
            ops.iter().map(|o| o.captured_inputs.len() as u64).sum(),
            ops.iter().filter(|o| o.dispatched).count() as u64,
        ]
    }
    fn observe_events(&mut self, events: Vec<Value>) -> Result<(), TestCaseError> {
        for event in events {
            if event["job"]["phase"] == "consumer_removed" && event["job"]["state"] == "error" {
                let id = event["job"]["operationId"]
                    .as_str()
                    .ok_or_else(|| fail("notice has no operation identity"))?
                    .to_owned();
                let count = self.notices.entry(id.clone()).or_default();
                *count += 1;
                if *count > 1 {
                    return Err(fail(format!(
                        "duplicate emitted undelivered notice: {id}, count={count}"
                    )));
                }
            }
        }
        Ok(())
    }
    fn apply(&mut self, command: Command) -> Result<(), TestCaseError> {
        let (result, events) = backend::capture_job_events(|| self.apply_inner(command));
        self.observe_events(events)?;
        result
    }
    fn apply_inner(&mut self, command: Command) -> Result<(), TestCaseError> {
        let before = self.observable();
        if self.store.is_none() {
            match command {
                Command::Restart | Command::PowerLoss => {}
                Command::UnlinkFailure(f) => {
                    self.unlink_failure = f;
                    self.oracle.faults(f, self.sync_failure);
                    return Ok(());
                }
                Command::DirectorySyncFailure(f) => {
                    self.sync_failure = f;
                    self.oracle.faults(self.unlink_failure, f);
                    return Ok(());
                }
                _ => return Ok(()),
            }
        }
        let requires_admission = match command {
            Command::Stage(s, ..)
            | Command::RecoveryWriterGc(s)
            | Command::CrashMidWrite(s)
            | Command::Seal(s)
            | Command::ProviderComplete(s)
            | Command::Publish(s, ..)
            | Command::Spool(s)
            | Command::UnboundRepair(s)
            | Command::ReplacementSpool(s)
            | Command::AmbiguousSpool(s)
            | Command::ReplacementCollision(s)
            | Command::WorkerActive(s, ..)
            | Command::Acquire(s)
            | Command::Ack(s, ..)
            | Command::ConsumerReceive(s, ..)
            | Command::Replay(s)
            | Command::DelayedReceipt(s, ..)
            | Command::SpoolReserve(s, ..)
            | Command::SpoolReply(s)
            | Command::SpoolReplyStep(s, _)
            | Command::SpoolPending(s)
            | Command::SpoolFsync(s)
            | Command::SpoolManifest(s)
            | Command::SpoolManifestStep(s, _)
            | Command::SpoolSeal(s)
            | Command::SettlementCrash(s)
            | Command::SpoolCrash(s, _)
            | Command::PausedMutation(s, ..) => Some(s),
            _ => None,
        };
        if requires_admission.is_some_and(|slot| {
            self.index(slot)
                .is_some_and(|i| !self.operations.borrow()[i].dispatched)
        }) {
            return self.invariants();
        }
        match command {
            Command::Admit(s, i) => self.admit(s, i)?,
            Command::Register(s) => self.register(s)?,
            Command::Capture(s) => self.capture(s)?,
            Command::Dispatch(s) => self.dispatch(s)?,
            Command::CancelPreparation(s) => self.cancel_preparation(s)?,
            Command::CustodylessReserve(s) => self.custodyless_reserve(s)?,
            Command::CustodylessReply(s, p) => self.custodyless_reply(s, p)?,
            Command::CustodylessRelease(s) => self.custodyless_release(s)?,
            Command::Stage(s, c, d) => self.stage(s, c, d)?,
            Command::RecoveryWriterGc(s) => self.recovery_writer_gc(s)?,
            Command::CrashMidWrite(s) => {
                self.stage(s, false, false)?;
                self.restart(false)?
            }
            Command::Seal(s) => self.seal(s),
            Command::ProviderComplete(s) => {
                self.stage(s, true, true)?;
                self.seal(s);
                if let Some(index) = self.index(s) {
                    let publish = {
                        let mut ops = self.operations.borrow_mut();
                        let op = &mut ops[index];
                        if !op.removed
                            && !op.acknowledged
                            && op.valid_original
                            && !matches!(op.outcome, Outcome::Failed | Outcome::Cancelled)
                        {
                            op.outcome = Outcome::Succeeded;
                            true
                        } else {
                            false
                        }
                    };
                    if publish {
                        checked(self.publish(index, false))?;
                    }
                }
            }
            Command::Publish(s, o, f) => {
                if let Some(i) = self.index(s) {
                    let allowed = {
                        let mut ops = self.operations.borrow_mut();
                        let op = &mut ops[i];
                        let next = match o {
                            0 => Outcome::Succeeded,
                            1 => Outcome::Unknown,
                            2 => Outcome::Failed,
                            _ => Outcome::Cancelled,
                        };
                        if op.removed
                            || op.acknowledged
                            || op.outcome == Outcome::Succeeded && next != Outcome::Succeeded
                            || op.outcome == Outcome::Unknown
                                && !matches!(next, Outcome::Unknown | Outcome::Succeeded)
                            || matches!(op.outcome, Outcome::Failed | Outcome::Cancelled)
                                && next != op.outcome
                            || op.paid_success
                                && matches!(next, Outcome::Failed | Outcome::Cancelled)
                        {
                            false
                        } else {
                            op.outcome = next;
                            if matches!(
                                next,
                                Outcome::Succeeded | Outcome::Failed | Outcome::Cancelled
                            ) {
                                op.provider_live = false;
                            }
                            if next == Outcome::Succeeded {
                                op.paid_success = true
                            }
                            true
                        }
                    };
                    if allowed {
                        let published = self.publish(i, f);
                        if !f {
                            checked(published)?;
                        }
                        self.applied += 1
                    }
                }
            }
            Command::Spool(s) => self.complete_spool(s, true)?,
            Command::UnboundRepair(s) => {
                if let Some(index) = self.index(s) {
                    let (consumer, operation) = {
                        let ops = self.operations.borrow();
                        (
                            ops[index].consumer.package_id.clone(),
                            ops[index].id.clone(),
                        )
                    };
                    if checked(self.store().execution_released(&consumer, &operation))? {
                        {
                            let mut ops = self.operations.borrow_mut();
                            ops[index].native_context = NativeContext::Recovery;
                            ops[index].native_intent = NativeIntent::LocalReconstruction;
                        }
                        self.complete_spool(s, false)?;
                    }
                }
            }
            Command::ReplacementSpool(s) => {
                if let Some(index) = self.index(s) {
                    if self.generation(Role::Provider).is_some_and(|owner| {
                        owner.digest != self.operations.borrow()[index].provider.digest
                    }) {
                        // This replacement reconstructs the original cached
                        // reply locally; it never repeats the paid generation.
                        {
                            let mut ops = self.operations.borrow_mut();
                            ops[index].native_context = NativeContext::Recovery;
                            ops[index].native_intent = NativeIntent::LocalReconstruction;
                        }
                        self.complete_spool(s, false)?;
                    }
                }
            }
            Command::AmbiguousSpool(s) => {
                if let Some(index) = self.index(s) {
                    let candidates = checked(
                        self.store()
                            .package_operations(self.fixture.id(Role::Provider)),
                    )?
                    .into_iter()
                    .filter(|a| {
                        a.provider.package_id == self.fixture.id(Role::Provider)
                            && a.phase != AdmissionPhase::Released
                    })
                    .count();
                    if candidates > 1 && self.operations.borrow()[index].spool.is_none() {
                        let charge = self.charges();
                        let disk = self.disk_bytes();
                        self.spool_phase(Command::SpoolReserve(s, false, false))?;
                        if self.operations.borrow()[index].spool.is_some()
                            || self.charges() != charge
                            || self.disk_bytes() != disk
                        {
                            return Err(fail("ambiguous unbound request created output or quota"));
                        }
                    }
                }
            }
            Command::ReplacementCollision(s) => self.replacement_collision(s)?,
            Command::SpoolReserve(..)
            | Command::SpoolReply(_)
            | Command::SpoolReplyStep(_, _)
            | Command::SpoolPending(_)
            | Command::SpoolFsync(_)
            | Command::SpoolManifest(_)
            | Command::SpoolManifestStep(_, _)
            | Command::SpoolSeal(_) => self.spool_phase(command)?,
            Command::SettlementCrash(slot) => {
                if let Some(index) = self.index(slot) {
                    let operation = {
                        let ops = self.operations.borrow();
                        let op = &ops[index];
                        (!op.removed && !op.paid_success)
                            .then(|| (op.consumer.package_id.clone(), op.id.clone()))
                    };
                    if let Some((consumer, operation)) = operation {
                        // Prevent physical collection so the simulated crash
                        // lands after the durable decision while bytes and
                        // quota are still present, rather than after cleanup.
                        self.oracle.faults(true, self.sync_failure);
                        match self
                            .store()
                            .auto_settle_operation(&consumer, &operation, true)
                        {
                            Ok(Some(job)) => {
                                backend::emit_job_event(json!({"type":"updated","job":job}));
                                self.applied += 1;
                            }
                            Ok(None) => {}
                            Err(_) if self.sync_failure || self.unlink_failure => {}
                            Err(error) => return Err(fail(error.to_string())),
                        }
                        self.oracle.faults(self.unlink_failure, self.sync_failure);
                        // Physical collection has its own durability barriers;
                        // the release decision is already in the transaction.
                        self.restart(false)?;
                    }
                }
            }
            Command::Probe(h) => {
                self.healthy = h;
                let _ = self.sweep();
            }
            Command::WorkerActive(s, provider, live) => {
                if let Some(index) = self.index(s) {
                    let mut ops = self.operations.borrow_mut();
                    let op = &mut ops[index];
                    let a = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
                    if !op.removed
                        && (!live
                            || matches!(
                                a.phase,
                                AdmissionPhase::Forwarding
                                    | AdmissionPhase::Accepted
                                    | AdmissionPhase::Terminal
                            ) && !checked(
                                self.store()
                                    .execution_released(&op.consumer.package_id, &op.id),
                            )?)
                    {
                        if provider {
                            op.provider_live = live;
                        } else {
                            op.consumer_live = live;
                        }
                    }
                }
            }
            Command::Acquire(s) => {
                checked(self.acquire(s))?;
            }
            Command::Ack(s, c) => {
                checked(self.ack(s, c))?;
            }
            Command::ConsumerReceive(s, c) => {
                checked(self.acquire(s))?;
                checked(self.ack(s, c))?;
            }
            Command::Replay(s) => {
                if let Some(i) = self.index(s) {
                    let ops = self.operations.borrow();
                    let op = &ops[i];
                    let target = ServiceTarget {
                        package_id: op.provider.package_id.clone(),
                        service_id: "image-generation".into(),
                        major: 1,
                    };
                    let _ = service_bridge::image_call(
                        self.store(),
                        &op.consumer,
                        &op.provider,
                        &target,
                        "start",
                        op.request.clone(),
                        || true,
                        |method, _| {
                            if method.ends_with(".start") {
                                op.starts.set(op.starts.get() + 1)
                            }
                            Ok(op.receipt(op.delivery()))
                        },
                    );
                    self.applied += 1;
                }
            }
            Command::Upgrade(..) | Command::Uninstall(_) | Command::Enable(_, false) => {
                self.mutation(command)?
            }
            Command::Enable(p, true) => {
                let id = self.fixture.id(role(p)).to_owned();
                if self.fixture.installed(role(p)).is_some() {
                    checked(super::super::set_enabled(&self.profile(), &id, true))?;
                    self.incarnation += 1;
                }
            }
            Command::Sweep => {
                let _ = self.sweep();
            }
            Command::Gc => {
                checked(self.store().gc())?;
                checked(self.store().sweep_host_spools(|_| false))?;
            }
            Command::UnlinkFailure(f) => {
                self.unlink_failure = f;
                self.store().test_fs.faults(f, self.sync_failure)
            }
            Command::DirectorySyncFailure(f) => {
                self.sync_failure = f;
                self.store().test_fs.faults(self.unlink_failure, f)
            }
            Command::Restart => self.restart(false)?,
            Command::PowerLoss => {
                self.restart(true)?;
                self.unlink_failure = false;
                self.sync_failure = false
            }
            Command::SpoolCrash(slot, phase) => {
                let reached = self
                    .index(slot)
                    .is_some_and(|index| self.operations.borrow()[index].spool_phase == phase);
                if reached {
                    self.restart(true)?;
                }
            }
            Command::LifecycleCrash(provider, point) => {
                let name = [
                    "removal-intent",
                    "removal-index",
                    "removal-abandoned",
                    "removal-cleanup",
                    "upgrade-prepared",
                    "upgrade-committed",
                    "upgrade-published",
                    "replacement-abandoned",
                ][usize::from(point)];
                if self.fixture.installed(role(provider)).is_some() {
                    super::super::crash_at_boundary(name);
                    let mutation = if point < 4 {
                        Command::Enable(provider, false)
                    } else {
                        Command::Upgrade(provider, false, false)
                    };
                    let crashed = self.mutation(mutation);
                    super::super::crash_at_boundary("__none__");
                    if crashed
                        .as_ref()
                        .is_err_and(|cause| cause.to_string().contains("injected lifecycle crash"))
                    {
                        self.restart(false)?;
                        let installed = package::list(&self.fixture.root).unwrap();
                        for op in self.operations.borrow_mut().iter_mut() {
                            let Some(a) =
                                checked(self.store().get(&op.consumer.package_id, &op.id))?
                            else {
                                if checked(
                                    self.store()
                                        .job_for_operation(&op.consumer.package_id, &op.id),
                                )?
                                .is_some_and(|j| j.state.terminal())
                                {
                                    op.removed = true;
                                }
                                continue;
                            };
                            if [&op.consumer.package_id, &op.provider.package_id]
                                .into_iter()
                                .any(|id| {
                                    installed.iter().find(|p| &p.manifest.id == id).is_none_or(
                                        |p| {
                                            !p.enabled
                                                || (p.digest
                                                    != if p.manifest.id == a.consumer.package_id {
                                                        a.consumer.digest.clone()
                                                    } else {
                                                        a.provider.digest.clone()
                                                    }
                                                    && !ai_operations::replacement_recovers(
                                                        &p.manifest,
                                                        &a,
                                                    ))
                                        },
                                    )
                                })
                            {
                                op.removed = true;
                            }
                        }
                        self.applied += 1;
                    } else {
                        crashed?;
                    }
                }
            }
            Command::PausedMutation(slot, kind, action) => {
                self.paused_mutation(slot, kind, action)?
            }
            Command::SharedConsumerAdmit => {
                self.admit(0, false)?;
                self.admit((SLOTS - 1) as u8, false)?;
                if self
                    .operations
                    .borrow()
                    .iter()
                    .any(|op| op.consumer.package_id == self.fixture.second_consumer.manifest.id)
                {
                    self.applied += 1;
                }
            }
            Command::DelayedReceipt(slot, equal) => {
                if let Some(index) = self.index(slot) {
                    let ops = self.operations.borrow();
                    let op = &ops[index];
                    if let Some(latest) = checked(
                        self.store()
                            .provider_receipt(&op.consumer.package_id, &op.id),
                    )? {
                        let revision = latest["revision"].as_u64().unwrap();
                        if equal || revision > 1 {
                            let mut conflicting = latest.clone();
                            conflicting["revision"] =
                                json!(if equal { revision } else { revision - 1 });
                            conflicting["execution"] = json!({"state":"failed","error":{"code":"late_conflict","message":"Delayed conflicting evidence","correlationId":null}});
                            conflicting["delivery"] = json!({"state":"none"});
                            let a = checked(self.store().get(&op.consumer.package_id, &op.id))?
                                .unwrap();
                            let _ = service_bridge::reconcile_at(
                                self.store(),
                                &op.provider,
                                &a,
                                &conflicting,
                            );
                            let after = checked(
                                self.store()
                                    .provider_receipt(&op.consumer.package_id, &op.id),
                            )?;
                            if after.as_ref() != Some(&latest) {
                                return Err(fail(
                                    "delayed/equal conflicting receipt replaced newer evidence",
                                ));
                            }
                            self.applied += 1;
                        }
                    }
                }
            }
        }
        if self.observable() != before {
            *self.coverage.entry(command.family()).or_default() += 1;
        }
        self.invariants()
    }
    fn charges(&self) -> i64 {
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        conn.query_row("SELECT (SELECT coalesce(sum(bytes),0) FROM artifacts)+(SELECT coalesce(sum(bytes),0) FROM host_spools)",[],|r|r.get(0)).unwrap()
    }
    fn disk_bytes(&self) -> u64 {
        let root = self.fixture.profile.path().join("service-state");
        let artifacts: u64 = ["bytes", "stages"]
            .into_iter()
            .flat_map(|name| fs::read_dir(root.join(name)).unwrap())
            .map(|e| e.unwrap().metadata().unwrap().len())
            .sum();
        let spools: u64 = fs::read_dir(root.join("host-spools"))
            .unwrap()
            .map(|e| {
                let path = e.unwrap().path();
                ["stdout", "stderr"]
                    .into_iter()
                    .filter_map(|n| fs::metadata(path.join(n)).ok())
                    .map(|m| m.len())
                    .sum::<u64>()
            })
            .sum();
        artifacts + spools
    }
    fn original_conserved(&self, op: &Operation) -> bool {
        let root = self.fixture.profile.path().join("service-state");
        let mut paths = vec![op.copy.clone()];
        if let Some(stage) = &op.stage {
            paths.push(PathBuf::from(&stage.path));
            for extension in ["bin", "pending"] {
                paths.push(
                    root.join("bytes")
                        .join(format!("{}.{}", stage.handle, extension)),
                );
            }
        }
        if let Some(d) = &op.descriptor {
            paths.push(root.join("bytes").join(format!("{}.bin", d.handle)));
        }
        if let Some(spool) = &op.spool {
            paths.push(root.join("host-spools").join(spool).join("stdout"));
        }
        paths
            .into_iter()
            .any(|p| fs::read(p).ok().as_ref() == Some(&op.original))
            || self.oracle.contains_unflushed_data(&op.original)
            || (op.writer.is_some() && op.spool_phase >= 1 && op.paid_success && op.valid_original)
    }
    fn invariants(&mut self) -> Result<(), TestCaseError> {
        if self.store.is_none() {
            return Ok(());
        }
        for job in checked(self.store().snapshot_jobs())?.jobs {
            if let Some(old) = self.jobs.get(&job.job_key) {
                if job.revision < old.revision {
                    return Err(fail("job revision regressed"));
                }
                if old.state == JobState::Completed && job.state != JobState::Completed {
                    return Err(fail("acknowledged completion regressed"));
                }
            }
            if job.state == JobState::Completed {
                let ops = self.operations.borrow();
                let op = ops.iter().find(|o| o.id == job.operation_id).unwrap();
                if !op.acknowledged
                    || fs::read(job.output_path.as_ref().unwrap()).ok().as_ref()
                        != Some(&op.original)
                {
                    return Err(fail("Completed lacks delivered original bytes"));
                }
            }
            self.jobs.insert(job.job_key.clone(), job);
        }
        let restored: BTreeMap<_, _> = self.oracle.unflushed_data_paths().into_iter().collect();
        let possible_file_bytes = |path: &PathBuf| {
            fs::metadata(path)
                .map_or(0, |m| m.len())
                .max(restored.get(path).copied().unwrap_or(0))
        };
        let mut live_reservations = 0u64;
        let mut reserved_output_bytes = 0u64;
        for op in self.operations.borrow().iter() {
            if op.consumer_runs.get() > 1 || op.delivery_effects.get() > 1 {
                return Err(fail(format!(
                    "duplicate delivery effects: {}, count={}",
                    op.id,
                    op.delivery_effects.get()
                )));
            }
            if op.acknowledged && op.delivery_effects.get() != 1 {
                return Err(fail(format!(
                    "acknowledged without exactly one delivery effect: {}",
                    op.id
                )));
            }
            if op.starts.get() != usize::from(op.dispatched)
                || op.recovery_native_starts.get() != 0
                || op.native_paid_starts.get() > 1
            {
                return Err(fail(format!("paid execution replayed: {}", op.id)));
            }
            let admission = checked(self.store().get(&op.consumer.package_id, &op.id))?;
            if !op.dispatched {
                let job = checked(
                    self.store()
                        .job_for_operation(&op.consumer.package_id, &op.id),
                )?
                .unwrap();
                if op.removed {
                    if !job.state.terminal() {
                        return Err(fail("removed preparation retained Accepting presentation"));
                    }
                } else {
                    if job.state != JobState::Accepting {
                        return Err(fail(format!(
                            "compatible replacement discarded accepting preparation: {}",
                            op.id
                        )));
                    }
                    let root = self.fixture.profile.path().join("service-state/bytes");
                    for input in &op.captured_inputs {
                        if fs::read(root.join(format!("{}.bin", input.handle)))
                            .ok()
                            .as_ref()
                            != Some(&op.original)
                        {
                            return Err(fail(format!(
                                "retained preparation lost captured bytes: {}",
                                op.id
                            )));
                        }
                    }
                    if admission.is_some() {
                        return Err(fail("presentation phase unexpectedly dispatched service"));
                    }
                }
                continue;
            }
            let a = admission.ok_or_else(|| fail("dispatched operation lost admission"))?;
            let execution_released = checked(
                self.store()
                    .execution_released(&op.consumer.package_id, &op.id),
            )?;
            if op.stopped.get() && !execution_released && !op.paid_success && !op.removed {
                return Err(fail(
                    "idle execution fence revived without original success",
                ));
            }
            if execution_released {
                op.stopped.set(true);
            }
            if matches!(
                a.phase,
                AdmissionPhase::Forwarding | AdmissionPhase::Accepted
            ) && op.descriptor.is_none()
                && !checked(
                    self.store()
                        .execution_released(&op.consumer.package_id, &op.id),
                )?
            {
                // The public image contract reserves room for the stage and
                // immutable copy before dispatching this live paid request.
                live_reservations += 100 * 1024 * 1024;
                if let Some(stage) = &op.stage {
                    let root = self.fixture.profile.path().join("service-state");
                    reserved_output_bytes += [
                        PathBuf::from(&stage.path),
                        root.join("bytes").join(format!("{}.bin", stage.handle)),
                        root.join("bytes").join(format!("{}.pending", stage.handle)),
                    ]
                    .into_iter()
                    .map(|path| possible_file_bytes(&path))
                    .sum::<u64>();
                }
            }
            if op.paid_success && !op.removed && a.disposition.as_deref() == Some("discarded") {
                return Err(fail(format!("success discarded: {}", op.id)));
            }
            if !op.removed
                && !op.acknowledged
                && !op.paid_success
                && (op.provider_live
                    || op.consumer_live
                    || op.writer.is_some() && !op.unpaid_repair)
                && checked(
                    self.store()
                        .execution_released(&op.consumer.package_id, &op.id),
                )?
            {
                return Err(fail("automatic settlement released live worker execution"));
            }
            if op.removed
                && (a.phase != AdmissionPhase::Released
                    || self
                        .store()
                        .job_for_operation(&op.consumer.package_id, &op.id)
                        .unwrap()
                        .is_some_and(|j| !j.state.terminal()))
            {
                return Err(fail("removal retained active custody/job"));
            }
            if op.valid_original && !op.removed && !self.original_conserved(op) {
                return Err(fail(format!("original bytes disappeared: {}", op.id)));
            }
            if op.acknowledged && fs::read(&op.copy).ok().as_ref() != Some(&op.original) {
                return Err(fail("acknowledged original lost"));
            }
        }
        self.custodyless_invariants(false)?;
        let charge = self.charges();
        let restored_excess: u64 = restored
            .iter()
            .map(|(path, bytes)| bytes.saturating_sub(fs::metadata(path).map_or(0, |m| m.len())))
            .sum();
        let possible = self.disk_bytes() + restored_excess;
        let reserved_and_retained =
            live_reservations + possible.saturating_sub(reserved_output_bytes);
        if charge < 0 || (charge as u64) < possible.max(reserved_and_retained) {
            return Err(fail(format!(
                "quota undercharge: charge={charge}, possible bytes={possible}, live reservations and retained bytes={reserved_and_retained}"
            )));
        }
        Ok(())
    }
    fn assert_removed_clean(&self, op: &Operation) -> Result<(), TestCaseError> {
        self.assert_custody_clean(op, true)
    }
    fn assert_custody_clean(&self, op: &Operation, removal: bool) -> Result<(), TestCaseError> {
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        let custody: i64 = conn.query_row(
            "SELECT (SELECT count(*) FROM artifacts WHERE consumer=?1 AND operation=?2 AND (?3 OR bytes>0))+(SELECT count(*) FROM host_spools WHERE consumer=?1 AND operation=?2)+(SELECT count(*) FROM host_spool_admissions WHERE consumer=?1 AND operation=?2)",
            rusqlite::params![op.consumer.package_id, op.id, removal],
            |row| row.get(0),
        ).unwrap();
        let root = self.fixture.profile.path().join("service-state");
        let spool_exists = op
            .spool
            .iter()
            .chain(op.extra_spools.iter())
            .any(|h| root.join("host-spools").join(h).exists());
        let artifact_exists = op.stage.as_ref().is_some_and(|stage| {
            PathBuf::from(&stage.path).exists()
                || ["bin", "pending"].into_iter().any(|ext| {
                    root.join("bytes")
                        .join(format!("{}.{ext}", stage.handle))
                        .exists()
                })
        }) || op.descriptor.as_ref().is_some_and(|d| {
            root.join("bytes")
                .join(format!("{}.bin", d.handle))
                .exists()
        });
        if custody != 0 || spool_exists || artifact_exists {
            return Err(fail(format!("operation retained custody, charged rows or files after cleanup (removal={removal}): {}, rows={custody}, spool={spool_exists}, artifacts={artifact_exists}", op.id)));
        }
        Ok(())
    }
    fn assert_removed_plugins_clean(&self) -> Result<(), TestCaseError> {
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        let installed = package::list(&self.fixture.root).unwrap();
        for package in [
            self.fixture.id(Role::Consumer),
            &self.fixture.second_consumer.manifest.id,
            self.fixture.id(Role::Provider),
        ] {
            if installed
                .iter()
                .any(|p| p.manifest.id == package && p.enabled)
            {
                continue;
            }
            let charged: i64 = conn.query_row(
                "SELECT (SELECT coalesce(sum(bytes),0) FROM artifacts WHERE consumer=?1)+(SELECT coalesce(sum(bytes),0) FROM host_spools WHERE package=?1 OR consumer=?1)",
                [package], |row| row.get(0),
            ).unwrap();
            if charged != 0 {
                return Err(fail(format!(
                    "removed plugin retained charged custody: {package}, bytes={charged}"
                )));
            }
            for op in
                self.operations.borrow().iter().filter(|op| {
                    op.consumer.package_id == package || op.provider.package_id == package
                })
            {
                self.assert_removed_clean(op)?;
            }
        }
        Ok(())
    }
    fn quiesce(&mut self) -> Result<(), TestCaseError> {
        let (result, events) = backend::capture_job_events(|| self.quiesce_inner());
        self.observe_events(events)?;
        result
    }
    fn quiesce_inner(&mut self) -> Result<(), TestCaseError> {
        self.healthy = true;
        self.unlink_failure = false;
        self.sync_failure = false;
        self.oracle.faults(false, false);
        if self.store.is_none() {
            self.restart(false)?
        }
        for slot in 0..SLOTS as u8 {
            self.dispatch(slot)?;
            self.cancel_preparation(slot)?;
        }
        for op in self.operations.borrow_mut().iter_mut() {
            if !op.removed && op.spool_phase <= 17 && op.paid_success {
                if let Some(writer) = &op.writer {
                    for point in op.spool_phase..=17 {
                        checked(writer.phase(point))?;
                    }
                    op.spool_phase = 18;
                    op.durable_original |= op.valid_original;
                }
            }
            op.writer.take();
            op.provider_live = false;
            op.consumer_live = false;
            if op.outcome == Outcome::Running {
                op.outcome = Outcome::Unknown
            }
        }
        for spool in &mut self.custodyless {
            // Quiescence is a proven-dead native worker. Relinquish its real
            // permit before evaluating lifecycle collection completion.
            spool.writer.take();
        }
        for _ in 0..4 {
            let _ = self.sweep();
            checked(self.store().gc())?;
            checked(self.store().sweep_host_spools(|_| false))?;
        }
        self.invariants()?;
        self.custodyless_invariants(true)?;
        for slot in 0..SLOTS as u8 {
            self.custodyless_release(slot)?;
        }
        checked(self.store().gc())?;
        checked(self.store().sweep_host_spools(|_| false))?;
        self.custodyless_invariants(true)?;
        for op in self.operations.borrow().iter() {
            if !op.dispatched {
                if op.removed {
                    self.assert_removed_clean(op)?;
                }
                continue;
            }
            let a = self
                .store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            let job = self
                .store()
                .job_for_operation(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            if op.removed {
                self.assert_removed_clean(op)?;
                continue;
            }
            if op.paid_success
                && op.valid_original
                && (!op.acknowledged
                    || job.state != JobState::Completed
                    || fs::read(&op.copy).ok().as_ref() != Some(&op.original))
            {
                return Err(fail(format!("valid original never delivered: {}", op.id)));
            }
            if !op.valid_original
                && job.state.terminal()
                && (a.phase == AdmissionPhase::Released
                    || self
                        .store()
                        .execution_released(&op.consumer.package_id, &op.id)
                        .unwrap())
            {
                self.assert_custody_clean(op, false)?;
            }
            if !op.valid_original
                && (!job.state.terminal()
                    || a.phase != AdmissionPhase::Released
                        && !self
                            .store()
                            .execution_released(&op.consumer.package_id, &op.id)
                            .unwrap())
            {
                return Err(fail(format!("inactive operation never settled: {}, admission={a:?}, job={job:?}, receipt={:?}", op.id, self.store().provider_receipt(&op.consumer.package_id,&op.id))));
            }
        }
        self.assert_removed_plugins_clean()?;
        if self.charges() as u64 != self.disk_bytes() {
            return Err(fail(format!(
                "quiescent quota mismatch: charge={}, disk={}",
                self.charges(),
                self.disk_bytes()
            )));
        }
        let claims = checked(self.store().claims())?;
        if !claims.is_empty() {
            return Err(fail(format!(
                "quiescent operation capacity held: {claims:?}"
            )));
        }
        Ok(())
    }
}
/// Native process and RPC implementation for the fixture packages. The host
/// routes recovery through the same RecoveryPort path used by LiveAutomatic;
/// only the packages' status and resume RPC effects are simulated here.
struct FixtureRpc<'a> {
    machine: &'a Machine,
}
impl FixtureRpc<'_> {
    fn status(&self, a: &Admission) -> Result<(), AppError> {
        let m = self.machine;
        if !m.healthy {
            return Err(AppError::Other(
                "Injected unhealthy status transport".into(),
            ));
        }
        let mut ops = m.operations.borrow_mut();
        let op = ops.iter_mut().find(|o| o.id == a.operation_id).unwrap();
        if op.removed || op.acknowledged {
            return Ok(());
        }
        // This is the fake provider's status RPC: it finds existing paid bytes
        // and publishes its receipt. It cannot start paid work.
        let _permit = m.store().output_recovery_guard(a)?;
        if op.descriptor.is_none() && !op.provider_rejected() {
            if let Some(spool) = m.store().host_spool_result_for_operation(
                &op.provider.package_id,
                &op.spool_request,
                &op.consumer.package_id,
                &op.id,
                None,
            )? {
                if spool["status"] == 0 {
                    op.paid_success = true;
                    native_work_started(
                        op,
                        NativeContext::Recovery,
                        NativeIntent::LocalReconstruction,
                    );
                    let stage = m
                        .store()
                        .stage(&op.provider, &op.consumer.package_id, &op.id)?;
                    fs::copy(spool["stdout"].as_str().unwrap(), &stage.path)?;
                    op.stage = Some(stage);
                }
            }
            if let Some(stage) = &op.stage {
                if let Ok(d) = m.store().seal(
                    &op.provider,
                    &op.consumer.package_id,
                    &op.id,
                    &stage.handle,
                    "image/png",
                ) {
                    op.descriptor = Some(d);
                    op.valid_original = true;
                    op.durable_original = true;
                    op.outcome = Outcome::Succeeded;
                }
            }
        }
        if op.descriptor.is_some() {
            op.paid_success = true;
            op.outcome = Outcome::Succeeded;
        }
        let current = m.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        service_bridge::reconcile_at(
            m.store(),
            &op.provider,
            &current,
            &op.receipt(op.delivery()),
        )
    }
    fn consumer_resume(&self, a: &Admission) -> Result<(), AppError> {
        self.status(a)?;
        let m = self.machine;
        let index = m
            .operations
            .borrow()
            .iter()
            .position(|o| o.id == a.operation_id)
            .unwrap();
        // Superseded slots remain real retained operations; their RPC still
        // receives the original operation identity, independent of UI slots.
        let mut ops = m.operations.borrow_mut();
        let op = &mut ops[index];
        op.resume_calls.set(op.resume_calls.get() + 1);
        if op.removed || op.acknowledged {
            return Ok(());
        }
        let current = m.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        let Some(d) = current.output.as_ref() else {
            return Ok(());
        };
        let proof = if let Some(transfer) = &op.transfer {
            m.store()
                .verify_acquisition(&op.consumer, &op.id, &d.sha256, transfer)?;
            TransferReceipt {
                transfer_receipt: transfer.clone(),
            }
        } else {
            let source = m
                .store()
                .read(&op.consumer, &op.consumer.package_id, &op.id, d)?;
            op.consumer_runs.set(op.consumer_runs.get() + 1);
            op.copy = op.copy.parent().unwrap().join(format!(
                "{}-consumer-run-{}.png",
                op.id,
                op.consumer_runs.get()
            ));
            fs::copy(source.path, &op.copy)?;
            op.delivery_effects.set(op.delivery_effects.get() + 1);
            m.store()
                .acquired(&op.consumer, &op.id, d, op.copy.to_str().unwrap())?
        };
        op.transfer = Some(proof.transfer_receipt.clone());
        m.store().release(
            &op.provider,
            &op.consumer.package_id,
            &op.id,
            "acquired",
            Some(&proof.transfer_receipt),
        )?;
        op.acknowledged = true;
        op.valid_original = true;
        op.durable_original = true;
        m.store()
            .complete_acquired_job(&op.consumer.package_id, &op.id)?;
        if let Some(spool) = &op.spool {
            m.store()
                .release_host_spool(&op.provider.package_id, spool)?;
        }
        Ok(())
    }
}
impl ai_operations::RecoveryPort for FixtureRpc<'_> {
    fn provider_status(
        &self,
        store: &Store,
        a: &Admission,
    ) -> Result<(PackageGeneration, Value), AppError> {
        self.status(a)?;
        Ok((
            a.provider.clone(),
            store
                .provider_receipt(&a.consumer.package_id, &a.operation_id)?
                .ok_or_else(|| AppError::Other("Fixture provider has no receipt".into()))?,
        ))
    }
    fn resume(&self, store: &Store, a: &Admission, job: &JobRecord) -> Result<(), AppError> {
        job_bridge::resume_in(store, job, || self.consumer_resume(a)).map(|_| ())
    }
    fn terminal_resume(
        &self,
        _: &Store,
        a: &Admission,
        _: Option<&JobRecord>,
    ) -> Result<(), AppError> {
        self.consumer_resume(a)
    }
}
/// The fake RPC has been invoked and captured its response before the real
/// lifecycle mutation executes. Reconciliation and handoff happen only after
/// that mutation, exercising a response already in flight rather than merely
/// a queued recovery snapshot.
struct PausedRecoveryRpc<'a> {
    machine: RefCell<&'a mut Machine>,
    mutation: Command,
    entered: Cell<bool>,
    violation: RefCell<Option<String>>,
}
impl PausedRecoveryRpc<'_> {
    fn fail(&self, message: &str) -> AppError {
        *self.violation.borrow_mut() = Some(message.into());
        AppError::Other(message.into())
    }
    fn response(
        &self,
        store: &Store,
        a: &Admission,
    ) -> Result<(PackageGeneration, Value), AppError> {
        let mut machine = self.machine.borrow_mut();
        let response = {
            let ops = machine.operations.borrow();
            let op = ops.iter().find(|op| op.id == a.operation_id).unwrap();
            (op.provider.clone(), op.receipt(op.delivery()))
        };
        self.entered.set(true);
        if let Err(error) = machine.mutation(self.mutation) {
            return Err(self.fail(&error.to_string()));
        }
        let current = store.get(&a.consumer.package_id, &a.operation_id)?.unwrap();
        if machine
            .operations
            .borrow()
            .iter()
            .find(|op| op.id == a.operation_id)
            .unwrap()
            .removed
            && current.phase != AdmissionPhase::Released
        {
            return Err(self.fail("Lifecycle failed to fence in-flight recovery RPC"));
        }
        Ok(response)
    }
    fn invoke(&self, store: &Store, a: &Admission) -> Result<(), AppError> {
        let (provider, receipt) = self.response(store, a)?;
        // This response was captured before disable/uninstall/replacement.
        // Submit it through the actual receipt projection and read grants.
        let _ = service_bridge::reconcile_at(store, &provider, a, &receipt);
        let machine = self.machine.borrow();
        let removed = machine
            .operations
            .borrow()
            .iter()
            .find(|op| op.id == a.operation_id)
            .unwrap()
            .removed;
        if removed {
            let current = store.get(&a.consumer.package_id, &a.operation_id)?.unwrap();
            if current.phase != AdmissionPhase::Released {
                return Err(self.fail("Stale recovery RPC revived removed custody"));
            }
            if let Some(output) = a.output.as_ref() {
                if store
                    .read(&a.consumer, &a.consumer.package_id, &a.operation_id, output)
                    .is_ok()
                {
                    return Err(self.fail("Stale recovery RPC retained its read grant"));
                }
            }
            return Ok(());
        }
        FixtureRpc { machine: &machine }.consumer_resume(a)
    }
}
impl ai_operations::RecoveryPort for PausedRecoveryRpc<'_> {
    fn provider_status(
        &self,
        store: &Store,
        a: &Admission,
    ) -> Result<(PackageGeneration, Value), AppError> {
        self.response(store, a)
    }
    fn resume(&self, store: &Store, a: &Admission, job: &JobRecord) -> Result<(), AppError> {
        job_bridge::resume_in(store, job, || self.invoke(store, a)).map(|_| ())
    }
    fn terminal_resume(
        &self,
        store: &Store,
        a: &Admission,
        _: Option<&JobRecord>,
    ) -> Result<(), AppError> {
        self.invoke(store, a)
    }
}
struct Transport<'a> {
    machine: &'a Machine,
}
impl ai_operations::AutomaticPort for Transport<'_> {
    fn active(
        &self,
        a: &Admission,
        _: Option<&JobRecord>,
        _: bool,
        _: &str,
    ) -> Result<bool, AppError> {
        FixtureRpc {
            machine: self.machine,
        }
        .status(a)?;
        let ops = self.machine.operations.borrow();
        let op = ops.iter().find(|o| o.id == a.operation_id).unwrap();
        Ok(!op.removed
            && !op.acknowledged
            && (op.provider_live || op.consumer_live || op.writer.is_some()))
    }
    fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
        ai_operations::recover_in(
            self.machine.store(),
            a,
            job,
            &FixtureRpc {
                machine: self.machine,
            },
        )
    }
}

const MIN_DEEP_TRANSITION_HITS: u64 = 3;
const REQUIRED_TRANSITIONS: &[&str] = &[
    "admit",
    "presentation-register",
    "preparation-capture",
    "service-dispatch",
    "preparation-cancel",
    "custodyless-reserve",
    "custodyless-reply-boundary",
    "custodyless-release",
    "stage-durable",
    "stage-unsynced",
    "stage-partial",
    "active-recovery-writer-gc",
    "crash-midwrite",
    "seal",
    "provider-complete",
    "publication-failure",
    "publish-success",
    "publish-unknown",
    "publish-failed",
    "publish-cancelled",
    "host-spool",
    "fenced-unbound-repair",
    "replacement-provider-unbound-spool",
    "ambiguous-unbound-refusal",
    "provider-request-counter-collision",
    "healthy-probe",
    "unhealthy-probe",
    "provider-active",
    "consumer-active",
    "worker-idle",
    "acquire",
    "ack-crash",
    "ack-complete",
    "consumer-receive-crash",
    "consumer-receive-complete",
    "replay-fence",
    "provider-compatible",
    "consumer-compatible",
    "provider-incompatible",
    "consumer-incompatible",
    "disable",
    "reenable",
    "uninstall",
    "sweep",
    "gc",
    "unlink-fault",
    "directory-sync-fault",
    "restart",
    "power-loss",
    "equal-conflicting-receipt",
    "delayed-lower-receipt",
    "shared-provider-consumers",
    "bound-spool-reserve",
    "unbound-spool-reserve",
    "nonzero-spool-reserve",
    "spool-intent-commit",
    "spool-pending-create",
    "spool-pending-partial",
    "spool-pending-full",
    "spool-pending-file-sync",
    "spool-pending-directory-sync",
    "spool-stdout-create",
    "spool-stdout-partial",
    "spool-stdout-full",
    "spool-stdout-file-sync",
    "spool-stderr-create",
    "spool-stderr-partial",
    "spool-stderr-full",
    "spool-stderr-file-sync",
    "spool-witness-file-sync",
    "spool-directory-sync",
    "spool-parent-directory-sync",
    "spool-pending-commit",
    "spool-output-fsync",
    "spool-manifest-temp-create",
    "spool-manifest-partial",
    "spool-manifest-full",
    "spool-manifest-temp-sync",
    "spool-manifest-rename",
    "spool-manifest-target-sync",
    "spool-manifest-directory-sync",
    "spool-manifest-parent-sync",
    "spool-seal-commit",
    "crash-after-spool-reserve",
    "crash-within-reply-persistence",
    "crash-after-spool-pending",
    "crash-after-spool-fsync",
    "crash-within-spool-manifest",
    "crash-after-spool-seal",
    "settlement-crash-before-collection",
    "crash-lifecycle-intent",
    "crash-lifecycle-index",
    "crash-lifecycle-abandonment",
    "crash-lifecycle-cleanup",
    "crash-upgrade-prepared",
    "crash-upgrade-committed",
    "crash-upgrade-published",
    "crash-replacement-abandoned",
    "recovery-rpc-paused-disable",
    "recovery-rpc-paused-uninstall",
    "recovery-rpc-paused-compatible-upgrade",
    "recovery-rpc-paused-incompatible-upgrade",
    "acquisition-paused-disable",
    "acquisition-paused-uninstall",
    "acquisition-paused-compatible-upgrade",
    "acquisition-paused-incompatible-upgrade",
    "native-writer-paused-disable",
    "native-writer-paused-uninstall",
    "native-writer-paused-compatible-upgrade",
    "native-writer-paused-incompatible-upgrade",
];
fn collect_trace(
    trace: Vec<Command>,
    totals: &mut BTreeMap<&'static str, u64>,
) -> Result<(), TestCaseError> {
    let mut machine = Machine::new();
    machine.admit(0, false)?;
    for command in &trace {
        machine
            .apply(*command)
            .map_err(|cause| fail(format!("trace={trace:?}, at={command:?}: {cause}")))?;
    }
    machine
        .quiesce()
        .map_err(|cause| fail(format!("trace={trace:?}, quiesce: {cause}")))?;
    for (family, hits) in std::mem::take(&mut machine.coverage) {
        *totals.entry(family).or_default() += hits;
    }
    Ok(())
}
/// Directed schedules complement random exploration: every required boundary
/// is reached with real preconditions, then random commands interleave those
/// same transitions. A missing/inert transition is a failing deep run.
fn coverage_campaign(totals: &mut BTreeMap<&'static str, u64>) -> Result<(), TestCaseError> {
    for _ in 0..MIN_DEEP_TRANSITION_HITS {
        collect_trace(
            vec![
                Command::Register(1),
                Command::Capture(1),
                Command::CancelPreparation(1),
            ],
            totals,
        )?;
        collect_trace(
            vec![
                Command::Register(1),
                Command::Capture(1),
                Command::Upgrade(false, true, false),
                Command::Dispatch(1),
            ],
            totals,
        )?;
        for incompatible in [false, true] {
            let mut machine = Machine::new();
            machine.apply(Command::CustodylessReserve(0))?;
            for point in 1..=28 {
                machine.apply(Command::CustodylessReply(0, point))?;
            }
            if incompatible {
                machine.apply(Command::Upgrade(true, false, false))?;
            } else {
                machine.apply(Command::CustodylessRelease(0))?;
            }
            machine.quiesce()?;
            for (family, hits) in std::mem::take(&mut machine.coverage) {
                *totals.entry(family).or_default() += hits;
            }
        }
        collect_trace(vec![Command::Sweep, Command::UnboundRepair(0)], totals)?;
        collect_trace(
            vec![Command::SharedConsumerAdmit, Command::AmbiguousSpool(0)],
            totals,
        )?;
        collect_trace(
            vec![
                Command::Spool(0),
                Command::Upgrade(true, true, false),
                Command::ReplacementCollision(0),
            ],
            totals,
        )?;
        collect_trace(
            vec![
                Command::Upgrade(true, true, false),
                Command::ReplacementSpool(0),
                Command::Enable(false, false),
            ],
            totals,
        )?;
        for phase in 1..=29 {
            let mut trace = vec![Command::SpoolReserve(0, true, false)];
            trace.extend(
                [
                    Command::SpoolReply(0),
                    Command::SpoolReplyStep(0, 2),
                    Command::SpoolReplyStep(0, 3),
                    Command::SpoolReplyStep(0, 4),
                    Command::SpoolReplyStep(0, 5),
                    Command::SpoolReplyStep(0, 6),
                    Command::SpoolReplyStep(0, 7),
                    Command::SpoolReplyStep(0, 8),
                    Command::SpoolReplyStep(0, 9),
                    Command::SpoolReplyStep(0, 10),
                    Command::SpoolReplyStep(0, 11),
                    Command::SpoolReplyStep(0, 12),
                    Command::SpoolReplyStep(0, 13),
                    Command::SpoolReplyStep(0, 14),
                    Command::SpoolReplyStep(0, 15),
                    Command::SpoolReplyStep(0, 16),
                    Command::SpoolReplyStep(0, 17),
                    Command::SpoolPending(0),
                    Command::SpoolFsync(0),
                    Command::SpoolManifest(0),
                    Command::SpoolManifestStep(0, 2),
                    Command::SpoolManifestStep(0, 3),
                    Command::SpoolManifestStep(0, 4),
                    Command::SpoolManifestStep(0, 5),
                    Command::SpoolManifestStep(0, 6),
                    Command::SpoolManifestStep(0, 7),
                    Command::SpoolManifestStep(0, 8),
                    Command::SpoolSeal(0),
                ]
                .into_iter()
                .take(usize::from(phase - 1)),
            );
            trace.push(Command::SpoolCrash(0, phase));
            collect_trace(trace, totals)?;
        }
        for bound in [false, true] {
            collect_trace(
                vec![
                    Command::SpoolReserve(0, bound, true),
                    Command::SpoolReply(0),
                    Command::SpoolReplyStep(0, 2),
                    Command::SpoolReplyStep(0, 3),
                    Command::SpoolReplyStep(0, 4),
                    Command::SpoolReplyStep(0, 5),
                    Command::SpoolReplyStep(0, 6),
                    Command::SpoolReplyStep(0, 7),
                    Command::SpoolReplyStep(0, 8),
                    Command::SpoolReplyStep(0, 9),
                    Command::SpoolReplyStep(0, 10),
                    Command::SpoolReplyStep(0, 11),
                    Command::SpoolReplyStep(0, 12),
                    Command::SpoolReplyStep(0, 13),
                    Command::SpoolReplyStep(0, 14),
                    Command::SpoolReplyStep(0, 15),
                    Command::SpoolReplyStep(0, 16),
                    Command::SpoolReplyStep(0, 17),
                    Command::SpoolPending(0),
                    Command::SpoolFsync(0),
                    Command::SpoolManifest(0),
                    Command::SpoolManifestStep(0, 2),
                    Command::SpoolManifestStep(0, 3),
                    Command::SpoolManifestStep(0, 4),
                    Command::SpoolManifestStep(0, 5),
                    Command::SpoolManifestStep(0, 6),
                    Command::SpoolManifestStep(0, 7),
                    Command::SpoolManifestStep(0, 8),
                    Command::SpoolSeal(0),
                    Command::Publish(0, 2, false),
                    Command::SettlementCrash(0),
                ],
                totals,
            )?;
            collect_trace(
                vec![
                    Command::SpoolReserve(0, bound, false),
                    Command::SpoolReply(0),
                    Command::SpoolReplyStep(0, 2),
                    Command::SpoolReplyStep(0, 3),
                    Command::SpoolReplyStep(0, 4),
                    Command::SpoolReplyStep(0, 5),
                    Command::SpoolReplyStep(0, 6),
                    Command::SpoolReplyStep(0, 7),
                    Command::SpoolReplyStep(0, 8),
                    Command::SpoolReplyStep(0, 9),
                    Command::SpoolReplyStep(0, 10),
                    Command::SpoolReplyStep(0, 11),
                    Command::SpoolReplyStep(0, 12),
                    Command::SpoolReplyStep(0, 13),
                    Command::SpoolReplyStep(0, 14),
                    Command::SpoolReplyStep(0, 15),
                    Command::SpoolReplyStep(0, 16),
                    Command::SpoolReplyStep(0, 17),
                    Command::SpoolPending(0),
                    Command::SpoolFsync(0),
                    Command::SpoolManifest(0),
                    Command::SpoolManifestStep(0, 2),
                    Command::SpoolManifestStep(0, 3),
                    Command::SpoolManifestStep(0, 4),
                    Command::SpoolManifestStep(0, 5),
                    Command::SpoolManifestStep(0, 6),
                    Command::SpoolManifestStep(0, 7),
                    Command::SpoolManifestStep(0, 8),
                    Command::SpoolSeal(0),
                    Command::Enable(false, false),
                ],
                totals,
            )?;
        }
        for point in 0..=7 {
            collect_trace(
                vec![Command::Spool(0), Command::LifecycleCrash(false, point)],
                totals,
            )?;
        }
        for kind in 0..=2 {
            for action in 0..=3 {
                let mut trace = if kind <= 1 {
                    vec![Command::ProviderComplete(0)]
                } else {
                    vec![]
                };
                trace.push(Command::PausedMutation(0, kind, action));
                collect_trace(trace, totals)?;
            }
        }
        for (role, compatible) in [(true, true), (false, true), (true, false), (false, false)] {
            collect_trace(
                vec![Command::Spool(0), Command::Upgrade(role, compatible, false)],
                totals,
            )?;
        }
        for (complete, synced) in [(false, false), (true, false), (true, true)] {
            collect_trace(
                vec![Command::Stage(0, complete, synced), Command::Seal(0)],
                totals,
            )?;
        }
        collect_trace(
            vec![Command::RecoveryWriterGc(0), Command::CrashMidWrite(0)],
            totals,
        )?;
        for ack in [
            Command::Ack(0, true),
            Command::Ack(0, false),
            Command::ConsumerReceive(0, true),
            Command::ConsumerReceive(0, false),
        ] {
            collect_trace(
                vec![
                    Command::ProviderComplete(0),
                    Command::Acquire(0),
                    ack,
                    Command::Restart,
                ],
                totals,
            )?;
        }
        for outcome in 0..=3 {
            collect_trace(
                vec![
                    Command::Publish(0, outcome, true),
                    Command::Publish(0, outcome, false),
                ],
                totals,
            )?;
        }
        collect_trace(
            vec![
                Command::SharedConsumerAdmit,
                Command::Publish(0, 1, false),
                Command::Publish(0, 1, false),
                Command::DelayedReceipt(0, false),
                Command::DelayedReceipt(0, true),
                Command::Replay(0),
                Command::WorkerActive(0, true, true),
                Command::WorkerActive(0, false, true),
                Command::Probe(true),
                Command::WorkerActive(0, true, false),
                Command::WorkerActive(0, false, false),
                Command::Probe(false),
                Command::Probe(true),
                Command::UnlinkFailure(true),
                Command::UnlinkFailure(false),
                Command::DirectorySyncFailure(true),
                Command::DirectorySyncFailure(false),
                Command::Sweep,
                Command::Gc,
                Command::PowerLoss,
                Command::Enable(false, false),
                Command::Enable(false, true),
                Command::Admit(1, true),
                Command::Uninstall(false),
            ],
            totals,
        )?;
    }
    Ok(())
}
fn run(cases: u32, steps: usize) {
    let totals = RefCell::new(BTreeMap::<&'static str, u64>::new());
    if cases >= 1024 {
        coverage_campaign(&mut totals.borrow_mut()).unwrap();
    }
    let mut runner = TestRunner::new(Config {
        cases,
        max_shrink_iters: 10_000,
        source_file: Some(file!()),
        ..Config::default()
    });
    runner
        .run(&commands(steps), |commands| {
            let mut m = Machine::new();
            // Start empty so no-admission schedules are reproducible while
            // shrinking; admission is a generated command, not global case parity.
            for command in commands {
                m.apply(command)?
            }
            m.quiesce()?;
            for (family, n) in std::mem::take(&mut m.coverage) {
                *totals.borrow_mut().entry(family).or_default() += n;
            }
            Ok(())
        })
        .unwrap();
    let totals = totals.into_inner();
    if cases >= 1024 {
        let missing: Vec<_> = REQUIRED_TRANSITIONS
            .iter()
            .map(|name| (*name, totals.get(name).copied().unwrap_or(0)))
            .filter(|(_, hits)| *hits < MIN_DEEP_TRANSITION_HITS)
            .collect();
        assert!(missing.is_empty(), "deep model requires >= {MIN_DEEP_TRANSITION_HITS} actual hits per transition; missing coverage: {missing:?}");
        println!(
            "model required coverage: {} transitions >= {} hits; ack-crash={}",
            REQUIRED_TRANSITIONS.len(),
            MIN_DEEP_TRANSITION_HITS,
            totals["ack-crash"]
        );
    }
    println!("model applied transition coverage ({cases} cases): {totals:?}");
}
#[test]
fn ai_operations_reference_state_machine() {
    run(64, 40)
}
#[test]
fn model_unknown_valid_original_converges() {
    for synced in [false, true] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.apply(Command::Stage(0, true, synced)).unwrap();
        m.quiesce().unwrap();
    }
}
#[test]
fn model_regression_settled_recovery_writer_keeps_stage() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    m.apply(Command::Stage(0, false, false)).unwrap();
    m.quiesce().unwrap();
}
#[test]
fn model_regression_sync_fault_does_not_block_incompatible_upgrade() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    m.apply(Command::DirectorySyncFailure(true)).unwrap();
    m.apply(Command::Upgrade(false, false, false)).unwrap();
    m.quiesce().unwrap();
}
#[test]
fn model_recovered_ack_crash_converges_without_run_id() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::Sweep,
        Command::ProviderComplete(0),
        Command::Acquire(0),
        Command::Ack(0, true),
    ] {
        m.apply(command).unwrap();
    }
    m.quiesce().unwrap();
    let job = m.store().snapshot_jobs().unwrap().jobs.pop().unwrap();
    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.run_id, None);
}
#[test]
fn model_regression_cached_running_keeps_idle_capacity() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::Sweep,
        Command::Upgrade(false, true, false),
        Command::DirectorySyncFailure(true),
        Command::Probe(true),
    ] {
        m.apply(command).unwrap();
    }
    m.quiesce().unwrap();
}
#[test]
fn model_live_unknown_waits_for_both_worker_proofs() {
    for provider in [false, true] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        for command in [
            Command::WorkerActive(0, provider, true),
            Command::Publish(0, 1, false),
            Command::Probe(true),
        ] {
            m.apply(command).unwrap();
        }
        let ops = m.operations.borrow();
        let op = &ops[0];
        assert!(!m
            .store()
            .execution_released(&op.consumer.package_id, &op.id)
            .unwrap());
        drop(ops);
        m.apply(Command::WorkerActive(0, provider, false)).unwrap();
        m.quiesce().unwrap();
    }
}
#[test]
#[ignore = "deep property exploration; run explicitly for service/lifecycle changes"]
fn ai_operations_reference_state_machine_deep() {
    run(1024, 100)
}

#[test]
fn model_removal_cleans_unbound_provider_spool() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    {
        let mut ops = m.operations.borrow_mut();
        let op = &mut ops[0];
        let (handle, path) = m
            .store()
            .reserve_host_spool(&op.provider, "host:opaque", 4096)
            .unwrap();
        fs::write(path.join("stdout"), &op.original).unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        m.store().seal_host_spool(&op.provider, &handle, 0).unwrap();
        op.spool = Some(handle);
        op.paid_success = true;
        op.valid_original = true;
        op.durable_original = true;
    }
    m.apply(Command::Enable(false, false)).unwrap();
    m.quiesce().unwrap();
}

#[test]
fn model_terminal_provider_outcome_cannot_start_native_writer() {
    for outcome in [2, 3] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.apply(Command::Publish(0, outcome, true)).unwrap();
        m.apply(Command::Spool(0)).unwrap();
        assert!(m.operations.borrow()[0].spool.is_none());
        assert_eq!(m.operations.borrow()[0].starts.get(), 1);
        m.quiesce().unwrap();
    }
}

#[test]
fn model_replacement_provider_unbound_reply_delivers_original() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Upgrade(true, true, false)).unwrap();
    m.apply(Command::ReplacementSpool(0)).unwrap();
    assert!(m.operations.borrow()[0].valid_original);
    m.quiesce().unwrap();
    let ops = m.operations.borrow();
    let op = &ops[0];
    assert_eq!(fs::read(&op.copy).unwrap(), op.original);
    assert_eq!(op.starts.get(), 1);
    assert_eq!(op.delivery_effects.get(), 1);
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_replacement_provider_unbound_reply_is_removed_with_consumer() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Upgrade(true, true, false)).unwrap();
    m.apply(Command::ReplacementSpool(0)).unwrap();
    let ops = m.operations.borrow();
    let op = &ops[0];
    assert!(op.spool.is_some());
    assert_ne!(op.spool_owner.as_ref().unwrap().digest, op.provider.digest);
    assert_eq!(op.starts.get(), 1);
    drop(ops);
    m.apply(Command::Enable(false, false)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_fenced_unknown_unbound_repair_conserves_original() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    let (consumer, operation) = {
        let ops = m.operations.borrow();
        (ops[0].consumer.package_id.clone(), ops[0].id.clone())
    };
    assert!(m.store().execution_released(&consumer, &operation).unwrap());
    m.apply(Command::UnboundRepair(0)).unwrap();
    assert!(m.operations.borrow()[0].unpaid_repair);
    assert!(m.operations.borrow()[0].valid_original);
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[0].starts.get(), 1);
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_fenced_unknown_unbound_repair_is_removed_with_consumer() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    m.apply(Command::UnboundRepair(0)).unwrap();
    assert!(m.operations.borrow()[0].unpaid_repair);
    m.apply(Command::Enable(false, false)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_refused_native_attempt_uses_fresh_reverse_call_identity() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::SharedConsumerAdmit).unwrap();
    let index = m.index(2).unwrap();
    m.apply(Command::DirectorySyncFailure(true)).unwrap();
    m.apply(Command::Spool(2)).unwrap();
    let first_request = m.operations.borrow()[index].spool_request.clone();
    assert!(m.operations.borrow()[index].spool.is_none());
    assert!(!m.operations.borrow()[index].captured_process_reply);
    m.apply(Command::DirectorySyncFailure(false)).unwrap();
    m.apply(Command::Gc).unwrap();
    m.apply(Command::Spool(2)).unwrap();
    assert_ne!(m.operations.borrow()[index].spool_request, first_request);
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[index].starts.get(), 1);
    assert_eq!(m.operations.borrow()[index].delivery_effects.get(), 1);
}

#[test]
fn model_terminal_provider_rejects_late_reserved_reply() {
    for outcome in [2, 3] {
        for bound in [false, true] {
            let mut m = Machine::new();
            m.admit(0, false).unwrap();
            m.apply(Command::SpoolReserve(0, bound, false)).unwrap();
            m.apply(Command::Publish(0, outcome, true)).unwrap();
            for phase in [
                Command::SpoolReply(0),
                Command::SpoolReplyStep(0, 2),
                Command::SpoolReplyStep(0, 3),
                Command::SpoolReplyStep(0, 4),
                Command::SpoolReplyStep(0, 5),
                Command::SpoolReplyStep(0, 6),
                Command::SpoolReplyStep(0, 7),
                Command::SpoolReplyStep(0, 8),
                Command::SpoolReplyStep(0, 9),
                Command::SpoolReplyStep(0, 10),
                Command::SpoolReplyStep(0, 11),
                Command::SpoolReplyStep(0, 12),
                Command::SpoolReplyStep(0, 13),
                Command::SpoolReplyStep(0, 14),
                Command::SpoolReplyStep(0, 15),
                Command::SpoolReplyStep(0, 16),
                Command::SpoolReplyStep(0, 17),
                Command::SpoolPending(0),
                Command::SpoolFsync(0),
                Command::SpoolManifest(0),
                Command::SpoolManifestStep(0, 2),
                Command::SpoolManifestStep(0, 3),
                Command::SpoolManifestStep(0, 4),
                Command::SpoolManifestStep(0, 5),
                Command::SpoolManifestStep(0, 6),
                Command::SpoolManifestStep(0, 7),
                Command::SpoolManifestStep(0, 8),
                Command::SpoolSeal(0),
            ] {
                m.apply(phase).unwrap();
            }
            assert!(!m.operations.borrow()[0].paid_success);
            assert!(!m.operations.borrow()[0].valid_original);
            assert!(m.operations.borrow()[0].captured_process_reply);
            let ops = m.operations.borrow();
            let op = &ops[0];
            assert_eq!(
                fs::read(
                    m.fixture
                        .profile
                        .path()
                        .join("service-state/host-spools")
                        .join(op.spool.as_ref().unwrap())
                        .join("stdout"),
                )
                .unwrap(),
                op.original,
            );
            drop(ops);
            m.quiesce().unwrap();
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
        }
    }
}

#[test]
fn model_provider_rejection_fences_late_raw_native_reply() {
    for outcome in [2, 3] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        for command in [
            Command::SpoolReserve(0, false, false),
            Command::Publish(0, outcome, false),
            Command::Sweep,
            Command::Spool(0),
        ] {
            m.apply(command).unwrap();
        }
        assert!(m.operations.borrow()[0].captured_process_reply);
        assert!(!m.operations.borrow()[0].paid_success);
        assert!(!m.operations.borrow()[0].valid_original);
        m.quiesce().unwrap();
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
    }
}

#[test]
fn model_replacement_request_counter_collision_delivers_pinned_original() {
    for bound in [false, true] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.complete_spool(0, bound).unwrap();
        m.apply(Command::Upgrade(true, true, false)).unwrap();
        m.apply(Command::ReplacementCollision(0)).unwrap();
        assert_eq!(m.operations.borrow()[0].extra_spools.len(), 1);
        m.quiesce().unwrap();
        let ops = m.operations.borrow();
        let op = &ops[0];
        assert_eq!(fs::read(&op.copy).unwrap(), op.original);
        assert_eq!(op.starts.get(), 1);
        assert_eq!(op.delivery_effects.get(), 1);
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
    }
}

#[test]
fn model_host_only_unknown_success_emits_one_removal_notice() {
    for bound in [false, true] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        for command in [
            Command::SpoolReserve(0, bound, false),
            Command::SpoolReply(0),
            Command::SpoolReplyStep(0, 2),
            Command::SpoolReplyStep(0, 3),
            Command::SpoolReplyStep(0, 4),
            Command::SpoolReplyStep(0, 5),
            Command::SpoolReplyStep(0, 6),
            Command::SpoolReplyStep(0, 7),
            Command::SpoolReplyStep(0, 8),
            Command::SpoolReplyStep(0, 9),
            Command::SpoolReplyStep(0, 10),
            Command::SpoolReplyStep(0, 11),
            Command::SpoolReplyStep(0, 12),
            Command::SpoolReplyStep(0, 13),
            Command::SpoolReplyStep(0, 14),
            Command::SpoolReplyStep(0, 15),
            Command::SpoolReplyStep(0, 16),
            Command::SpoolReplyStep(0, 17),
            Command::SpoolPending(0),
            Command::SpoolFsync(0),
            Command::SpoolManifest(0),
            Command::SpoolManifestStep(0, 2),
            Command::SpoolManifestStep(0, 3),
            Command::SpoolManifestStep(0, 4),
            Command::SpoolManifestStep(0, 5),
            Command::SpoolManifestStep(0, 6),
            Command::SpoolManifestStep(0, 7),
            Command::SpoolManifestStep(0, 8),
            Command::SpoolSeal(0),
            Command::Publish(0, 1, false),
            Command::Enable(false, false),
        ] {
            m.apply(command).unwrap();
        }
        m.quiesce().unwrap();
        let id = m.operations.borrow()[0].id.clone();
        assert_eq!(
            m.notices.get(&id),
            Some(&1),
            "durable original had no emitted undelivered notice (bound={bound})"
        );
    }
}

#[test]
fn model_shared_provider_removal_preserves_only_surviving_custody() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.admit((SLOTS - 1) as u8, false).unwrap();
    m.apply(Command::Spool(0)).unwrap();
    m.apply(Command::Spool((SLOTS - 1) as u8)).unwrap();
    let (provider, first_handle, second_handle) = {
        let ops = m.operations.borrow();
        assert_eq!(
            ops[0].provider, ops[1].provider,
            "one native provider generation serves both consumers"
        );
        (
            ops[0].provider.clone(),
            ops[0].spool.clone().unwrap(),
            ops[1].spool.clone().unwrap(),
        )
    };
    let charge = m.charges();
    let disk = m.disk_bytes();
    let refusal = m
        .store()
        .reserve_host_spool(&provider, "opaque-shared-provider-reply", 4096)
        .unwrap_err();
    assert!(refusal
        .to_string()
        .contains("host output custody is ambiguous"));
    assert_eq!(m.charges(), charge);
    assert_eq!(m.disk_bytes(), disk);
    m.apply(Command::Enable(false, false)).unwrap();
    let root = m.fixture.profile.path().join("service-state/host-spools");
    assert!(!root.join(first_handle).exists());
    assert!(root.join(&second_handle).join("stdout").exists());
    let second_id = m.fixture.second_consumer.manifest.id.clone();
    let (result, events) =
        backend::capture_job_events(|| super::super::set_enabled(&m.profile(), &second_id, false));
    result.unwrap();
    m.observe_events(events).unwrap();
    for op in m.operations.borrow_mut().iter_mut() {
        op.removed = true;
    }
    m.quiesce().unwrap();
    assert!(!root.join(second_handle).exists());
}

#[test]
fn model_presealed_original_is_recovered_through_rpc() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Stage(0, true, false)).unwrap();
    m.apply(Command::Seal(0)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
}

#[test]
fn model_complete_stdout_survives_crash_before_empty_stderr() {
    for power_loss in [false, true] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.apply(Command::SpoolReserve(0, true, false)).unwrap();
        let last = if power_loss { 16 } else { 10 };
        for command in reply_commands(0).into_iter().take(last) {
            m.apply(command).unwrap();
        }
        m.apply(if power_loss {
            Command::PowerLoss
        } else {
            Command::Restart
        })
        .unwrap();
        m.quiesce().unwrap();
        let ops = m.operations.borrow();
        assert_eq!(fs::read(&ops[0].copy).unwrap(), ops[0].original);
        assert_eq!(ops[0].delivery_effects.get(), 1);
    }
}

#[test]
fn model_accepting_preparation_is_reused_after_compatible_replacement() {
    let mut m = Machine::new();
    m.apply(Command::Register(0)).unwrap();
    m.apply(Command::Capture(0)).unwrap();
    let captured = m.operations.borrow()[0].captured_inputs.clone();
    assert!(m
        .store()
        .get(
            &m.operations.borrow()[0].consumer.package_id,
            &m.operations.borrow()[0].id
        )
        .unwrap()
        .is_none());
    m.apply(Command::Upgrade(false, true, false)).unwrap();
    m.apply(Command::Restart).unwrap();
    m.apply(Command::Dispatch(0)).unwrap();
    assert_eq!(m.operations.borrow()[0].captured_inputs, captured);
    assert_eq!(m.operations.borrow()[0].starts.get(), 1);
    m.quiesce().unwrap();
}

#[test]
fn model_incompatible_sdk2_replacement_cleans_custodyless_reply() {
    let mut m = Machine::new();
    m.apply(Command::CustodylessReserve(0)).unwrap();
    assert!(m
        .store()
        .package_operations(m.fixture.id(Role::Provider))
        .unwrap()
        .is_empty());
    for point in 1..=28 {
        m.apply(Command::CustodylessReply(0, point)).unwrap();
    }
    m.apply(Command::Restart).unwrap();
    m.apply(Command::Upgrade(true, false, false)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_delivery_oracle_rejects_a_second_run_even_when_first_copy_exists() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::ProviderComplete(0)).unwrap();
    m.apply(Command::Acquire(0)).unwrap();
    let a = m
        .store()
        .get(
            &m.operations.borrow()[0].consumer.package_id,
            &m.operations.borrow()[0].id,
        )
        .unwrap()
        .unwrap();
    m.operations.borrow_mut()[0].transfer = None;
    let _ = FixtureRpc { machine: &m }.consumer_resume(&a);
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 2);
    assert!(m
        .invariants()
        .unwrap_err()
        .to_string()
        .contains("duplicate delivery effects"));
}

#[test]
fn model_recovery_paid_native_work_is_counted_separately_from_service_start() {
    struct PaidRecovery<'a>(&'a Machine);
    impl ai_operations::RecoveryPort for PaidRecovery<'_> {
        fn provider_status(
            &self,
            store: &Store,
            a: &Admission,
        ) -> Result<(PackageGeneration, Value), AppError> {
            let ops = self.0.operations.borrow();
            let op = ops.iter().find(|o| o.id == a.operation_id).unwrap();
            native_work_started(op, NativeContext::Recovery, NativeIntent::PaidGeneration);
            drop(ops);
            FixtureRpc { machine: self.0 }.provider_status(store, a)
        }
        fn resume(&self, store: &Store, a: &Admission, job: &JobRecord) -> Result<(), AppError> {
            let ops = self.0.operations.borrow();
            let op = ops.iter().find(|o| o.id == a.operation_id).unwrap();
            native_work_started(op, NativeContext::Recovery, NativeIntent::PaidGeneration);
            drop(ops);
            FixtureRpc { machine: self.0 }.resume(store, a, job)
        }
        fn terminal_resume(
            &self,
            _: &Store,
            _: &Admission,
            _: Option<&JobRecord>,
        ) -> Result<(), AppError> {
            Ok(())
        }
    }
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    let (consumer, id) = {
        let ops = m.operations.borrow();
        (ops[0].consumer.package_id.clone(), ops[0].id.clone())
    };
    let a = m.store().get(&consumer, &id).unwrap().unwrap();
    let job = m.store().job_for_operation(&consumer, &id).unwrap();
    let _ = ai_operations::recover_in(m.store(), &a, job.as_ref(), &PaidRecovery(&m));
    assert_eq!(m.operations.borrow()[0].starts.get(), 1);
    assert_eq!(m.operations.borrow()[0].recovery_native_starts.get(), 1);
    assert!(m
        .invariants()
        .unwrap_err()
        .to_string()
        .contains("paid execution replayed"));
}

#[test]
fn model_pending_create_crash_stops_before_stdout_is_created() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::SpoolReserve(0, true, false)).unwrap();
    m.apply(Command::SpoolReply(0)).unwrap();
    m.apply(Command::SpoolReplyStep(0, 2)).unwrap();
    let path = m
        .fixture
        .profile
        .path()
        .join("service-state/host-spools")
        .join(m.operations.borrow()[0].spool.as_ref().unwrap());
    m.operations.borrow_mut()[0].writer.take();
    assert!(path.join("pending.json").exists());
    assert!(!path.join("stdout").exists());
    assert!(!path.join("stderr").exists());
}

#[test]
fn model_acquired_proof_resumes_acknowledgement_without_a_second_consumer_run() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::ProviderComplete(0)).unwrap();
    m.apply(Command::PausedMutation(0, 1, 2)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
    assert_eq!(m.operations.borrow()[0].consumer_runs.get(), 1);
    assert!(m.operations.borrow()[0].acknowledged);
}

#[test]
fn model_removed_custodyless_writer_relinquishes_its_permit_before_collection() {
    let mut m = Machine::new();
    m.apply(Command::CustodylessReserve(1)).unwrap();
    m.apply(Command::Enable(true, false)).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_idle_fenced_operation_cannot_create_a_fresh_paid_native_dispatch() {
    let mut m = Machine::new();
    m.apply(Command::SharedConsumerAdmit).unwrap();
    m.apply(Command::SettlementCrash(2)).unwrap();
    m.apply(Command::Upgrade(false, false, false)).unwrap();
    let index = m.index(2).unwrap();
    let charge = m.charges();
    let disk = m.disk_bytes();
    let before_starts = m.operations.borrow()[index].native_paid_starts.get();
    m.apply(Command::SpoolReserve(2, false, false)).unwrap();
    let ops = m.operations.borrow();
    assert!(ops[index].writer.is_none());
    assert!(ops[index].spool.is_none());
    assert_eq!(ops[index].native_paid_starts.get(), before_starts);
    assert_eq!(m.charges(), charge);
    assert_eq!(m.disk_bytes(), disk);
    drop(ops);
    m.quiesce().unwrap();
}

#[test]
fn model_restart_cannot_synthesize_initial_paid_work_in_a_new_provider_generation() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    let original = m.operations.borrow()[0].provider.clone();
    m.apply(Command::Restart).unwrap();
    assert_ne!(m.generation(Role::Provider).unwrap(), original);
    let charge = m.charges();
    m.apply(Command::SpoolReserve(0, true, false)).unwrap();
    m.apply(Command::SpoolReserve(0, false, false)).unwrap();
    let ops = m.operations.borrow();
    assert!(ops[0].writer.is_none());
    assert_eq!(ops[0].native_paid_starts.get(), 0);
    assert_eq!(ops[0].native_attempts, 0);
    assert_eq!(m.charges(), charge);
    drop(ops);
    m.quiesce().unwrap();
}

#[test]
fn model_same_digest_upgrade_adopts_a_new_consumer_incarnation_in_every_preparation_phase() {
    for capture in [false, true] {
        let mut m = Machine::new();
        m.apply(Command::Upgrade(false, true, false)).unwrap();
        m.apply(Command::Register(0)).unwrap();
        if capture {
            m.apply(Command::Capture(0)).unwrap();
        }
        let original = m.operations.borrow()[0].consumer.clone();
        let descriptors = m.operations.borrow()[0].captured_inputs.clone();
        m.apply(Command::Upgrade(false, true, false)).unwrap();
        let current = m.generation(Role::Consumer).unwrap();
        assert_eq!(current.digest, original.digest);
        assert_ne!(current.incarnation, original.incarnation);
        m.apply(Command::Dispatch(0)).unwrap();
        assert_eq!(m.operations.borrow()[0].consumer, current);
        assert_eq!(m.operations.borrow()[0].captured_inputs, descriptors);
        assert_eq!(m.operations.borrow()[0].starts.get(), 1);
        m.quiesce().unwrap();
    }
}
