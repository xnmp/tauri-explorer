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
    ReleasePreparationCrash(u8, bool),
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
    FencedRepair(u8),
    ReplacementSpool(u8),
    CustodylessBesideLive(u8),
    ReplacementCollision(u8),
    Probe(bool),
    WorkerActive(u8, bool, bool),
    Acquire(u8),
    CopyBeforeProof(u8),
    CancelExitRace(u8, bool),
    AggregateCrash(u8, u8, u8, bool),
    RecaptureCrash(u8),
    ReconcilePreparation(u8),
    QueueIdleProof(u8, bool),
    DeliverIdleProof(u8, bool),
    Ack(u8, bool),
    AcquiredReceipt(u8),
    ProviderDiscard(u8, bool),
    DiscardCrash(u8, u8, bool),
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
    CompatibleUpgradeCrash(bool, u8, bool),
    PausedProviderMutation(u8, u8, u8),
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
            Self::ReleasePreparationCrash(_, false) => "preparation-release-crash",
            Self::ReleasePreparationCrash(_, true) => "preparation-release-power-loss",
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
            Self::FencedRepair(_) => "fenced-repair",
            Self::ReplacementSpool(_) => "replacement-provider-repair-spool",
            Self::CustodylessBesideLive(_) => "custodyless-beside-live-operations",
            Self::ReplacementCollision(_) => "provider-request-counter-collision",
            Self::Probe(true) => "healthy-probe",
            Self::Probe(false) => "unhealthy-probe",
            Self::WorkerActive(_, true, true) => "provider-active",
            Self::WorkerActive(_, false, true) => "consumer-active",
            Self::WorkerActive(_, _, false) => "worker-idle",
            Self::Acquire(_) => "acquire",
            Self::CopyBeforeProof(_) => "consumer-copy-before-proof",
            Self::CancelExitRace(_, true) => "cancel-stale-observation-natural-success",
            Self::CancelExitRace(_, false) => "cancel-stale-observation-killed",
            Self::AggregateCrash(_, 0, _, _) => "crash-inside-stage",
            Self::AggregateCrash(_, 1, _, _) => "crash-inside-seal",
            Self::AggregateCrash(_, 2, _, _) => "crash-inside-receipt",
            Self::AggregateCrash(..) => "crash-inside-acquisition",
            Self::RecaptureCrash(_) => "crash-recapture-retired",
            Self::ReconcilePreparation(_) => "retained-preparation-automatic-convergence",
            Self::QueueIdleProof(_, true) => "provider-idle-request",
            Self::QueueIdleProof(_, false) => "consumer-idle-request",
            Self::DeliverIdleProof(_, true) => "provider-idle-response",
            Self::DeliverIdleProof(_, false) => "consumer-idle-response",
            Self::CompatibleUpgradeCrash(_, _, false) => "compatible-upgrade-crash",
            Self::CompatibleUpgradeCrash(_, _, true) => "compatible-upgrade-power-loss",
            Self::PausedProviderMutation(_, 0, _) => "provider-recovery-response-paused-lifecycle",
            Self::PausedProviderMutation(..) => "provider-native-writer-paused-lifecycle",
            Self::AcquiredReceipt(_) => "acquired-receipt-before-release",
            Self::ProviderDiscard(_, false) => "provider-discard-commit",
            Self::ProviderDiscard(_, true) => "provider-discard-release",
            Self::DiscardCrash(_, 0, _) => "discard-crash-before-commit",
            Self::DiscardCrash(_, 1, _) => "discard-crash-after-commit",
            Self::DiscardCrash(..) => "discard-crash-before-collection",
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
            Self::SpoolReply(_) => "spool-before-capture",
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
        "spool-before-capture",
        "spool-stdout-create",
        "spool-stdout-partial",
        "spool-stdout-full",
        "spool-stdout-file-sync",
        "spool-stderr-create",
        "spool-stderr-partial",
        "spool-stderr-full",
        "spool-stderr-file-sync",
        "spool-seal-durable",
        "spool-intent-commit",
        "spool-pending-create",
        "spool-pending-partial",
        "spool-pending-full",
        "spool-pending-file-sync",
        "spool-pending-directory-sync",
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
            2 => (slot.clone(), any::<bool>()).prop_map(|(s,p)| Command::ReleasePreparationCrash(s,p)),
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
            2 => slot.clone().prop_map(Command::FencedRepair),
            2 => slot.clone().prop_map(Command::ReplacementSpool),
            2 => slot.clone().prop_map(Command::CustodylessBesideLive),
            2 => slot.clone().prop_map(Command::ReplacementCollision),
            3 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,p,a)| Command::WorkerActive(s,p,a)),
            3 => slot.clone().prop_map(Command::Acquire),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,c)| Command::Ack(s,c)),
            2 => slot.clone().prop_map(Command::AcquiredReceipt),
            2 => (slot.clone(), any::<bool>()).prop_map(|(s,r)| Command::ProviderDiscard(s,r)),
            2 => (slot.clone(), 0u8..3, any::<bool>()).prop_map(|(s,p,l)| Command::DiscardCrash(s,p,l)),
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
            3 => (slot.clone(), prop::sample::select(vec![0u8,2]), 0u8..=3).prop_map(|(s,k,a)| Command::PausedProviderMutation(s,k,a)),
            3 => (any::<bool>(), 4u8..=7, any::<bool>()).prop_map(|(r,p,l)| Command::CompatibleUpgradeCrash(r,p,l)),
            3 => (slot.clone(),0u8..=3,0u8..=12,any::<bool>()).prop_map(|(s,k,p,l)|Command::AggregateCrash(s,k,p,l)),
            2 => slot.clone().prop_map(Command::CopyBeforeProof),
            2 => (slot.clone(),any::<bool>()).prop_map(|(s,z)|Command::CancelExitRace(s,z)),
            2 => slot.clone().prop_map(Command::RecaptureCrash),
            2 => slot.clone().prop_map(Command::ReconcilePreparation),
            2 => (slot.clone(),any::<bool>()).prop_map(|(s,r)|Command::QueueIdleProof(s,r)),
            2 => (slot.clone(),any::<bool>()).prop_map(|(s,r)|Command::DeliverIdleProof(s,r)),
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
                        b"model diagnostic: original CLI completed",
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
    completion_identified: bool,
    sealed_original: bool,
    original: Vec<u8>,
    removed: bool,
    stage: Option<OutputStage>,
    descriptor: Option<ArtifactDescriptor>,
    spool: Option<String>,
    spool_owner: Option<PackageGeneration>,
    collision_reply: bool,
    native_attempts: u64,
    unpaid_repair: bool,
    spool_phase: u8,
    spool_status: i64,
    spool_request: String,
    writer: Option<SpoolActor>,
    transfer: Option<String>,
    copy: PathBuf,
    host_released: bool,
    provider_acknowledged: bool,
    acquisition_committed: bool,
    discard_committed: bool,
    provider_discarded: bool,
    provider_live: bool,
    consumer_live: bool,
    revision: Cell<u64>,
    last_receipt: RefCell<Option<Value>>,
    starts: Cell<usize>,
    stopped: Cell<bool>,
    delivery_effects: Cell<usize>,
}
impl Operation {
    /// Eligibility for a new consumer-copy/acquisition transition. Keep the
    /// provider's uncommitted local discard separate from its durable winner.
    fn acquisition_ready(&self, a: &Admission) -> bool {
        a.phase == AdmissionPhase::Terminal
            && self.descriptor.is_some()
            && a.output.as_ref() == self.descriptor.as_ref()
            && (!self.discard_committed || self.acquisition_committed)
    }
    /// Observe host commitment of an independently emitted provider discard.
    /// Every production reply path (status, replay, delayed publication) shares
    /// this oracle; host disposition alone never authorizes losing paid bytes.
    fn observe_discard_commitment(&mut self, store: &Store) -> Result<(), AppError> {
        if self.discard_committed || !self.provider_discarded || self.acquisition_committed {
            return Ok(());
        }
        let expected = self.last_receipt.borrow().clone();
        if let Some(expected) =
            expected.filter(|receipt| receipt["delivery"]["state"] == "discarded")
        {
            if store
                .provider_receipt(&self.consumer.package_id, &self.id)?
                .as_ref()
                == Some(&expected)
            {
                self.discard_committed = true;
            }
        }
        Ok(())
    }
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
        if self.provider_discarded {
            return json!({"state":"discarded"});
        }
        if self.provider_acknowledged || self.host_released {
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
    /// Declared last so it is released after the profile is torn down.
    _host: ai_operations::HostProfile,
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
#[derive(Clone)]
struct IdleProof {
    owner: PackageGeneration,
    idle: bool,
}
struct Machine {
    pending_idle: RefCell<BTreeMap<(usize, bool), IdleProof>>,
    idle_proofs: RefCell<BTreeMap<(usize, bool), IdleProof>>,
    async_idle: Cell<bool>,
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
    deferred_consumer_attempts: Cell<usize>,
    incarnation: u64,
    broker_incarnations: BTreeMap<String, u64>,
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
            _host: host,
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
            _host: host,
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
        let broker_incarnations = [
            fixture.id(Role::Consumer),
            fixture.id(Role::Provider),
            &fixture.second_consumer.manifest.id,
        ]
        .into_iter()
        .map(|id| (id.to_owned(), 10))
        .collect();
        Self {
            pending_idle: RefCell::new(BTreeMap::new()),
            idle_proofs: RefCell::new(BTreeMap::new()),
            async_idle: Cell::new(false),
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
            deferred_consumer_attempts: Cell::new(0),
            incarnation: 10,
            broker_incarnations,
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
    fn participant_generation(&self, index: usize, provider: bool) -> Option<PackageGeneration> {
        let ops = self.operations.borrow();
        let owner = if provider {
            &ops[index].provider
        } else {
            &ops[index].consumer
        };
        self.generation_for_package(&owner.package_id)
    }
    fn profile(&self) -> super::super::Profile<'_> {
        super::super::Profile {
            root: &self.fixture.root,
            store: self.store(),
        }
    }
    fn generation(&self, role: Role) -> Option<PackageGeneration> {
        self.generation_for_package(self.fixture.id(role))
    }
    fn generation_for_package(&self, package: &str) -> Option<PackageGeneration> {
        let incarnation = *self.broker_incarnations.get(package)?;
        package::list(&self.fixture.root)
            .ok()?
            .into_iter()
            .find(|p| p.manifest.id == package && p.enabled)
            .map(|p| PackageGeneration {
                package_id: p.manifest.id,
                digest: p.digest,
                incarnation,
            })
    }
    fn replace_broker(&mut self, package: &str) {
        self.incarnation += 1;
        self.broker_incarnations
            .insert(package.into(), self.incarnation);
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
        for op in self
            .operations
            .borrow_mut()
            .iter_mut()
            .filter(|op| !op.removed)
        {
            if let Some(a) = self.store().get(&op.consumer.package_id, &op.id)? {
                if a.phase == AdmissionPhase::Released
                    && a.disposition.as_deref() == Some("acquired")
                {
                    op.host_released = true;
                    op.transfer = a.transfer_receipt;
                }
            }
        }
        Ok(())
    }
    fn request(op: &Operation) -> Value {
        json!({"operationId":op.id,"connectionId":"model-profile","expectedConnectionRevision":"revision-1","model":null,"prompt":"model test","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"local-token","effectiveRecipeDigest":"b".repeat(64)})
    }
    fn register(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let package = if slot as usize == SLOTS - 1 {
            &self.fixture.second_consumer.manifest.id
        } else {
            self.fixture.id(Role::Consumer)
        };
        let Some(consumer) = self.generation_for_package(package) else {
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
                    || !op.host_released
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
            completion_identified: false,
            sealed_original: false,
            original: image_bytes(index as u8),
            removed: false,
            stage: None,
            descriptor: None,
            spool: None,
            spool_owner: None,
            collision_reply: false,
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
            host_released: false,
            provider_acknowledged: false,
            acquisition_committed: false,
            discard_committed: false,
            provider_discarded: false,
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
            ownership_epoch: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: Some("accepting".into()),
            output_path: None,
            cost: None,
            reveal: None,
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
        let current = self
            .generation_for_package(&op.consumer.package_id)
            .ok_or_else(|| fail("consumer callback has no current generation"))?;
        let job = checked(
            self.store()
                .job_for_operation(&op.consumer.package_id, &op.id),
        )?
        .ok_or_else(|| fail("consumer callback lost its presentation"))?;
        checked(job_bridge::recovery_job(
            self.store(),
            &installed.manifest,
            &current,
            &job,
        ))?;
        // Match the broker callback caller, not the job's presentation owner:
        // a prepared-upgrade rollback can retain an older presentation epoch.
        checked(service_bridge::recovery_caller(
            self.store(),
            &installed.manifest,
            &current,
            &op.id,
        ))
    }
    fn released_preparation(&self, op: &Operation) -> bool {
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE consumer=?1 AND operation=?2 AND phase='released' AND (admission IS NULL OR json_extract(admission,'$.disposition')='never_forwarded'))",
            rusqlite::params![op.consumer.package_id, op.id],
            |row| row.get::<_, bool>(0),
        ).unwrap()
    }

    fn capture(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed
            || op.dispatched
            || !op.captured_inputs.is_empty()
            || self.released_preparation(op)
        {
            return Ok(());
        }
        let consumer = self.preparation_callback_owner(op)?;
        let path = self
            .fixture
            .profile
            .path()
            .join(format!("{}-input.png", op.id));
        fs::write(&path, &op.original).unwrap();
        match self.store().capture(
            &consumer,
            &op.id,
            vec![CaptureInput {
                path: path.to_string_lossy().into(),
                expected_digest: None,
            }],
        ) {
            Ok(captures) => {
                op.consumer = consumer;
                op.captured_inputs = captures.into_iter().map(|c| c.artifact).collect();
                self.applied += 1;
            }
            Err(error) if expected_capacity(&error) || self.sync_failure || self.unlink_failure => {
            }
            Err(error)
                if error
                    .to_string()
                    .contains("capture operation conflicts with its original snapshot")
                    && self.released_preparation(op) =>
            {
                // The real capture call refused a settled preparation. As with
                // dispatch, a tombstone refusal cannot authorize paid work.
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
        let Some(installed_provider) = self.fixture.installed(Role::Provider) else {
            return Ok(());
        };
        if !service_graph::provider_recovers(&installed_provider.manifest, &target) {
            return Ok(());
        }
        // Match invoke_admitted: an existing operation keeps its original
        // authority when a compatible replacement handles its status replay.
        let provider = checked(service_bridge::recovery_provider(
            self.store(),
            &installed_provider.manifest,
            &provider,
            &consumer.package_id,
            &op.id,
        ))?;
        let mut request = Self::request(op);
        request["inputs"] = json!(op.captured_inputs);
        let target = ServiceTarget {
            package_id: provider.package_id.clone(),
            service_id: "image-generation".into(),
            major: 1,
        };
        let starts_before = op.starts.get();
        let stale_preparation = checked(self.stale_preparation(op, &consumer))?;
        let result = service_bridge::image_call(
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
        );
        // A Released intent can answer an idempotent start as cached status.
        // Only the actual provider start invocation makes this dispatched.
        if op.starts.get() > starts_before {
            op.dispatched = true;
            op.consumer = consumer;
            op.provider = provider;
            op.request = request;
            self.applied += 1;
        }
        match result {
            Ok(_) => {}
            Err(error)
                if expected_capacity(&error)
                    || self.sync_failure
                    || self.unlink_failure
                    || error
                        .to_string()
                        .contains("released preparation ID cannot be reused") =>
            {
                // The attempt reached production and its durable preparation
                // tombstone refused it before any provider invocation.
            }
            Err(error)
                if stale_preparation
                    && op.starts.get() == starts_before
                    && error
                        .to_string()
                        .contains("preparation owner expired; create a new operation ID") =>
            {
                // A real restart changes the consumer incarnation. Without a
                // replacement grant its old unadmitted capture cannot dispatch;
                // retain it for automatic reconciliation/settlement, never pay.
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
        // A release already committed before a crash must be finished by the
        // automatic sweep, not hidden by this fixture's terminal job write.
        if checked(self.store().get(&op.consumer.package_id, &op.id))?
            .is_some_and(|a| a.phase == AdmissionPhase::Released)
        {
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
    fn stale_preparation(
        &self,
        op: &Operation,
        caller: &PackageGeneration,
    ) -> Result<bool, AppError> {
        Ok(!op.captured_inputs.is_empty()
            && op.consumer.package_id == caller.package_id
            && op.consumer.digest == caller.digest
            && op.consumer.incarnation != caller.incarnation
            && self.store().get(&op.consumer.package_id, &op.id)?.is_none())
    }
    fn reserve_preparation(&self, op: &Operation) -> Result<Admission, AppError> {
        self.reserve_preparation_as(op, &op.consumer, &op.provider)
    }
    fn reserve_preparation_as(
        &self,
        op: &Operation,
        consumer: &PackageGeneration,
        provider: &PackageGeneration,
    ) -> Result<Admission, AppError> {
        let mut request = Self::request(op);
        request["inputs"] = json!(op.captured_inputs);
        // The durable boundary inside image_call("start"), before forwarding.
        self.store().reserve_intent(
            Admission {
                consumer: consumer.clone(),
                provider: provider.clone(),
                target: ServiceTarget {
                    package_id: provider.package_id.clone(),
                    service_id: "image-generation".into(),
                    major: 1,
                },
                operation_id: op.id.clone(),
                fingerprint: "b".repeat(64),
                phase: AdmissionPhase::Reserved,
                inputs: op.captured_inputs.clone(),
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            },
            &crate::service_state::request::semantic(&request)?,
        )
    }
    fn release_preparation_crash(
        &mut self,
        slot: u8,
        power_loss: bool,
    ) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        {
            let mut ops = self.operations.borrow_mut();
            let op = &mut ops[index];
            if op.dispatched || op.removed || self.released_preparation(op) {
                return Ok(());
            }
            let consumer = self.preparation_callback_owner(op)?;
            let Some(provider) = self.generation(Role::Provider) else {
                return Ok(());
            };
            let stale_preparation = checked(self.stale_preparation(op, &consumer))?;
            match self.reserve_preparation_as(op, &consumer, &provider) {
                Ok(a) => {
                    // Oracle ownership follows the durable reservation, never
                    // a candidate callback that production may refuse.
                    op.consumer = a.consumer;
                    op.provider = a.provider;
                }
                Err(error)
                    if expected_capacity(&error) || self.sync_failure || self.unlink_failure =>
                {
                    return Ok(())
                }
                Err(error)
                    if stale_preparation
                        && error
                            .to_string()
                            .contains("preparation owner expired; create a new operation ID") =>
                {
                    return Ok(())
                }
                Err(error) => {
                    return Err(fail(format!(
                        "unexpected interrupted reservation rejection: {error}"
                    )))
                }
            }
            // Commit release without the separate Cancelled presentation write.
            checked(self.store().release_unaccepted(&op.consumer, &op.id))?;
        }
        self.applied += 1;
        self.restart(power_loss)
    }
    fn stage(&mut self, slot: u8, complete: bool, synced: bool) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed
            || op.host_released
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
        if op.removed || op.host_released {
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
            || op.host_released
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
    fn consumer_attempt(&self, result: Result<(), AppError>) -> Result<(), TestCaseError> {
        match result {
            Err(AppError::Io(_)) if self.sync_failure || self.unlink_failure => {
                self.deferred_consumer_attempts
                    .set(self.deferred_consumer_attempts.get() + 1);
                Ok(())
            }
            result => checked(result),
        }
    }
    fn acquire(&self, slot: u8) -> Result<(), AppError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.host_released || op.transfer.is_some() {
            return Ok(());
        }
        let Some(d) = &op.descriptor else {
            return Ok(());
        };
        let a = self.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        if a.phase != AdmissionPhase::Terminal || a.output.as_ref() != Some(d) {
            return Ok(());
        }
        let d = d.clone();
        self.consumer_copy(op, &d)?;
        if op.discard_committed {
            assert!(
                self.store()
                    .acquired(&op.consumer, &op.id, &d, op.copy.to_str().unwrap())
                    .is_err(),
                "committed provider discard must fence acquisition"
            );
            return Ok(());
        }
        op.transfer = Some(
            self.store()
                .acquired(&op.consumer, &op.id, &d, op.copy.to_str().unwrap())?
                .transfer_receipt,
        );
        op.acquisition_committed = true;
        Ok(())
    }
    // The provider receipt commits before admission release in production.
    // Keep that crash boundary independently schedulable with lifecycle actions.
    fn acquired_receipt(&self, slot: u8) -> Result<(), AppError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.host_released || op.transfer.is_none() {
            return Ok(());
        }
        let status = op.receipt(if op.provider_discarded {
            op.delivery()
        } else {
            json!({"state":"acquired","transferReceipt":op.transfer})
        });
        self.store().observe_receipt(
            &op.provider,
            &op.consumer.package_id,
            &op.id,
            status["revision"].as_u64().unwrap(),
            status,
        )?;
        op.provider_acknowledged = !op.provider_discarded;
        op.consumer_live = false;
        Ok(())
    }
    fn provider_discard(&mut self, slot: u8, release: bool) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.descriptor.is_none() {
            return Ok(());
        }
        let a = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
        if release {
            if !op.provider_discarded || a.phase == AdmissionPhase::Released {
                return Ok(());
            }
            checked(service_bridge::reconcile_at(
                self.store(),
                &op.provider,
                &a,
                &op.receipt(op.delivery()),
            ))?;
        } else {
            op.provider_discarded = true;
            let status = op.receipt(op.delivery());
            let result = self.store().observe_receipt(
                &op.provider,
                &op.consumer.package_id,
                &op.id,
                status["revision"].as_u64().unwrap(),
                status,
            );
            if op.acquisition_committed {
                if let Ok(status) = result {
                    if status["delivery"]["state"] != "acquired" {
                        return Err(fail("provider discard overwrote committed acquisition"));
                    }
                }
                // Provider-local discard is durable even when the host refuses
                // it. Future status/ack replies keep returning this receipt.
                self.applied += 1;
                return Ok(());
            } else {
                checked(result)?;
                op.discard_committed = true;
            }
        }
        self.applied += 1;
        Ok(())
    }
    fn discard_crash(&mut self, slot: u8, point: u8, loss: bool) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        {
            let mut ops = self.operations.borrow_mut();
            let op = &mut ops[index];
            if op.removed || op.descriptor.is_none() {
                return Ok(());
            }
            if point < 2 {
                if op.discard_committed {
                    return Ok(());
                }
                let name = if point == 0 {
                    "receipt-success-witness"
                } else {
                    "receipt-ledger"
                };
                let before = self.oracle.checkpoint_hits(name);
                op.provider_discarded = true;
                let status = op.receipt(op.delivery());
                self.oracle.crash_at(name);
                let result = self.store().observe_receipt(
                    &op.provider,
                    &op.consumer.package_id,
                    &op.id,
                    status["revision"].as_u64().unwrap(),
                    status,
                );
                if self.oracle.checkpoint_hits(name) == before {
                    self.oracle.crash_at("__none__");
                    return Ok(());
                }
                if !result.is_err_and(|e| e.to_string().contains("injected aggregate crash")) {
                    return Err(fail(
                        "discard checkpoint did not interrupt production observation",
                    ));
                }
                // The receipt-ledger barrier follows COMMIT; the witness
                // barrier is still inside the transaction and rolls back.
                op.discard_committed = point == 1 && !op.acquisition_committed;
            } else {
                if !op.provider_discarded {
                    return Ok(());
                }
                let a = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
                if a.phase != AdmissionPhase::Terminal {
                    return Ok(());
                }
                // Collection failure leaves physical custody after the durable
                // release. Restart must collect it and return its disk charge.
                let receipt = checked(
                    self.store()
                        .provider_receipt(&op.consumer.package_id, &op.id),
                )?;
                let transfer = receipt
                    .as_ref()
                    .and_then(|r| r["delivery"]["transferReceipt"].as_str());
                self.oracle.faults(true, self.sync_failure);
                let _ = self.store().release(
                    &op.provider,
                    &op.consumer.package_id,
                    &op.id,
                    if op.acquisition_committed {
                        "acquired"
                    } else {
                        "discarded"
                    },
                    if op.acquisition_committed {
                        transfer
                    } else {
                        None
                    },
                );
                let bytes = self
                    .fixture
                    .profile
                    .path()
                    .join("service-state/bytes")
                    .join(format!("{}.bin", op.descriptor.as_ref().unwrap().handle));
                if !bytes.exists() || self.charges() <= 0 {
                    return Err(fail(
                        "collection fault did not retain charged original custody before restart",
                    ));
                }
                let released = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
                if released.phase != AdmissionPhase::Released {
                    return Err(fail(
                        "discard release did not commit before collection fault",
                    ));
                }
                self.oracle.faults(self.unlink_failure, self.sync_failure);
            }
        }
        self.restart(loss)?;
        self.applied += 1;
        Ok(())
    }
    fn ack(&self, slot: u8, crash: bool) -> Result<(), AppError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.host_released {
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
        op.host_released = true;
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
        // A failed capture may already have released its preparation before
        // this lifecycle action. Its later automatic cancellation is expected;
        // active preparations still have the full compatible-retention oracle.
        let released_before: Vec<String> = self
            .operations
            .borrow()
            .iter()
            .filter(|op| !op.dispatched && self.released_preparation(op))
            .map(|op| op.id.clone())
            .collect();
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
            if released_before.contains(&op.id)
                && checked(
                    self.store()
                        .job_for_operation(&op.consumer.package_id, &op.id),
                )?
                .is_some_and(|job| job.state.terminal())
            {
                op.removed = true;
            }
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
        self.replace_broker(&id);
        self.applied += 1;
        Ok(())
    }
    fn restart(&mut self, power_loss: bool) -> Result<(), TestCaseError> {
        let oracle = self.oracle.clone();
        for op in self.operations.borrow_mut().iter_mut() {
            op.provider_live = false;
            op.consumer_live = false;
            if !op.host_released && !op.provider_acknowledged {
                op.transfer = None;
            }
            op.writer.take();
            if op.spool.is_some() {
                op.spool_phase = 30;
                // Before atomic seal rename, even durable stdout cannot prove
                // a complete successful execution; crash settles as Unknown.
                if !op.completion_identified && !op.sealed_original && !op.provider_rejected() {
                    op.valid_original = false;
                    // Independent provider execution authority survives loss
                    // of the host's unsealed capture; only delivery was lost.
                    if op.outcome != Outcome::Succeeded {
                        op.outcome = Outcome::Unknown;
                    }
                }
            }
        }
        for spool in &mut self.custodyless {
            spool.writer.take();
            // Without a published identity, process success cannot be recovered.
            if !spool.valid {
                spool.durable = false;
            }
            spool.phase = 30;
        }
        if power_loss {
            oracle.power_loss();
            self.unlink_failure = false;
            self.sync_failure = false;
            for (path, bytes) in std::mem::take(&mut self.dirty_writes) {
                if path.exists() {
                    fs::write(path, bytes).unwrap();
                }
            }
        }
        // Unsealed stage writes also have no durable completion identity.
        for op in self.operations.borrow_mut().iter_mut() {
            if op.valid_original
                && !op.completion_identified
                && !op.sealed_original
                && !self.original_conserved(op)
            {
                op.valid_original = false;
                if op.dispatched && op.outcome != Outcome::Succeeded {
                    op.outcome = Outcome::Unknown;
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
        for incarnation in self.broker_incarnations.values_mut() {
            *incarnation = self.incarnation;
        }
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
        if op.removed || op.host_released {
            return Ok(());
        }
        if let Command::SpoolReserve(_, bound, nonzero) = command {
            let admission = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
            if op.spool.is_some() {
                return Ok(());
            }
            let Some(owner) = self.generation(Role::Provider) else {
                return Ok(());
            };
            // Real SDK reverse-call identities advance on every attempt,
            // including refusals before a process can start.
            op.native_attempts += 1;
            op.spool_request = format!("host:model-{}-{}", op.id, op.native_attempts);
            let custody = bound.then_some((op.consumer.package_id.as_str(), op.id.as_str()));
            let _repair = if matches!(op.native_intent, NativeIntent::LocalReconstruction) {
                Some(checked(
                    self.store
                        .as_ref()
                        .unwrap()
                        .output_recovery_guard(&admission),
                )?)
            } else {
                None
            };
            match self.store().reserve_host_spool_with_custody(
                &owner,
                &op.spool_request,
                4096,
                custody,
            ) {
                Ok((handle, _)) => {
                    let control = crate::plugin_job::JobControl::new();
                    let mut controls = std::collections::HashMap::new();
                    let mut spools = std::collections::HashMap::new();
                    checked(crate::installed_plugins::process_run::admit(
                        &mut controls,
                        &mut spools,
                        true,
                        &op.spool_request,
                        &control,
                        &std::sync::Arc::new(handle.clone()),
                    ))?;
                    // Unbound CLI calls can be standalone after the selected
                    // admission settles. Attribute only the custody actually
                    // committed by Store, never the model's requested slot.
                    let conn = rusqlite::Connection::open(
                        self.fixture
                            .profile
                            .path()
                            .join("service-state/ledger.sqlite"),
                    )
                    .unwrap();
                    let linked: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM host_spools WHERE handle=?1 AND consumer=?2 AND operation=?3) OR EXISTS(SELECT 1 FROM host_spool_admissions WHERE handle=?1 AND consumer=?2 AND operation=?3)",
                        rusqlite::params![handle, op.consumer.package_id, op.id], |r| r.get(0),
                    ).unwrap();
                    if bound && !linked {
                        return Err(fail(
                            "explicit reservation lost requested operation custody",
                        ));
                    }
                    // Custody is never inferred (#1172): a reservation that
                    // names no operation is linked to none, live or settled.
                    let linked_anywhere: bool = conn.query_row(
                        "SELECT consumer IS NOT NULL OR EXISTS(SELECT 1 FROM host_spool_admissions WHERE handle=?1) FROM host_spools WHERE handle=?1",
                        [&handle], |r| r.get(0),
                    ).unwrap();
                    if !bound && linked_anywhere {
                        return Err(fail("custody-less reservation was bound to an operation"));
                    }
                    if !linked {
                        // A truly independent CLI fixture has its own output,
                        // not the selected operation's generation recipe.
                        let original = image_bytes(200 + slot);
                        let writer = checked(SpoolActor::new(
                            self.fixture.profile.path().join("service-state"),
                            self.limits,
                            owner.clone(),
                            handle.clone(),
                            original.clone(),
                            if nonzero { 17 } else { 0 },
                        ))?;
                        self.raw_slots[usize::from(slot)] = Some(self.custodyless.len());
                        self.custodyless.push(CustodylessSpool {
                            owner,
                            handle,
                            original: original.clone(),
                            phase: 1,
                            writer: Some(writer),
                            removed: false,
                            released: false,
                            valid: false,
                            durable: false,
                        });
                        self.applied += 1;
                        return Ok(());
                    }
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
                        || bound
                            && matches!(&error, crate::error::AppError::Service { code, .. }
                                if code == crate::service_state::CUSTODY_REFUSED)
                        || error.to_string().contains("plugin incarnation was retired")
                        || error.to_string().contains("host process")
                        || error.to_string().contains("provider") => {}
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
                if expected == 10 && op.valid_original {
                    // Independent contract event: successful seal publication,
                    // before the derived database write. Never infer loss from
                    // missing production metadata after this event.
                    op.sealed_original = true;
                    op.durable_original = true;
                }
                self.applied += 1;
            }
            Err(_) if self.sync_failure || self.unlink_failure => {
                op.writer.take();
                op.spool_phase = 30;
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
                spool.valid |= checked(
                    self.store
                        .as_ref()
                        .unwrap()
                        .host_spool_has_recorded_identity(&spool.handle),
                )?;
                spool.valid |= phase >= 10;
                spool.durable |= phase >= 10;
                if phase == 28 {
                    spool.writer.take();
                }
                self.applied += 1;
            }
            Err(_) if self.sync_failure || self.unlink_failure => {
                spool.writer.take();
                spool.phase = 30;
                spool.valid |= checked(
                    self.store
                        .as_ref()
                        .unwrap()
                        .host_spool_has_recorded_identity(&spool.handle),
                )?;
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
                || op.host_released
                || op.provider_rejected()
                || op.spool_phase != 29
                || op.collision_reply
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
        let admitted = checked(self.store().get(&consumer, &operation))?.unwrap();
        if admitted.phase == AdmissionPhase::Released {
            return Ok(());
        }
        let _repair = checked(
            self.store
                .as_ref()
                .unwrap()
                .output_recovery_guard(&admitted),
        )?;
        let (handle, _) = match self.store().reserve_host_spool(&owner, &request, 4096) {
            Ok(reservation) => reservation,
            Err(error) if expected_capacity(&error) => return Ok(()),
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
        // The unrelated reply names no operation, so it is a standalone
        // custody-less spool that its provider releases, never the operation's.
        self.operations.borrow_mut()[index].collision_reply = true;
        self.custodyless.push(CustodylessSpool {
            owner: owner.clone(),
            handle,
            original: image_bytes(251),
            phase: 29,
            writer: None,
            removed: false,
            released: false,
            valid: true,
            durable: true,
        });
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
    fn paused_mutation(
        &mut self,
        slot: u8,
        kind: u8,
        action: u8,
        provider: bool,
    ) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        if self.operations.borrow()[index].removed
            || self.operations.borrow()[index].host_released
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
            0 => Command::Enable(provider, false),
            1 => Command::Uninstall(provider),
            2 => Command::Upgrade(provider, true, false),
            _ => Command::Upgrade(provider, false, false),
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
                let ready = {
                    let ops = self.operations.borrow();
                    ops[index].acquisition_ready(&admission) && ops[index].transfer.is_none()
                };
                if !ready {
                    return Ok(());
                }
                let d = admission.output.as_ref().unwrap();
                let source = checked(held.read(&admission.consumer, &consumer, &operation, d))?;
                let source_bytes = fs::read(&source.path).map_err(|e| fail(e.to_string()))?;
                self.mutation(mutation)?;
                let (copy, removed) = {
                    let mut ops = self.operations.borrow_mut();
                    self.consumer_attempt(
                        self.consumer_copy_from(&mut ops[index], d, || Ok(source_bytes)),
                    )?;
                    (ops[index].copy.clone(), ops[index].removed)
                };
                let acquired =
                    held.acquired(&admission.consumer, &operation, d, copy.to_str().unwrap());
                if removed && acquired.is_ok() {
                    return Err(fail("paused acquisition revived removed custody"));
                }
                if let Ok(proof) = acquired {
                    let mut ops = self.operations.borrow_mut();
                    ops[index].transfer = Some(proof.transfer_receipt);
                    ops[index].acquisition_committed = true;
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
                    b"model diagnostic",
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
                    op.sealed_original |= op.valid_original;
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
    fn consumer_copy(&self, op: &mut Operation, d: &ArtifactDescriptor) -> Result<(), AppError> {
        let consumer = op.consumer.clone();
        let operation = op.id.clone();
        self.consumer_copy_from(op, d, || {
            let source = self
                .store()
                .read(&consumer, &consumer.package_id, &operation, d)?;
            Ok(fs::read(source.path)?)
        })
    }
    fn consumer_copy_from(
        &self,
        op: &mut Operation,
        d: &ArtifactDescriptor,
        source: impl FnOnce() -> Result<Vec<u8>, AppError>,
    ) -> Result<(), AppError> {
        let journal = op
            .copy
            .parent()
            .unwrap()
            .join(format!("{}.delivery.json", op.id));
        if let Ok(raw) = fs::read(&journal) {
            let intent: Value = serde_json::from_slice(&raw)
                .map_err(|_| AppError::Other("corrupt consumer delivery intent".into()))?;
            if intent["operationId"] != op.id
                || intent["output"] != serde_json::to_value(d).unwrap()
            {
                return Err(AppError::Other(
                    "conflicting consumer delivery intent".into(),
                ));
            }
            op.copy = PathBuf::from(
                intent["path"]
                    .as_str()
                    .ok_or_else(|| AppError::Other("consumer intent lacks destination".into()))?,
            );
            crate::durable_dir::sync_file(&journal)?;
            self.oracle.file_synced(&journal);
            self.oracle.sync(journal.parent().unwrap())?;
            // Intent pins the destination and sealed identity. The host still
            // validates and commits acquisition; existence is never a receipt.
            use sha2::{Digest, Sha256};
            if fs::read(&op.copy).ok().is_some_and(|bytes| {
                bytes.len() as u64 == d.byte_length
                    && hex::encode(Sha256::digest(bytes)) == d.sha256
            }) {
                crate::durable_dir::sync_file(&op.copy)?;
                self.oracle.file_synced(&op.copy);
                self.oracle.sync(op.copy.parent().unwrap())?;
                return Ok(());
            }
        } else {
            let intent = json!({"operationId":op.id,"output":d,"path":op.copy});
            self.oracle.before_mutation(&journal);
            fs::write(&journal, serde_json::to_vec(&intent).unwrap())?;
            crate::durable_dir::sync_file(&journal)?;
            self.oracle.file_synced(&journal);
            self.oracle.sync(journal.parent().unwrap())?;
        }
        let bytes = source()?;
        op.consumer_runs.set(op.consumer_runs.get() + 1);
        self.oracle.before_mutation(&op.copy);
        fs::write(&op.copy, bytes)?;
        op.delivery_effects.set(op.delivery_effects.get() + 1);
        crate::durable_dir::sync_file(&op.copy)?;
        self.oracle.file_synced(&op.copy);
        self.oracle.sync(op.copy.parent().unwrap())?;
        Ok(())
    }
    fn copy_before_proof(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let mut ops = self.operations.borrow_mut();
        let op = &mut ops[index];
        if op.removed || op.host_released || op.transfer.is_some() || op.delivery_effects.get() != 0
        {
            return Ok(());
        }
        let Some(d) = &op.descriptor else {
            return Ok(());
        };
        let Some(a) = checked(self.store().get(&op.consumer.package_id, &op.id))? else {
            return Ok(());
        };
        if !op.acquisition_ready(&a) {
            return Ok(());
        }
        let d = d.clone();
        self.consumer_attempt(self.consumer_copy(op, &d))?;
        self.applied += 1;
        Ok(())
    }
    fn reconcile_preparation(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let (owner, id) = {
            let ops = self.operations.borrow();
            let op = &ops[index];
            if op.dispatched || op.removed || op.consumer_live {
                return Ok(());
            }
            (op.consumer.clone(), op.id.clone())
        };
        let Some(installed) = package::list(&self.fixture.root)
            .unwrap()
            .into_iter()
            .find(|p| p.manifest.id == owner.package_id && p.enabled)
        else {
            return Ok(());
        };
        let current = self
            .generation_for_package(&owner.package_id)
            .ok_or_else(|| fail("consumer reconciliation has no current generation"))?;
        let observed = checked(self.store().job_for_operation(&owner.package_id, &id))?.unwrap();
        let record = checked(job_bridge::recovery_job(
            self.store(),
            &installed.manifest,
            &current,
            &observed,
        ))?;
        let mut fence_sent = false;
        let settled = checked(job_bridge::settle_unaccepted(
            self.store(),
            &record,
            &Value::Null,
            &mut |method| {
                if method == "jobs.cancelOperation" {
                    fence_sent = true;
                } else {
                    assert!(fence_sent);
                }
                Ok(Value::Null)
            },
        ))?;
        if settled.is_some() {
            self.operations.borrow_mut()[index].removed = true;
            self.applied += 1;
        }
        Ok(())
    }
    fn recapture_crash(&mut self, slot: u8) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let id = {
            let ops = self.operations.borrow();
            let op = &ops[index];
            if op.removed || op.dispatched || op.captured_inputs.is_empty() {
                return Ok(());
            }
            if !checked(
                self.store()
                    .preparation_retained(&op.consumer.package_id, &op.id),
            )? {
                return Ok(());
            }
            op.id.clone()
        };
        let owner = {
            let mut ops = self.operations.borrow_mut();
            let op = &mut ops[index];
            // Resolve the real callback owner before arming a filesystem
            // crash; compatible replacement can retire the captured owner.
            op.consumer = self.preparation_callback_owner(op)?;
            op.consumer.clone()
        };
        let conn = rusqlite::Connection::open(
            self.fixture
                .profile
                .path()
                .join("service-state/ledger.sqlite"),
        )
        .unwrap();
        conn.execute(
            "UPDATE operations SET captures=NULL WHERE consumer=?1 AND operation=?2",
            rusqlite::params![owner.package_id, id],
        )
        .unwrap();
        let spec: String = conn
            .query_row(
                "SELECT capture_spec FROM operations WHERE consumer=?1 AND operation=?2",
                rusqlite::params![owner.package_id, id],
                |r| r.get(0),
            )
            .unwrap();
        let oracle = self.oracle.clone();
        oracle.faults(true, false);
        oracle.crash_at("recapture-retired");
        let result = self
            .store()
            .capture(&owner, &id, serde_json::from_str(&spec).unwrap());
        assert!(
            result
                .as_ref()
                .is_err_and(|e| e.to_string().contains("injected aggregate crash")),
            "recapture result={result:?}, callback owner={owner:?}"
        );
        self.operations.borrow_mut()[index].captured_inputs.clear();
        oracle.faults(false, false);
        self.restart(false)?;
        checked(self.store().gc())?;
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM artifacts WHERE consumer=?1 AND operation=?2",
                rusqlite::params![owner.package_id, id],
                |r| r.get(0),
            )
            .unwrap();
        if n != 0 {
            return Err(fail("recapture orphan survived healthy GC"));
        }
        self.applied += 1;
        Ok(())
    }
    fn aggregate_crash(
        &mut self,
        slot: u8,
        kind: u8,
        point: u8,
        loss: bool,
    ) -> Result<(), TestCaseError> {
        const POINTS: &[&[&str]] = &[
            &[
                "stage-created",
                "stage-file-sync",
                "stage-directory-sync",
                "stage-ledger",
            ],
            &[
                "seal-pending-created",
                "seal-pending-truncated",
                "seal-pending-partial",
                "seal-pending-full",
                "seal-file-sync",
                "seal-published",
                "seal-directory-sync",
                "seal-pending-unlinked",
                "seal-cleanup-sync",
                "seal-ledger",
                "seal-stage-unlinked",
                "seal-stage-sync",
                "seal-quota",
            ],
            &["receipt-success-witness", "receipt-ledger"],
            &[
                "acquisition-file-sync",
                "acquisition-directory-sync",
                "acquisition-ledger",
            ],
        ];
        let Some(name) = POINTS[usize::from(kind)].get(usize::from(point)).copied() else {
            return Ok(());
        };
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        let oracle = self.oracle.clone();
        let before = oracle.checkpoint_hits(name);
        {
            let mut ops = self.operations.borrow_mut();
            let op = &mut ops[index];
            if op.removed || !op.dispatched || op.host_released {
                return Ok(());
            }
            if kind == 1 && op.stage.is_none() || kind >= 2 && op.descriptor.is_none() {
                return Ok(());
            }
            if kind == 3 {
                let a = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
                // Match ordinary acquisition eligibility before injecting a
                // commit crash. A provider-local discard not yet committed
                // still permits the acquisition race; committed discard does
                // not, unless acquisition already won independently.
                if !op.acquisition_ready(&a) {
                    return Ok(());
                }
                if op.delivery_effects.get() == 0 {
                    let d = op.descriptor.as_ref().unwrap().clone();
                    // Copy preparation can fail before acquisition starts.
                    // Do not leave its fault armed for unrelated work.
                    checked(self.consumer_copy(op, &d))?;
                }
            }
            oracle.crash_at(name);
            let result: Result<(), AppError> = match kind {
                0 => self
                    .store()
                    .stage(&op.provider, &op.consumer.package_id, &op.id)
                    .map(|stage| {
                        op.stage = Some(stage);
                    }),
                1 => self
                    .store()
                    .seal(
                        &op.provider,
                        &op.consumer.package_id,
                        &op.id,
                        &op.stage.as_ref().unwrap().handle,
                        "image/png",
                    )
                    .map(|d| {
                        op.descriptor = Some(d);
                        op.durable_original = true;
                    }),
                2 => {
                    op.outcome = Outcome::Succeeded;
                    self.store()
                        .observe_receipt(
                            &op.provider,
                            &op.consumer.package_id,
                            &op.id,
                            op.revision.get() + 1,
                            op.receipt(op.delivery()),
                        )
                        .map(|_| ())
                }
                _ => self
                    .store()
                    .acquired(
                        &op.consumer,
                        &op.id,
                        op.descriptor.as_ref().unwrap(),
                        op.copy.to_str().unwrap(),
                    )
                    .map(|r| {
                        op.transfer = Some(r.transfer_receipt);
                        op.acquisition_committed = true;
                    }),
            };
            if oracle.checkpoint_hits(name) == before {
                oracle.crash_at("__none__");
                return Ok(());
            }
            if kind == 3 && point == 2 {
                // Evidence committed, even though the crash lost its reply.
                op.acquisition_committed = true;
            }
            if !result.is_err_and(|e| e.to_string().contains("injected aggregate crash")) {
                return Err(fail(
                    "aggregate checkpoint did not interrupt real production transition",
                ));
            }
        }
        self.restart(loss)?;
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
            ops.iter().filter(|o| o.host_released).count() as u64,
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
        // Only provider-visible commands need an admitted original request.
        // Preparation and consumer-idle events intentionally precede admission.
        // Fenced and replaced admissions still reach production native admission.
        let provider_event = match command {
            Command::Stage(s, ..)
            | Command::RecoveryWriterGc(s)
            | Command::CrashMidWrite(s)
            | Command::ProviderComplete(s)
            | Command::Publish(s, ..)
            | Command::Spool(s)
            | Command::FencedRepair(s)
            | Command::ReplacementSpool(s)
            | Command::CustodylessBesideLive(s)
            | Command::ReplacementCollision(s)
            | Command::WorkerActive(s, true, _)
            | Command::CancelExitRace(s, ..)
            | Command::AggregateCrash(s, ..)
            | Command::PausedProviderMutation(s, ..)
            | Command::Replay(s)
            | Command::SpoolReserve(s, ..)
            | Command::SettlementCrash(s)
            | Command::PausedMutation(s, ..) => Some(s),
            _ => None,
        };
        if let Some(index) = provider_event.and_then(|slot| self.index(slot)) {
            let visible = {
                let ops = self.operations.borrow();
                let op = &ops[index];
                op.dispatched
                    && checked(self.store().get(&op.consumer.package_id, &op.id))?.is_some()
            };
            if !visible {
                return self.invariants();
            }
        }
        match command {
            Command::Admit(s, i) => self.admit(s, i)?,
            Command::Register(s) => self.register(s)?,
            Command::Capture(s) => self.capture(s)?,
            Command::Dispatch(s) => self.dispatch(s)?,
            Command::CancelPreparation(s) => self.cancel_preparation(s)?,
            Command::ReleasePreparationCrash(s, p) => self.release_preparation_crash(s, p)?,
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
                            && !op.host_released
                            && op.valid_original
                            && (op.descriptor.is_some()
                                || op.sealed_original
                                || op.completion_identified)
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
                            || op.host_released
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
            Command::FencedRepair(s) => {
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
                        // Repair names its operation; the recovery permit
                        // admits that custody for the fenced admission.
                        self.complete_spool(s, true)?;
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
                        self.complete_spool(s, true)?;
                    }
                }
            }
            Command::CustodylessBesideLive(s) => {
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
                        // Several live operations no longer make a custody-less
                        // process ambiguous: it is standalone, never theirs.
                        self.spool_phase(Command::SpoolReserve(s, false, false))?;
                        if self.operations.borrow()[index].spool.is_some() {
                            return Err(fail("custody-less request became operation output"));
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
                    let admission = checked(self.store().get(&op.consumer.package_id, &op.id))?;
                    let may_start = match admission {
                        Some(a) => {
                            matches!(
                                a.phase,
                                AdmissionPhase::Forwarding
                                    | AdmissionPhase::Accepted
                                    | AdmissionPhase::Terminal
                            ) && !checked(
                                self.store()
                                    .execution_released(&op.consumer.package_id, &op.id),
                            )?
                        }
                        None => !provider,
                    };
                    if !op.removed && (!live || may_start) {
                        if provider {
                            op.provider_live = live;
                        } else {
                            op.consumer_live = live;
                        }
                    }
                }
            }
            Command::Acquire(s) => {
                self.consumer_attempt(self.acquire(s))?;
            }
            Command::ProviderDiscard(s, release) => self.provider_discard(s, release)?,
            Command::DiscardCrash(s, point, loss) => self.discard_crash(s, point, loss)?,
            Command::AcquiredReceipt(s) => {
                self.consumer_attempt(self.acquired_receipt(s))?;
            }
            Command::Ack(s, c) => {
                self.consumer_attempt(self.ack(s, c))?;
            }
            Command::ConsumerReceive(s, c) => {
                self.consumer_attempt(self.acquire(s))?;
                self.consumer_attempt(self.ack(s, c))?;
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
                if let Some(installed) = self.fixture.installed(role(p)) {
                    checked(super::super::set_enabled(&self.profile(), &id, true))?;
                    if !installed.enabled {
                        self.replace_broker(&id);
                    }
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
            Command::LifecycleCrash(provider, point)
            | Command::CompatibleUpgradeCrash(provider, point, _) => {
                let compatible = matches!(command, Command::CompatibleUpgradeCrash(..));
                let power_loss = matches!(command, Command::CompatibleUpgradeCrash(_, _, true));
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
                        Command::Upgrade(provider, compatible, false)
                    };
                    let crashed = self.mutation(mutation);
                    super::super::crash_at_boundary("__none__");
                    if crashed
                        .as_ref()
                        .is_err_and(|cause| cause.to_string().contains("injected lifecycle crash"))
                    {
                        self.restart(power_loss)?;
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
            Command::PausedProviderMutation(slot, kind, action) => {
                self.paused_mutation(slot, kind, action, true)?;
            }
            Command::CancelExitRace(slot, success) => {
                self.spool_phase(Command::SpoolReserve(slot, true, false))?;
                if let Some(index) = self.index(slot) {
                    if self.operations.borrow()[index].spool_phase == 1 {
                        #[cfg(unix)]
                        use std::os::unix::process::ExitStatusExt;
                        #[cfg(windows)]
                        use std::os::windows::process::ExitStatusExt;
                        let result = crate::process_ext::reap_after_cancellation(
                            || {
                                Ok(std::process::ExitStatus::from_raw(if success {
                                    0
                                } else {
                                    1
                                }))
                            },
                            "model cancellation",
                        );
                        if result.is_ok() {
                            for c in completion_commands(slot) {
                                self.spool_phase(c)?;
                            }
                        } else {
                            self.operations.borrow_mut()[index].writer.take();
                            self.operations.borrow_mut()[index].spool_phase = 30;
                        }
                        self.applied += 1;
                    }
                }
            }
            Command::CopyBeforeProof(slot) => {
                self.copy_before_proof(slot)?;
            }
            Command::AggregateCrash(slot, kind, point, loss) => {
                self.aggregate_crash(slot, kind, point, loss)?;
            }
            Command::RecaptureCrash(slot) => {
                self.recapture_crash(slot)?;
            }
            Command::ReconcilePreparation(slot) => {
                self.reconcile_preparation(slot)?;
            }
            Command::QueueIdleProof(slot, provider) => {
                if let Some(index) = self.index(slot) {
                    if let Some(owner) = self.participant_generation(index, provider) {
                        let ops = self.operations.borrow();
                        let op = &ops[index];
                        self.async_idle.set(true);
                        self.pending_idle.borrow_mut().insert(
                            (index, provider),
                            IdleProof {
                                owner,
                                idle: if provider {
                                    !op.provider_live && op.writer.is_none()
                                } else {
                                    !op.consumer_live
                                },
                            },
                        );
                        self.applied += 1;
                    }
                }
            }
            Command::DeliverIdleProof(slot, provider) => {
                if let Some(index) = self.index(slot) {
                    if let Some(proof) = self.pending_idle.borrow_mut().remove(&(index, provider)) {
                        self.idle_proofs
                            .borrow_mut()
                            .insert((index, provider), proof);
                        self.applied += 1;
                    }
                }
            }
            Command::PausedMutation(slot, kind, action) => {
                self.paused_mutation(slot, kind, action, false)?
            }
            Command::SharedConsumerAdmit => {
                self.admit(0, false)?;
                self.admit((SLOTS - 1) as u8, false)?;
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
        let artifacts = ["bytes", "stages"]
            .into_iter()
            .flat_map(|name| fs::read_dir(root.join(name)).unwrap())
            .filter_map(|e| e.ok())
            .map(|e| e.path());
        let spools = fs::read_dir(root.join("host-spools"))
            .unwrap()
            .filter_map(|e| e.ok())
            .flat_map(|e| [e.path().join("stdout"), e.path().join("stderr")]);
        let mut objects = std::collections::HashSet::new();
        artifacts
            .chain(spools)
            .filter_map(|path| {
                let id = crate::files::model_file_identity(&path).ok()?;
                objects
                    .insert(id)
                    .then(|| fs::metadata(path).unwrap().len())
            })
            .sum()
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
            || !op.completion_identified
                && !op.sealed_original
                && (self.oracle.contains_unflushed_data(&op.original)
                    || (op.writer.is_some()
                        && op.spool_phase >= 1
                        && op.paid_success
                        && op.valid_original))
    }
    fn invariants(&mut self) -> Result<(), TestCaseError> {
        if self.store.is_none() {
            return Ok(());
        }
        for op in self.operations.borrow_mut().iter_mut() {
            checked(op.observe_discard_commitment(self.store()))?;
            op.completion_identified |= op.descriptor.is_some()
                || op.spool.as_ref().is_some_and(|handle| {
                    self.store()
                        .host_spool_has_recorded_identity(handle)
                        .unwrap()
                });
        }
        for job in checked(self.store().snapshot_jobs())?.jobs {
            if let Some(old) = self.jobs.get(&job.job_key) {
                if job.revision < old.revision {
                    return Err(fail("job revision regressed"));
                }
                if old.state == JobState::Completed && job.state != JobState::Completed {
                    return Err(fail("released completion regressed"));
                }
            }
            if job.state == JobState::Completed {
                let ops = self.operations.borrow();
                let op = ops.iter().find(|o| o.id == job.operation_id).unwrap();
                if !(op.host_released || op.acquisition_committed)
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
            if op.host_released && op.delivery_effects.get() != 1 {
                return Err(fail(format!(
                    "released without exactly one delivery effect: {}",
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
                if admission.as_ref().is_some_and(|a| {
                    a.phase == AdmissionPhase::Released
                        && a.disposition.as_deref() == Some("never_forwarded")
                }) {
                    if job.state == JobState::NeedsAttention || job.output_path.is_some() {
                        return Err(fail(
                            "never-forwarded work requested attention or reported delivery",
                        ));
                    }
                    continue;
                }
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
            let sealed_original = op.stage.as_ref().is_some_and(|stage| {
                let conn = rusqlite::Connection::open(
                    self.fixture
                        .profile
                        .path()
                        .join("service-state/ledger.sqlite"),
                )
                .unwrap();
                let recorded = conn
                    .query_row(
                        "SELECT descriptor FROM artifacts WHERE handle=?1 AND status='sealed'",
                        [&stage.handle],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                let path = self
                    .fixture
                    .profile
                    .path()
                    .join("service-state/bytes")
                    .join(format!("{}.bin", stage.handle));
                recorded.is_some() && fs::read(path).ok().as_ref() == Some(&op.original)
            });
            if matches!(
                a.phase,
                AdmissionPhase::Forwarding | AdmissionPhase::Accepted
            ) && op.descriptor.is_none()
                && !sealed_original
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
                    let mut objects = BTreeMap::<String, u64>::new();
                    for path in [
                        PathBuf::from(&stage.path),
                        root.join("bytes").join(format!("{}.bin", stage.handle)),
                        root.join("bytes").join(format!("{}.pending", stage.handle)),
                    ] {
                        let bytes = possible_file_bytes(&path);
                        objects
                            .entry(self.oracle.possible_file_identity(&path))
                            .and_modify(|n| *n = (*n).max(bytes))
                            .or_insert(bytes);
                    }
                    reserved_output_bytes += objects.values().sum::<u64>();
                }
            }
            if (op.completion_identified || op.sealed_original)
                && op.valid_original
                && !op.removed
                && !op.discard_committed
                && a.disposition.as_deref() == Some("discarded")
            {
                return Err(fail(format!("success discarded: {}", op.id)));
            }
            if !op.removed
                && !op.host_released
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
                && op.acquisition_committed
                && (a.disposition.as_deref() != Some("acquired")
                    || self.notices.contains_key(&op.id)
                    || checked(
                        self.store()
                            .job_for_operation(&op.consumer.package_id, &op.id),
                    )?
                    .is_none_or(|j| j.state != JobState::Completed))
            {
                return Err(fail("removal misclassified durably acquired output"));
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
            if (op.completion_identified || op.sealed_original)
                && op.valid_original
                && !op.removed
                && !op.discard_committed
                && !self.original_conserved(op)
            {
                return Err(fail(format!("original bytes disappeared: {}", op.id)));
            }
            if op.host_released && fs::read(&op.copy).ok().as_ref() != Some(&op.original) {
                return Err(fail("released original lost"));
            }
        }
        self.custodyless_invariants(false)?;
        let charge = self.charges();
        let root = self.fixture.profile.path().join("service-state");
        let paths = ["bytes", "stages"]
            .into_iter()
            .flat_map(|name| fs::read_dir(root.join(name)).unwrap())
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .chain(
                fs::read_dir(root.join("host-spools"))
                    .unwrap()
                    .filter_map(|e| e.ok())
                    .flat_map(|e| [e.path().join("stdout"), e.path().join("stderr")]),
            )
            .chain(restored.keys().cloned());
        let mut possible_objects = BTreeMap::<String, u64>::new();
        for path in paths {
            let bytes = possible_file_bytes(&path);
            possible_objects
                .entry(self.oracle.possible_file_identity(&path))
                .and_modify(|n| *n = (*n).max(bytes))
                .or_insert(bytes);
        }
        let possible = possible_objects.values().sum::<u64>();
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
        self.async_idle.set(false);
        self.pending_idle.borrow_mut().clear();
        self.idle_proofs.borrow_mut().clear();
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
        for op in self.operations.borrow_mut().iter_mut() {
            op.consumer_live = false;
        }
        for slot in 0..SLOTS as u8 {
            self.reconcile_preparation(slot)?;
            self.cancel_preparation(slot)?;
        }
        for op in self.operations.borrow_mut().iter_mut() {
            if !op.removed && op.spool_phase <= 17 && op.paid_success {
                if let Some(writer) = &op.writer {
                    for point in op.spool_phase..=17 {
                        checked(writer.phase(point))?;
                        if point == 10 {
                            op.sealed_original |= op.valid_original;
                        }
                    }
                    op.spool_phase = 18;
                    op.durable_original |= op.valid_original;
                }
            }
            op.writer.take();
            if op.spool.is_some()
                && !op.provider_rejected()
                && !op.completion_identified
                && !op.sealed_original
                && !self
                    .store()
                    .host_spool_has_recorded_identity(op.spool.as_ref().unwrap())
                    .unwrap()
            {
                op.valid_original = false;
                if op.outcome != Outcome::Succeeded {
                    op.outcome = Outcome::Unknown;
                }
            }
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
        for spool in &mut self.custodyless {
            if !spool.removed && !spool.released {
                checked(
                    self.store
                        .as_ref()
                        .unwrap()
                        .release_host_spool(&spool.owner.package_id, &spool.handle),
                )?;
                spool.released = true;
            }
        }
        checked(self.store().gc())?;
        checked(self.store().sweep_host_spools(|_| false))?;
        self.custodyless_invariants(true)?;
        for op in self.operations.borrow().iter() {
            if !op.dispatched {
                if self.released_preparation(op) {
                    let job = checked(
                        self.store()
                            .job_for_operation(&op.consumer.package_id, &op.id),
                    )?
                    .unwrap();
                    if !job.state.terminal() || checked(self.store().busy(&op.consumer.package_id))?
                    {
                        return Err(fail("released preparation never settled or remained busy"));
                    }
                    if checked(self.store().auto_settlement_operations())?
                        .iter()
                        .any(|(a, _, _)| {
                            a.consumer.package_id == op.consumer.package_id
                                && a.operation_id == op.id
                        })
                    {
                        return Err(fail("released preparation remained an automatic candidate"));
                    }
                }
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
            if op.discard_committed {
                if a.phase != AdmissionPhase::Released
                    || a.disposition.as_deref() != Some("discarded")
                {
                    return Err(fail("committed discard never released custody"));
                }
                self.assert_custody_clean(op, false)?;
                continue;
            }
            if (op.completion_identified || op.sealed_original)
                && op.valid_original
                && (!op.host_released
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
        if op.removed || op.host_released {
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
        let status = op.receipt(op.delivery());
        let result = service_bridge::reconcile_at(m.store(), &op.provider, &current, &status);
        // A provider-local discard can survive a precommit host crash. Its
        // later status reply may commit even if release/reply then fails. The
        // oracle records that authenticated receipt, never host disposition.
        op.observe_discard_commitment(m.store())?;
        result?;
        let released = m.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        if released.phase == AdmissionPhase::Released
            && released.disposition.as_deref() == Some("acquired")
        {
            op.transfer = released.transfer_receipt;
            op.host_released = true;
        }
        Ok(())
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
        if op.removed || op.host_released || op.discard_committed {
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
            if !op.acquisition_ready(&current) {
                return Ok(());
            }
            m.consumer_copy(op, d)?;
            m.store()
                .acquired(&op.consumer, &op.id, d, op.copy.to_str().unwrap())?
        };
        op.transfer = Some(proof.transfer_receipt.clone());
        op.acquisition_committed = true;
        m.store().release(
            &op.provider,
            &op.consumer.package_id,
            &op.id,
            "acquired",
            Some(&proof.transfer_receipt),
        )?;
        op.host_released = true;
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
    fn with_activity(
        &self,
        _: &Store,
        a: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
        apply: &mut dyn FnMut(bool) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let _fence =
            backend::IdleCallFence::acquire(&[&a.consumer.package_id, &a.provider.package_id])?;
        let active = self.active(a, job, stopped, execution)?;
        if active || !self.machine.async_idle.get() {
            return apply(active);
        }
        let ops = self.machine.operations.borrow();
        let index = ops.iter().position(|o| o.id == a.operation_id).unwrap();
        let proofs = self.machine.idle_proofs.borrow();
        let idle = [false, true].into_iter().all(|provider| {
            proofs.get(&(index, provider)).is_some_and(|proof| {
                self.machine
                    .participant_generation(index, provider)
                    .is_some_and(|current| {
                        ai_operations::verified_idle_generation(
                            &proof.owner,
                            &current,
                            proof.idle,
                            true,
                        )
                    })
            })
        });
        drop(proofs);
        drop(ops);
        apply(!idle)
    }

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
            && !op.host_released
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
    "retained-preparation-automatic-convergence",
    "cancel-stale-observation-natural-success",
    "cancel-stale-observation-killed",
    "consumer-copy-before-proof",
    "crash-inside-stage",
    "crash-inside-seal",
    "crash-inside-receipt",
    "crash-inside-acquisition",
    "crash-recapture-retired",
    "provider-idle-request",
    "consumer-idle-request",
    "provider-idle-response",
    "consumer-idle-response",
    "compatible-upgrade-crash",
    "compatible-upgrade-power-loss",
    "provider-recovery-response-paused-lifecycle",
    "provider-native-writer-paused-lifecycle",
    "admit",
    "presentation-register",
    "preparation-capture",
    "service-dispatch",
    "preparation-cancel",
    "preparation-release-crash",
    "preparation-release-power-loss",
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
    "fenced-repair",
    "replacement-provider-repair-spool",
    "custodyless-beside-live-operations",
    "provider-request-counter-collision",
    "healthy-probe",
    "unhealthy-probe",
    "provider-active",
    "consumer-active",
    "worker-idle",
    "acquire",
    "ack-crash",
    "acquired-receipt-before-release",
    "provider-discard-commit",
    "provider-discard-release",
    "discard-crash-before-commit",
    "discard-crash-after-commit",
    "discard-crash-before-collection",
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
    "spool-before-capture",
    "spool-seal-durable",
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
        for captured in [false, true] {
            let mut machine = Machine::new();
            machine.apply(Command::Register(0))?;
            if captured {
                machine.apply(Command::Capture(0))?;
            }
            machine.apply(Command::Upgrade(false, true, false))?;
            machine.apply(Command::ReconcilePreparation(0))?;
            machine.quiesce()?;
            for (family, hits) in std::mem::take(&mut machine.coverage) {
                *totals.entry(family).or_default() += hits;
            }
        }

        collect_trace(
            vec![
                Command::ProviderComplete(0),
                Command::CopyBeforeProof(0),
                Command::Restart,
            ],
            totals,
        )?;
        collect_trace(vec![Command::CancelExitRace(0, true)], totals)?;
        collect_trace(vec![Command::CancelExitRace(0, false)], totals)?;
        collect_trace(
            vec![
                Command::QueueIdleProof(0, false),
                Command::QueueIdleProof(0, true),
                Command::DeliverIdleProof(0, false),
                Command::DeliverIdleProof(0, true),
                Command::Probe(true),
            ],
            totals,
        )?;
        for provider in [false, true] {
            for point in 4..=7 {
                for loss in [false, true] {
                    collect_trace(
                        vec![
                            Command::Spool(0),
                            Command::CompatibleUpgradeCrash(provider, point, loss),
                        ],
                        totals,
                    )?;
                }
            }
        }
        for kind in [0, 2] {
            for action in 0..=3 {
                let mut trace = vec![Command::Spool(0)];
                if kind == 2 {
                    trace.clear();
                }
                trace.push(Command::PausedProviderMutation(0, kind, action));
                collect_trace(trace, totals)?;
            }
        }
        for (kind, count) in [(0, 4), (1, 13), (2, 2), (3, 3)] {
            for point in 0..count {
                for loss in [false, true] {
                    let mut trace = vec![];
                    if kind == 1 {
                        trace.push(Command::Stage(0, true, true));
                    }
                    if kind == 2 {
                        trace.push(Command::Stage(0, true, true));
                        trace.push(Command::Seal(0));
                    }
                    if kind == 3 {
                        trace.push(Command::ProviderComplete(0));
                    }
                    trace.push(Command::AggregateCrash(0, kind, point, loss));
                    collect_trace(trace, totals)?;
                }
            }
        }
        {
            let mut machine = Machine::new();
            machine.apply(Command::Register(0))?;
            machine.apply(Command::Capture(0))?;
            machine.apply(Command::Upgrade(false, true, false))?;
            // Actual adoption occurs before the retrying capture callback.
            let current = machine.generation(Role::Consumer).unwrap();
            let id = machine.operations.borrow()[0].id.clone();
            checked(machine.store().adopt_preparation(&current, &id))?;
            machine.operations.borrow_mut()[0].consumer = current;
            machine.apply(Command::RecaptureCrash(0))?;
            machine.quiesce()?;
            for (family, hits) in std::mem::take(&mut machine.coverage) {
                *totals.entry(family).or_default() += hits;
            }
        }

        collect_trace(
            vec![
                Command::Register(1),
                Command::Capture(1),
                Command::CancelPreparation(1),
            ],
            totals,
        )?;
        for power_loss in [false, true] {
            collect_trace(
                vec![
                    Command::Register(1),
                    Command::Capture(1),
                    Command::ReleasePreparationCrash(1, power_loss),
                    Command::Sweep,
                ],
                totals,
            )?;
        }
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
        collect_trace(vec![Command::Sweep, Command::FencedRepair(0)], totals)?;
        collect_trace(
            vec![
                Command::SharedConsumerAdmit,
                Command::CustodylessBesideLive(0),
            ],
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
                    Command::SpoolReserve(0, true, false),
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
        collect_trace(
            vec![
                Command::ProviderComplete(0),
                Command::Acquire(0),
                Command::AcquiredReceipt(0),
                Command::Restart,
                Command::Sweep,
            ],
            totals,
        )?;
        for removal in [
            Command::Enable(false, false),
            Command::Uninstall(false),
            Command::Enable(true, false),
            Command::Uninstall(true),
        ] {
            collect_trace(
                vec![
                    Command::ProviderComplete(0),
                    Command::Acquire(0),
                    Command::AcquiredReceipt(0),
                    Command::Restart,
                    removal,
                ],
                totals,
            )?;
        }
        for loss in [false, true] {
            for point in 0..3 {
                let mut trace = vec![Command::ProviderComplete(0), Command::Acquire(0)];
                if point == 2 {
                    trace.push(Command::ProviderDiscard(0, false));
                }
                trace.push(Command::DiscardCrash(0, point, loss));
                collect_trace(trace, totals)?;
            }
        }
        for loss in [false, true] {
            for point in 0..3 {
                collect_trace(
                    vec![
                        Command::ProviderComplete(0),
                        Command::AggregateCrash(0, 3, point, loss),
                        Command::ProviderDiscard(0, false),
                        Command::Acquire(0),
                        Command::ProviderDiscard(0, true),
                    ],
                    totals,
                )?;
                let mut trace = vec![Command::ProviderComplete(0)];
                if point == 2 {
                    trace.push(Command::ProviderDiscard(0, false));
                }
                trace.extend([
                    Command::DiscardCrash(0, point, loss),
                    Command::Acquire(0),
                    Command::ProviderDiscard(0, false),
                    Command::ProviderDiscard(0, true),
                ]);
                collect_trace(trace, totals)?;
            }
        }
        for acquire_first in [false, true] {
            let mut trace = vec![Command::ProviderComplete(0)];
            if acquire_first {
                trace.extend([Command::Acquire(0), Command::Restart]);
            }
            trace.extend([
                Command::ProviderDiscard(0, false),
                Command::Restart,
                Command::Acquire(0),
                Command::Restart,
                Command::ProviderDiscard(0, true),
                Command::Restart,
            ]);
            collect_trace(trace, totals)?;
        }
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
/// #1405: shrunk counterexample recorded during a loaded full-suite run. It
/// passes alone: a parallel fixture held the process-wide AI action gate until
/// this machine's settlement budget elapsed. Fixtures now own the host profile.
#[test]
fn model_issue_1405_counterexample() {
    use Command::*;
    let trace = [
        SpoolManifest(2),
        SpoolReply(2),
        Admit(0, true),
        ConsumerReceive(1, false),
        PausedProviderMutation(1, 2, 0),
        SpoolReserve(2, true, true),
        SpoolSeal(0),
        ProviderComplete(2),
        Admit(2, true),
        Stage(0, false, true),
        Seal(0),
        Seal(0),
        SpoolSeal(0),
        CancelExitRace(2, true),
        DelayedReceipt(1, true),
        AggregateCrash(2, 3, 12, false),
        Register(0),
        RecoveryWriterGc(1),
        CancelPreparation(1),
    ];
    let mut m = Machine::new();
    for command in trace {
        m.apply(command)
            .unwrap_or_else(|cause| panic!("at={command:?}: {cause}"));
    }
    m.quiesce()
        .unwrap_or_else(|cause| panic!("quiesce: {cause}"));
}
#[test]
fn model_standalone_unbound_spool_does_not_revive_settled_execution() {
    let mut m = Machine::new();
    for command in [
        Command::Admit(1, false),
        Command::Publish(1, 2, false),
        Command::Sweep,
        Command::SpoolReserve(1, false, false),
    ] {
        m.apply(command).unwrap();
    }
    let ops = m.operations.borrow();
    let op = &ops[0];
    assert_eq!(
        m.store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap()
            .phase,
        AdmissionPhase::Released
    );
    assert!(m
        .store()
        .job_for_operation(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap()
        .state
        .terminal());
    assert!(m.store().claims().unwrap().is_empty());
    assert!(op.spool.is_none());
    assert_eq!(op.native_paid_starts.get(), 0);
    assert_eq!(m.custodyless.len(), 1);
    assert!(m.custodyless[0].writer.is_some());
    assert!(m.charges() > 0);
    drop(ops);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_custodyless_spool_beside_live_operation_is_standalone() {
    let mut m = Machine::new();
    for command in [
        Command::Admit(1, false),
        Command::Publish(1, 2, false),
        Command::Sweep,
        Command::Admit(0, false),
    ] {
        m.apply(command).unwrap();
    }
    m.apply(Command::SpoolReserve(1, false, false)).unwrap();
    assert_eq!(
        m.custodyless.len(),
        1,
        "a live admission must not capture a custody-less process"
    );
    for op in m.operations.borrow().iter() {
        assert!(op.spool.is_none());
        assert_eq!(op.native_paid_starts.get(), 0);
    }
    m.quiesce().unwrap();
}

#[test]
fn model_restart_refuses_expired_unadmitted_preparation_without_paid_work() {
    let mut m = Machine::new();
    m.apply(Command::SharedConsumerAdmit).unwrap();
    m.apply(Command::Admit(1, true)).unwrap();
    let index = m.index(1).unwrap();
    let captured = m.operations.borrow()[index].captured_inputs.clone();
    assert!(!captured.is_empty());
    m.apply(Command::Restart).unwrap();
    m.apply(Command::ReleasePreparationCrash(1, false)).unwrap();
    m.apply(Command::Dispatch(1)).unwrap();
    assert!(!m.operations.borrow()[index].dispatched);
    assert_eq!(m.operations.borrow()[index].starts.get(), 0);
    assert_eq!(m.operations.borrow()[index].captured_inputs, captured);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_noop_enable_preserves_captured_consumer_identity() {
    #[cfg(target_os = "linux")]
    if verify_production_broker_identity(false) {
        return;
    }
    let mut m = Machine::new();
    m.apply(Command::Register(0)).unwrap();
    m.apply(Command::Capture(0)).unwrap();
    m.apply(Command::Enable(false, true)).unwrap();
    m.apply(Command::Dispatch(0)).unwrap();
    assert_eq!(m.operations.borrow()[0].starts.get(), 1);
    m.quiesce().unwrap();
}

#[test]
fn model_provider_upgrade_preserves_capacity_blocked_consumer_preparation_identity() {
    #[cfg(target_os = "linux")]
    if verify_production_broker_identity(true) {
        return;
    }
    let mut m = Machine::new();
    m.apply(Command::SharedConsumerAdmit).unwrap();
    m.apply(Command::Admit(1, true)).unwrap();
    let index = m.index(1).unwrap();
    let captured = m.operations.borrow()[index].captured_inputs.clone();
    assert!(!captured.is_empty());
    assert!(!m.operations.borrow()[index].dispatched);
    m.apply(Command::Upgrade(true, true, false)).unwrap();
    m.apply(Command::Admit(1, false)).unwrap();
    assert_eq!(m.operations.borrow()[index].captured_inputs, captured);
    assert_eq!(m.operations.borrow()[index].starts.get(), 0);
    m.quiesce().unwrap();
}

#[test]
fn model_transient_consumer_directory_sync_failure_eventually_delivers() {
    let mut m = Machine::new();
    for command in [
        Command::SharedConsumerAdmit,
        Command::ProviderComplete(0),
        Command::DirectorySyncFailure(true),
        Command::ConsumerReceive(0, false),
        Command::Restart,
        Command::DirectorySyncFailure(false),
    ] {
        m.apply(command).unwrap();
    }
    m.quiesce().unwrap();
    assert!(
        m.deferred_consumer_attempts.get() > 0,
        "the injected error must actually defer delivery"
    );
    let ops = m.operations.borrow();
    assert_eq!(fs::read(&ops[0].copy).unwrap(), ops[0].original);
    assert_eq!(ops[0].delivery_effects.get(), 1);
    assert!(ops[0].host_released);
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
fn model_removal_cleans_legacy_inferred_provider_spool() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    {
        let mut ops = m.operations.borrow_mut();
        let op = &mut ops[0];
        let (handle, path) = m
            .store()
            .reserve_host_spool(&op.provider, "host:opaque", 4096)
            .unwrap();
        // A ledger from a host that inferred custody (before #1172).
        m.store()
            .link_legacy_inferred_custody(&handle, &op.consumer.package_id, &op.id)
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
        m.apply(Command::Publish(0, outcome, false)).unwrap();
        m.apply(Command::Spool(0)).unwrap();
        assert!(m.operations.borrow()[0].spool.is_none());
        assert_eq!(m.operations.borrow()[0].starts.get(), 1);
        m.quiesce().unwrap();
    }
}

#[test]
fn model_replacement_provider_repair_reply_delivers_original() {
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
fn model_replacement_provider_repair_reply_is_removed_with_consumer() {
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
fn model_fenced_unknown_repair_conserves_original() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    let (consumer, operation) = {
        let ops = m.operations.borrow();
        (ops[0].consumer.package_id.clone(), ops[0].id.clone())
    };
    assert!(m.store().execution_released(&consumer, &operation).unwrap());
    m.apply(Command::FencedRepair(0)).unwrap();
    assert!(m.operations.borrow()[0].unpaid_repair);
    assert!(m.operations.borrow()[0].valid_original);
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[0].starts.get(), 1);
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_fenced_unknown_repair_is_removed_with_consumer() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::Sweep).unwrap();
    m.apply(Command::FencedRepair(0)).unwrap();
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
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.apply(Command::SpoolReserve(0, true, false)).unwrap();
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

#[test]
fn model_provider_rejection_fences_late_raw_native_reply() {
    for outcome in [2, 3] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        for command in [
            Command::SpoolReserve(0, true, false),
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
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.complete_spool(0, true).unwrap();
    m.apply(Command::Upgrade(true, true, false)).unwrap();
    m.apply(Command::ReplacementCollision(0)).unwrap();
    assert!(m.operations.borrow()[0].collision_reply);
    assert_eq!(m.custodyless.len(), 1);
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
fn model_host_only_unknown_success_emits_one_removal_notice() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::SpoolReserve(0, true, false),
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
        "durable original had no emitted undelivered notice"
    );
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
    // A custody-less run beside both live operations belongs to neither.
    let charge = m.charges();
    let disk = m.disk_bytes();
    let (opaque, _) = m
        .store()
        .reserve_host_spool(&provider, "opaque-shared-provider-reply", 4096)
        .unwrap();
    m.store()
        .abandon_unsealed_host_spool(&provider.package_id, &opaque)
        .unwrap();
    m.store().sweep_host_spools(|_| true).unwrap();
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
fn model_atomic_seal_commits_success_before_database_pre_seal_crash_is_unknown() {
    // 5: stdout file sync; 7: partial stderr; 10: sealed completion;
    // 11: derived ledger identity. Atomic seal rename commits success;
    // pre-seal crashes settle silently as Unknown with all charges released.
    for last in [5, 7, 10, 11] {
        for power_loss in [false, true] {
            let mut m = Machine::new();
            m.admit(0, false).unwrap();
            m.apply(Command::SpoolReserve(0, true, false)).unwrap();
            for command in reply_commands(0).into_iter().take(last) {
                m.apply(command).unwrap();
            }
            assert_eq!(m.operations.borrow()[0].sealed_original, last >= 10);
            m.apply(if power_loss {
                Command::PowerLoss
            } else {
                Command::Restart
            })
            .unwrap();
            m.quiesce().unwrap();
            let ops = m.operations.borrow();
            let op = &ops[0];
            if last >= 10 {
                assert_eq!(fs::read(&op.copy).unwrap(), op.original);
                assert_eq!(op.delivery_effects.get(), 1);
            } else {
                let job = m
                    .store()
                    .job_for_operation(&op.consumer.package_id, &op.id)
                    .unwrap()
                    .unwrap();
                assert!(job.state.terminal());
                assert_ne!(job.state, JobState::Completed);
                assert_eq!(op.outcome, Outcome::Unknown);
                assert_eq!(op.delivery_effects.get(), 0);
                assert!(!op.copy.exists());
            }
            assert_eq!(op.starts.get(), 1);
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
        }
    }
}

#[test]
fn model_compatible_replacement_retains_recaptured_preparation_across_incarnations() {
    let mut m = Machine::new();
    for command in [
        Command::Register(1),
        Command::LifecycleCrash(true, 0),
        Command::Admit(1, true),
        Command::Upgrade(false, true, false),
    ] {
        m.apply(command).unwrap();
    }
    m.quiesce().unwrap();
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
    {
        let ops = m.operations.borrow();
        let op = &ops[0];
        fs::remove_file(
            op.copy
                .parent()
                .unwrap()
                .join(format!("{}.delivery.json", op.id)),
        )
        .unwrap();
    }
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
fn model_stdout_partial_crash_has_no_completion_identity() {
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
    assert!(!path.join("pending.json").exists());
    assert!(path.join("stdout").exists());
    assert!(!path.join("stderr").exists());
    assert!(!m.operations.borrow()[0].completion_identified);
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
    assert!(m.operations.borrow()[0].host_released);
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
    let attempts = m.operations.borrow()[index].native_attempts;
    m.apply(Command::SpoolReserve(2, true, false)).unwrap();
    let ops = m.operations.borrow();
    assert!(ops[index].writer.is_none());
    assert!(ops[index].spool.is_none());
    assert_eq!(ops[index].native_paid_starts.get(), before_starts);
    assert_eq!(ops[index].native_attempts, attempts + 1);
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
    let ops = m.operations.borrow();
    assert!(ops[0].writer.is_none());
    assert_eq!(ops[0].native_paid_starts.get(), 0);
    assert_eq!(ops[0].native_attempts, 1);
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

#[test]
fn model_consumer_copy_before_proof_survives_restart_without_another_delivery() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::ProviderComplete(0)).unwrap();
    m.apply(Command::CopyBeforeProof(0)).unwrap();
    m.apply(Command::Restart).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
}

#[test]
fn model_crash_before_atomic_seal_rename_settles_silently_as_unknown() {
    for crash in [Command::Restart, Command::SpoolCrash(0, 2)] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        m.apply(Command::SpoolReserve(0, true, false)).unwrap();
        m.apply(Command::SpoolReply(0)).unwrap();
        assert!(m.operations.borrow()[0].paid_success);
        assert!(!m.operations.borrow()[0].completion_identified);
        m.apply(crash).unwrap();
        // Atomic seal rename is the success commit point. Before it, durable
        // stdout cannot prove completeness: the exit status is only in RAM.
        // Crash therefore settles silently as Unknown and releases charges.
        assert!(m.operations.borrow()[0].paid_success);
        assert!(!m.operations.borrow()[0].valid_original);
        assert_eq!(m.operations.borrow()[0].outcome, Outcome::Unknown);
        m.quiesce().unwrap();
        let ops = m.operations.borrow();
        let op = &ops[0];
        let job = m
            .store()
            .job_for_operation(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap();
        assert!(job.state.terminal());
        assert_ne!(job.state, JobState::Completed);
        assert_eq!(op.starts.get(), 1);
        assert_eq!(op.delivery_effects.get(), 0);
        assert_eq!(m.charges(), 0);
    }
}

#[test]
fn model_preparation_capture_retries_use_broker_authority_and_released_tombstones() {
    for trace in [
        vec![
            Command::Register(0),
            Command::CompatibleUpgradeCrash(false, 4, false),
            Command::Capture(0),
        ],
        vec![
            Command::DirectorySyncFailure(true),
            Command::Admit(0, true),
            Command::Upgrade(false, true, false),
        ],
        vec![
            Command::Register(1),
            Command::UnlinkFailure(true),
            Command::Capture(1),
            Command::PowerLoss,
            Command::Capture(1),
        ],
        vec![
            Command::DirectorySyncFailure(true),
            Command::Admit(2, true),
            Command::CompatibleUpgradeCrash(false, 4, true),
            Command::Capture(2),
        ],
    ] {
        let mut m = Machine::new();
        for command in trace {
            m.apply(command).unwrap();
        }
        assert!(m
            .operations
            .borrow()
            .iter()
            .all(|op| !op.dispatched && op.starts.get() == 0));
        m.quiesce().unwrap();
        assert_eq!(m.charges(), 0);
    }
}

#[test]
fn model_idle_answers_are_independently_delayed_and_generation_bound() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    m.apply(Command::QueueIdleProof(0, false)).unwrap();
    m.apply(Command::QueueIdleProof(0, true)).unwrap();
    m.apply(Command::DeliverIdleProof(0, false)).unwrap();
    m.apply(Command::Probe(true)).unwrap();
    let (consumer, id) = {
        let ops = m.operations.borrow();
        (ops[0].consumer.package_id.clone(), ops[0].id.clone())
    };
    assert!(!m.store().execution_released(&consumer, &id).unwrap());
    m.apply(Command::Upgrade(true, true, false)).unwrap();
    m.apply(Command::DeliverIdleProof(0, true)).unwrap();
    m.apply(Command::Probe(true)).unwrap();
    assert!(!m.store().execution_released(&consumer, &id).unwrap());
    m.apply(Command::QueueIdleProof(0, true)).unwrap();
    m.apply(Command::DeliverIdleProof(0, true)).unwrap();
    m.quiesce().unwrap();
}

#[test]
fn model_identical_bytes_in_separate_objects_still_require_separate_charge() {
    let mut m = Machine::new();
    m.apply(Command::Register(0)).unwrap();
    m.apply(Command::Capture(0)).unwrap();
    let root = m.fixture.profile.path().join("service-state/bytes");
    let input = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
    let before = m.disk_bytes();
    fs::copy(&input, root.join("unaccounted.bin")).unwrap();
    assert_eq!(m.disk_bytes(), before * 2);
    assert!(m
        .invariants()
        .unwrap_err()
        .to_string()
        .contains("quota undercharge"));
}

#[test]
fn model_preparation_events_do_not_require_a_provider_admission() {
    let mut m = Machine::new();
    m.apply(Command::Register(0)).unwrap();
    m.apply(Command::WorkerActive(0, false, true)).unwrap();
    assert!(m.operations.borrow()[0].consumer_live);
    m.apply(Command::WorkerActive(0, false, false)).unwrap();
    m.apply(Command::Stage(0, true, true)).unwrap();
    assert!(!m.operations.borrow()[0].paid_success);
    m.apply(Command::Capture(0)).unwrap();
    m.apply(Command::Upgrade(false, true, false)).unwrap();
    m.apply(Command::ReconcilePreparation(0)).unwrap();
    assert!(m.operations.borrow()[0].removed);
    assert_eq!(m.coverage["retained-preparation-automatic-convergence"], 1);
    m.quiesce().unwrap();
}

#[test]
fn model_shared_consumer_coverage_counts_new_admission_only() {
    let mut m = Machine::new();
    for _ in 0..3 {
        m.apply(Command::SharedConsumerAdmit).unwrap();
    }
    assert_eq!(m.coverage["shared-provider-consumers"], 1);
    m.quiesce().unwrap();
}

#[test]
fn model_acquired_receipt_crash_then_removal_before_admission_release_is_delivered() {
    for removal in [
        Command::Enable(false, false),
        Command::Uninstall(false),
        Command::Enable(true, false),
        Command::Uninstall(true),
    ] {
        let mut m = Machine::new();
        for command in [
            Command::Admit(0, false),
            Command::ProviderComplete(0),
            Command::Acquire(0),
            Command::AcquiredReceipt(0),
            Command::Restart,
        ] {
            m.apply(command).unwrap();
        }
        let (consumer, id, provider) = {
            let ops = m.operations.borrow();
            (
                ops[0].consumer.package_id.clone(),
                ops[0].id.clone(),
                ops[0].provider.clone(),
            )
        };
        let before = m.store().get(&consumer, &id).unwrap().unwrap();
        assert_eq!(before.phase, AdmissionPhase::Terminal);
        assert_eq!(before.disposition, None);
        let receipt = m.store().provider_receipt(&consumer, &id).unwrap().unwrap();
        assert_eq!(receipt["delivery"]["state"], "acquired");
        m.apply(removal).unwrap();
        let after = m.store().get(&consumer, &id).unwrap().unwrap();
        assert_eq!(after.disposition.as_deref(), Some("acquired"));
        assert_eq!(m.notices.get(&id).copied().unwrap_or(0), 0);
        let job = m
            .store()
            .job_for_operation(&consumer, &id)
            .unwrap()
            .unwrap();
        assert_eq!(job.state, JobState::Completed);
        assert_eq!(
            fs::read(job.output_path.unwrap()).unwrap(),
            m.operations.borrow()[0].original
        );
        service_bridge::reconcile_at(m.store(), &provider, &after, &receipt).unwrap();
        m.quiesce().unwrap();
        assert_eq!(m.charges(), 0);
    }
}

/// Run the identity contract against the production registry, allocation and
/// retirement path, in an isolated native subprocess. Model-owned generations
/// remain transport fixtures and must never be evidence of broker identity.
#[cfg(target_os = "linux")]
fn verify_production_broker_identity(upgrade_provider: bool) -> bool {
    use std::process::Command as ProcessCommand;
    if std::env::var_os("TE_MODEL_BROKER_IDENTITY").is_none() {
        let profile = tempfile::Builder::new()
            .prefix("te-lifecycle-native.")
            .tempdir_in("/tmp")
            .unwrap();
        for directory in ["config", "data", "cache", "runtime"] {
            fs::create_dir(profile.path().join(directory)).unwrap();
        }
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            profile.path().join("runtime"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let test = if upgrade_provider {
            "model_provider_upgrade_preserves_capacity_blocked_consumer_preparation_identity"
        } else {
            "model_noop_enable_preserves_captured_consumer_identity"
        };
        let result = ProcessCommand::new("xvfb-run")
            .args(["-a", "-s", "-screen 0 1024x768x24", "dbus-run-session", "--", "sh", "-c",
                r#"openbox >/dev/null 2>&1 & wm=$!; trap 'kill $wm 2>/dev/null || true' EXIT; timeout 45s "$@""#, "fixture"])
            .arg(std::env::current_exe().unwrap()).args([test, "--nocapture", "--test-threads=1"])
            .env("TE_MODEL_BROKER_IDENTITY", "1").env("TE_LIFECYCLE_NATIVE_FIXTURE", "1")
            .env("GDK_BACKEND", "x11")
            .env("XDG_CURRENT_DESKTOP", "Openbox")
            .env("XDG_SESSION_TYPE", "x11")
            .env("XDG_SESSION_DESKTOP", "openbox")
            .env("NO_AT_BRIDGE", "1")
            .env_remove("HYPRLAND_INSTANCE_SIGNATURE")
            .env_remove("SWAYSOCK")
            .env_remove("I3SOCK")
            .env_remove("SESSION_MANAGER")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("DBUS_SESSION_BUS_ADDRESS")
            .env("XDG_CONFIG_HOME", profile.path().join("config"))
            .env("XDG_DATA_HOME", profile.path().join("data"))
            .env("XDG_CACHE_HOME", profile.path().join("cache"))
            .env("XDG_RUNTIME_DIR", profile.path().join("runtime"))
            .output().unwrap();
        assert!(
            result.status.success(),
            "production broker identity probe failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return false;
    }
    let app = super::super::mutation_native_tests::native_app();
    // Only initialize the broker: background AI/startup reconciliation is not
    // part of this lifecycle identity contract and would compete with the probe.
    backend::initialize(app.handle().clone());
    let root = crate::installed_plugins::root().unwrap();
    fs::create_dir_all(&root).unwrap();
    super::super::super::service_host::initialize(root.parent().unwrap()).unwrap();
    backend::finish_initialize();
    let mut consumer = super::super::mutation_native_tests::scripted(
        &root,
        "fixture.identity.consumer",
        3,
        "quiesce",
    );
    let services = json!([{"id":"image-generation","major":1,"methods":["describe","prepare","start","status","cancel","acknowledge"]}]);
    consumer.manifest.service_dependencies = serde_json::from_value(json!([{
        "packageId":"fixture.identity.provider","serviceId":"image-generation","major":1
    }]))
    .unwrap();
    // A real native service endpoint: dispatch returns an admitted running
    // receipt and logs the original input descriptors for outcome assertions.
    let source = r#"#!/usr/bin/env python3
import json,os,sys
for line in sys.stdin:
 f=json.loads(line); m=f.get('method'); p=f.get('params',{})
 if m is None or 'id' not in f: continue
 if m=='initialize': r={'protocolVersion':1,'ready':False}
 elif m=='ping': r={'pid':os.getpid()}
 elif m=='lifecycle.quiesce': r={'ready':False,'idle':True,'checkpoint':True}
 elif m=='services.image-generation.v1.start':
  p=p['request']
  r={'version':1,'operationId':p['operationId'],'requestFingerprint':p['effectiveRecipeDigest'],'provider':{'packageId':'fixture.identity.provider','serviceId':'image-generation','major':1},'revision':1,'execution':{'state':'running'},'delivery':{'state':'none'}}
  with open(os.environ['XDG_CONFIG_HOME']+'/identity-dispatch.jsonl','a') as log: log.write(json.dumps(p)+'\n')
 else: r={'ready':True}
 print(json.dumps({'jsonrpc':'2.0','id':f['id'],'result':r}),flush=True)
"#;
    let mut provider = backend::native_tests::payload(&root, source);
    provider.manifest.id = "fixture.identity.provider".into();
    provider.manifest.contributions = vec!["fixture-identity-provider".into()];
    provider.manifest.sdk_version = 3;
    provider.manifest.services = serde_json::from_value(services).unwrap();
    package::write_index(&root, &[consumer.clone(), provider.clone()]).unwrap();
    let owner = backend::ensure(&consumer.manifest.id).unwrap();
    let before = owner.generation();
    let pid = owner.call("ping", json!({})).unwrap()["pid"]
        .as_i64()
        .unwrap();
    // Check the actual worker, not just the runner's environment.
    let worker_environment = fs::read(format!("/proc/{pid}/environ")).unwrap();
    let display = format!("DISPLAY={}", std::env::var("DISPLAY").unwrap());
    assert!(worker_environment
        .split(|b| *b == 0)
        .any(|e| e == display.as_bytes()));
    assert!(worker_environment
        .split(|b| *b == 0)
        .any(|e| e == b"GDK_BACKEND=x11"));
    assert!(!worker_environment
        .split(|b| *b == 0)
        .any(|e| e.starts_with(b"WAYLAND_DISPLAY=")));
    let store = Store::open(
        root.parent().unwrap().join("service-state"),
        Limits {
            disk_bytes: 200 * 1024 * 1024 + 16 * 1024,
            operations: 4,
            per_consumer: 3,
        },
    )
    .unwrap();
    let profile = super::super::Profile {
        root: &root,
        store: &store,
    };
    let provider_owner = backend::ensure(&provider.manifest.id).unwrap().generation();
    let target = ServiceTarget {
        package_id: provider.manifest.id.clone(),
        service_id: "image-generation".into(),
        major: 1,
    };
    // Occupy output capacity independently of the consumer. Captures fit,
    // but no 100 MiB execution reservation fits until a blocker is released.
    let blockers: Vec<_> = (0..2)
        .map(|i| {
            let caller = PackageGeneration {
                package_id: format!("fixture.identity.blocker{i}"),
                digest: "a".repeat(64),
                incarnation: 1,
            };
            store
                .reserve(Admission {
                    consumer: caller.clone(),
                    provider: provider_owner.clone(),
                    target: target.clone(),
                    operation_id: "blocker".into(),
                    fingerprint: "b".repeat(64),
                    phase: AdmissionPhase::Reserved,
                    inputs: vec![],
                    output: None,
                    needs_attention: false,
                    disposition: None,
                    transfer_receipt: None,
                })
                .unwrap();
            store.claim_forwarding(&caller, "blocker").unwrap();
            caller
        })
        .collect();
    let input = root.parent().unwrap().join("identity-input.png");
    let original = image_bytes(97);
    fs::write(&input, &original).unwrap();
    let preparations: Vec<_> = ["identity-captured", "identity-blocked"].into_iter().enumerate().map(|(i, operation)| {
        store.register_job(JobRecord {
            job_key: format!("{:048x}", i + 1), owner: before.clone(), operation_id: operation.into(), job_id: i as u64 + 1, kind: "identity-image".into(), label: "identity.png".into(), origin_window: "main".into(), revision: 0, source_revision: 0, ownership_epoch: 0, created_at_ms: 1, updated_at_ms: 1, settled_at_ms: None, estimate_key: None, state: JobState::Accepting, phase: Some("accepting".into()), output_path: None, cost: None, reveal: None, error: None, run_id: None,
        }).unwrap();
        let captures = store.capture(&before, operation, vec![CaptureInput { path: input.to_string_lossy().into(), expected_digest: None }]).unwrap();
        let mut request = json!({"operationId":operation,"connectionId":"identity-profile","expectedConnectionRevision":"identity-revision","model":null,"prompt":"identity probe","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"identity-token","effectiveRecipeDigest":"b".repeat(64)});
        request["inputs"] = json!(captures.iter().map(|c| c.artifact.clone()).collect::<Vec<_>>());
        (operation, captures, request)
    }).collect();
    assert_eq!(store.list_preparations().unwrap(), vec![before.clone()]);
    let dispatch = |request: Value| {
        let entries = package::list(&root).unwrap();
        let current_consumer =
            backend::current_instance(&consumer.manifest.id).expect("consumer must stay active");
        let (routed, _) = service_graph::route(
            &entries,
            current_consumer.manifest(),
            &target.package_id,
            &target.service_id,
            target.major,
            "start",
        )
        .unwrap();
        let broker = backend::ensure(&routed.manifest.id).unwrap();
        service_bridge::image_call(
            &store,
            &current_consumer.generation(),
            &broker.generation(),
            &target,
            "start",
            request,
            || current_consumer.is_active(),
            |method, params| broker.call(method, params),
        )
    };
    let blocked = dispatch(preparations[1].2.clone()).unwrap_err();
    assert!(
        expected_capacity(&blocked),
        "probe must reach capacity refusal: {blocked}"
    );
    assert!(store
        .get(&before.package_id, preparations[1].0)
        .unwrap()
        .is_none());
    assert!(!PathBuf::from(std::env::var("XDG_CONFIG_HOME").unwrap())
        .join("identity-dispatch.jsonl")
        .exists());
    if upgrade_provider {
        let old_provider = backend::ensure(&provider.manifest.id).unwrap().generation();
        let archives = root.parent().unwrap().join("archives");
        fs::create_dir_all(&archives).unwrap();
        let archive = archives.join("provider-next.teplugin");
        let mut manifest = provider.manifest.clone();
        manifest.version = "2.0.0".into();
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        serde_json::to_writer(&mut zip, &manifest).unwrap();
        use std::io::Write;
        for name in manifest.files.keys() {
            zip.start_file(name, options).unwrap();
            zip.write_all(&fs::read(package::payload_path(&root, &provider).join(name)).unwrap())
                .unwrap();
        }
        zip.finish().unwrap();
        super::super::upgrade(&profile, &archive, &|_, _, _| Ok(())).unwrap();
        assert!(
            backend::active_instance(&provider.manifest.id, &old_provider.digest).is_none(),
            "probe must really retire the affected provider"
        );
    } else {
        super::super::set_enabled(&profile, &consumer.manifest.id, true).unwrap();
    }
    let after = backend::current_instance(&consumer.manifest.id)
        .expect("lifecycle retired the unaffected consumer broker")
        .generation();
    assert_eq!(
        after, before,
        "production replaced the unaffected broker incarnation"
    );
    for name in ["DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME"] {
        let expected = format!("{name}={}", std::env::var(name).unwrap());
        assert!(worker_environment
            .split(|b| *b == 0)
            .any(|e| e == expected.as_bytes()));
    }
    assert!(super::super::mutation_native_tests::running(pid));
    for blocker in &blockers {
        store
            .terminal(&provider_owner, &blocker.package_id, "blocker", None, false)
            .unwrap();
        store
            .release(
                &provider_owner,
                &blocker.package_id,
                "blocker",
                "discarded",
                None,
            )
            .unwrap();
    }
    for (operation, captures, request) in &preparations {
        assert_eq!(
            store
                .job_for_operation(&before.package_id, operation)
                .unwrap()
                .unwrap()
                .owner,
            before
        );
        let recaptured = store
            .capture(
                &after,
                operation,
                vec![CaptureInput {
                    path: input.to_string_lossy().into(),
                    expected_digest: None,
                }],
            )
            .unwrap();
        assert_eq!(recaptured[0].artifact, captures[0].artifact);
        assert_eq!(
            dispatch(request.clone()).unwrap()["execution"]["state"],
            "running"
        );
        let admitted = store.get(&after.package_id, operation).unwrap().unwrap();
        assert_eq!(admitted.consumer, before);
        assert_eq!(admitted.inputs, vec![captures[0].artifact.clone()]);
        let path = store
            .read(
                &admitted.provider,
                &after.package_id,
                operation,
                &captures[0].artifact,
            )
            .unwrap();
        assert_eq!(fs::read(path.path).unwrap(), original);
    }
    let dispatched: Vec<Value> = fs::read_to_string(
        PathBuf::from(std::env::var("XDG_CONFIG_HOME").unwrap()).join("identity-dispatch.jsonl"),
    )
    .unwrap()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect();
    assert_eq!(
        dispatched,
        preparations
            .iter()
            .map(|(_, _, request)| request.clone())
            .collect::<Vec<_>>()
    );
    backend::shutdown();
    drop(app);
    true
}

#[test]
fn model_acquisition_evidence_alone_makes_removal_delivered() {
    let mut m = Machine::new();
    for command in [
        Command::Admit(0, false),
        Command::ProviderComplete(0),
        Command::Acquire(0),
        Command::Restart,
        Command::Enable(false, false),
    ] {
        m.apply(command).unwrap();
    }
    assert!(!m.operations.borrow()[0].host_released);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
}

#[test]
fn model_removal_preserves_committed_delivery_when_consumer_later_deletes_copy() {
    let mut m = Machine::new();
    for command in [
        Command::Admit(0, false),
        Command::ProviderComplete(0),
        Command::Acquire(0),
        Command::AcquiredReceipt(0),
        Command::Restart,
    ] {
        m.apply(command).unwrap();
    }
    let ops = m.operations.borrow();
    let op = &ops[0];
    fs::remove_file(&op.copy).unwrap();
    // Consumer edits after acquisition are outside the delivery conservation
    // oracle. Drive production removal directly: historical delivery must not
    // be regraded from the consumer's current filesystem contents.
    let (result, events) = backend::capture_job_events(|| {
        super::super::set_enabled(&m.profile(), &op.consumer.package_id, false)
    });
    result.unwrap();
    assert!(!events.iter().any(|e| e["job"]["state"] == "error"));
    let a = m
        .store()
        .get(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(a.disposition.as_deref(), Some("acquired"));
    let job = m
        .store()
        .job_for_operation(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(job.state, JobState::Completed);
    assert_eq!(job.output_path.as_deref(), op.copy.to_str());
    assert_eq!(m.charges(), 0);
}

#[test]
fn model_provider_discard_and_acquisition_first_commit_wins_across_crashes() {
    for acquire_first in [false, true] {
        for power_loss in [false, true] {
            let crash = if power_loss {
                Command::PowerLoss
            } else {
                Command::Restart
            };
            let mut m = Machine::new();
            for command in [
                Command::Admit(0, true),
                Command::ProviderComplete(0),
                Command::CopyBeforeProof(0),
                crash,
            ] {
                m.apply(command).unwrap();
            }
            if acquire_first {
                m.apply(Command::Acquire(0)).unwrap();
                m.apply(crash).unwrap();
            }
            m.apply(Command::ProviderDiscard(0, false)).unwrap();
            m.apply(crash).unwrap();
            m.apply(Command::Acquire(0)).unwrap();
            m.apply(crash).unwrap();
            if acquire_first {
                m.apply(Command::AcquiredReceipt(0)).unwrap();
                m.apply(crash).unwrap();
            }
            m.apply(Command::ProviderDiscard(0, true)).unwrap();
            m.apply(crash).unwrap();
            m.quiesce().unwrap();
            let ops = m.operations.borrow();
            let op = &ops[0];
            let a = m
                .store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            assert_eq!(a.phase, AdmissionPhase::Released);
            assert_eq!(
                a.disposition.as_deref(),
                Some(if acquire_first {
                    "acquired"
                } else {
                    "discarded"
                })
            );
            assert_eq!(op.acquisition_committed, acquire_first);
            m.assert_custody_clean(op, false).unwrap();
            assert!(m.store().claims().unwrap().is_empty());
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
        }
    }
}

#[test]
fn model_discard_acquisition_races_at_internal_durable_barriers_converge() {
    for loss in [false, true] {
        for point in 0..3 {
            for discard_crash in [false, true] {
                let mut m = Machine::new();
                m.apply(Command::Admit(0, true)).unwrap();
                m.apply(Command::ProviderComplete(0)).unwrap();
                if discard_crash {
                    if point == 2 {
                        m.apply(Command::ProviderDiscard(0, false)).unwrap();
                    }
                    m.apply(Command::DiscardCrash(0, point, loss)).unwrap();
                } else {
                    m.apply(Command::AggregateCrash(0, 3, point, loss)).unwrap();
                }
                m.apply(Command::ProviderDiscard(0, false)).unwrap();
                m.apply(Command::Acquire(0)).unwrap();
                m.apply(Command::ProviderDiscard(0, true)).unwrap();
                m.quiesce().unwrap();
                let ops = m.operations.borrow();
                let op = &ops[0];
                assert_eq!(op.acquisition_committed, !discard_crash && point == 2);
                let a = m
                    .store()
                    .get(&op.consumer.package_id, &op.id)
                    .unwrap()
                    .unwrap();
                assert_eq!(a.phase, AdmissionPhase::Released);
                assert_eq!(
                    a.disposition.as_deref(),
                    Some(if op.acquisition_committed {
                        "acquired"
                    } else {
                        "discarded"
                    })
                );
                m.assert_custody_clean(op, false).unwrap();
                assert_eq!(m.charges(), 0);
                assert_eq!(m.disk_bytes(), 0);
                assert!(m.store().claims().unwrap().is_empty());
            }
        }
    }
}

#[test]
fn model_persistent_provider_discard_after_acquisition_converges_without_provider_rollback() {
    for loss in [false, true] {
        let mut m = Machine::new();
        for command in [
            Command::Admit(0, true),
            Command::ProviderComplete(0),
            Command::Acquire(0),
            Command::ProviderDiscard(0, false),
        ] {
            m.apply(command).unwrap();
        }
        m.apply(if loss {
            Command::PowerLoss
        } else {
            Command::Restart
        })
        .unwrap();
        // No provider acquired receipt, synthetic Ack or explicit release.
        // Automatic status must handle the provider's immutable discard reply.
        m.quiesce().unwrap();
        let ops = m.operations.borrow();
        let op = &ops[0];
        assert_eq!(op.delivery()["state"], "discarded");
        assert!(op.acquisition_committed);
        let a = m
            .store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap();
        assert_eq!(a.disposition.as_deref(), Some("acquired"));
        assert_eq!(
            m.store()
                .job_for_operation(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap()
                .state,
            JobState::Completed
        );
        m.assert_custody_clean(op, false).unwrap();
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
        assert!(m.store().claims().unwrap().is_empty());
    }
}

#[test]
fn model_acquisition_winner_survives_losing_discard_observation_and_collection_crashes() {
    for loss in [false, true] {
        for point in 0..3 {
            let mut m = Machine::new();
            for command in [
                Command::Admit(0, true),
                Command::ProviderComplete(0),
                Command::Acquire(0),
            ] {
                m.apply(command).unwrap();
            }
            if point == 2 {
                m.apply(Command::ProviderDiscard(0, false)).unwrap();
            }
            m.apply(Command::DiscardCrash(0, point, loss)).unwrap();
            m.quiesce().unwrap();
            let ops = m.operations.borrow();
            let op = &ops[0];
            assert!(op.provider_discarded);
            assert_eq!(op.delivery()["state"], "discarded");
            assert_eq!(
                m.store()
                    .get(&op.consumer.package_id, &op.id)
                    .unwrap()
                    .unwrap()
                    .disposition
                    .as_deref(),
                Some("acquired")
            );
            m.assert_custody_clean(op, false).unwrap();
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
            assert!(m.store().claims().unwrap().is_empty());
        }
    }
}

#[test]
fn model_legacy_conflicting_discard_receipt_and_acquisition_evidence_converge() {
    use sha2::{Digest, Sha256};
    for revision in [0, 1, 2] {
        let mut m = Machine::new();
        for command in [
            Command::Admit(0, true),
            Command::ProviderComplete(0),
            Command::Acquire(0),
        ] {
            m.apply(command).unwrap();
        }
        {
            let mut ops = m.operations.borrow_mut();
            let op = &mut ops[0];
            op.provider_discarded = true;
            let status = op.receipt(op.delivery());
            let a = m
                .store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            let validated = crate::service_state::receipt::validate(&status, &a).unwrap();
            let raw = serde_json::to_string(&validated).unwrap();
            // Seed exactly the pre-fix contradictory durable state; current
            // transactions can no longer create it. Integrity remains valid.
            let conn = rusqlite::Connection::open(
                m.fixture.profile.path().join("service-state/ledger.sqlite"),
            )
            .unwrap();
            conn.execute("UPDATE provider_receipts SET status=?3,revision=?4,digest=?5 WHERE consumer=?1 AND operation=?2", rusqlite::params![op.consumer.package_id, op.id, raw, status["revision"].as_u64().unwrap() as i64, hex::encode(Sha256::digest(raw.as_bytes()))]).unwrap();
            let mut incoming = status.clone();
            incoming["revision"] = json!(status["revision"].as_u64().unwrap() - 1 + revision);
            service_bridge::reconcile_at(m.store(), &op.provider, &a, &incoming).unwrap();
            let current = m
                .store()
                .provider_receipt(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            let mut conflict = status;
            conflict["revision"] = current["revision"].clone();
            conflict["execution"]["metadata"]["adapter"] = json!("different-provider-metadata");
            assert!(m
                .store()
                .observe_receipt(
                    &op.provider,
                    &op.consumer.package_id,
                    &op.id,
                    conflict["revision"].as_u64().unwrap(),
                    conflict.clone()
                )
                .is_err());
            conflict["revision"] = json!(conflict["revision"].as_u64().unwrap() + 1);
            assert!(m
                .store()
                .observe_receipt(
                    &op.provider,
                    &op.consumer.package_id,
                    &op.id,
                    conflict["revision"].as_u64().unwrap(),
                    conflict
                )
                .is_err());
            assert_eq!(
                m.store()
                    .provider_receipt(&op.consumer.package_id, &op.id)
                    .unwrap()
                    .unwrap(),
                current
            );
        }
        m.quiesce().unwrap();
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
        assert!(m.store().claims().unwrap().is_empty());
    }
}

#[test]
fn model_recapture_crash_after_other_preparation_adopts_replacement_generation() {
    let mut m = Machine::new();
    for command in [
        Command::SharedConsumerAdmit,
        Command::Admit(1, true),
        Command::CompatibleUpgradeCrash(false, 5, false),
        Command::Admit(0, false),
        Command::RecaptureCrash(1),
    ] {
        m.apply(command).unwrap();
    }
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_acquired_receipt_restart_sweep_releases_through_reconciliation() {
    let mut m = Machine::new();
    for command in [
        Command::Admit(0, false),
        Command::ProviderComplete(0),
        Command::Acquire(0),
        Command::AcquiredReceipt(0),
        Command::Restart,
    ] {
        m.apply(command).unwrap();
    }
    {
        let ops = m.operations.borrow();
        let op = &ops[0];
        let a = m
            .store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap();
        assert_eq!(a.phase, AdmissionPhase::Terminal);
        assert!(op.provider_acknowledged);
        assert!(!op.host_released);
        assert_eq!(
            m.store()
                .provider_receipt(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap()["delivery"]["state"],
            "acquired"
        );
        assert!(!m.store().claims().unwrap().is_empty());
    }
    m.apply(Command::Sweep).unwrap();
    m.quiesce().unwrap();
    let ops = m.operations.borrow();
    let op = &ops[0];
    assert_eq!(
        m.store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap()
            .disposition
            .as_deref(),
        Some("acquired")
    );
    assert_eq!(
        m.store()
            .job_for_operation(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap()
            .state,
        JobState::Completed
    );
    m.assert_custody_clean(op, false).unwrap();
    assert_eq!(m.charges(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_legacy_discard_reply_retries_after_host_precommit_crash() {
    let mut m = Machine::new();
    for command in [
        Command::SharedConsumerAdmit,
        Command::ProviderComplete(0),
        Command::DiscardCrash(0, 0, false),
    ] {
        m.apply(command).unwrap();
    }
    assert!(m.operations.borrow()[0].provider_discarded);
    assert!(!m.operations.borrow()[0].discard_committed);
    m.apply(Command::Sweep).unwrap();
    assert!(m.operations.borrow()[0].discard_committed);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_replacement_collision_does_not_require_rejected_raw_reply() {
    for outcome in [2, 3] {
        let mut m = Machine::new();
        m.admit(0, false).unwrap();
        for command in [
            Command::Admit(1, false),
            Command::Publish(1, outcome, true),
            Command::Spool(1),
            Command::Seal(0),
            Command::DelayedReceipt(0, false),
            Command::Seal(0),
            Command::Upgrade(true, true, false),
            Command::Probe(true),
        ] {
            m.apply(command).unwrap();
        }
        m.apply(Command::Gc).unwrap();
        {
            let ops = m.operations.borrow();
            let op = &ops[m.index(1).unwrap()];
            assert!(op.captured_process_reply);
            assert!(!op.paid_success);
            assert!(!op.valid_original);
            let a = m
                .store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            assert_eq!(a.phase, AdmissionPhase::Released);
            assert_eq!(a.disposition.as_deref(), Some("discarded"));
            m.assert_custody_clean(op, false).unwrap();
        }
        m.apply(Command::ReplacementCollision(1)).unwrap();
        {
            let ops = m.operations.borrow();
            m.assert_custody_clean(&ops[m.index(1).unwrap()], false)
                .unwrap();
        }
        m.quiesce().unwrap();
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
        assert!(m.store().claims().unwrap().is_empty());
    }
}

#[test]
fn model_discard_reply_replay_after_host_precommit_crash_records_commitment() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::Admit(0, false),
        Command::PausedProviderMutation(1, 0, 0),
        Command::ProviderComplete(0),
        Command::DiscardCrash(0, 0, false),
    ] {
        m.apply(command).unwrap();
    }
    let index = m.index(0).unwrap();
    assert!(m.operations.borrow()[index].provider_discarded);
    assert!(!m.operations.borrow()[index].discard_committed);
    m.apply(Command::Replay(0)).unwrap();
    assert!(m.operations.borrow()[index].discard_committed);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_provider_completion_cannot_publish_success_before_seal_identity() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::SharedConsumerAdmit,
        Command::Admit(0, false),
        Command::DirectorySyncFailure(true),
        Command::Stage(2, false, false),
        Command::ProviderComplete(2),
    ] {
        m.apply(command).unwrap();
    }
    let index = m.index(2).unwrap();
    {
        let ops = m.operations.borrow();
        let op = &ops[index];
        assert!(op.descriptor.is_none());
        assert!(!op.completion_identified && !op.sealed_original);
        assert_ne!(
            m.store()
                .provider_receipt(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap()["execution"]["state"],
            "succeeded"
        );
    }
    m.apply(Command::PowerLoss).unwrap();
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_paused_acquisition_reuses_durable_consumer_intent() {
    let mut m = Machine::new();
    m.admit(0, false).unwrap();
    for command in [
        Command::Admit(0, false),
        Command::ProviderComplete(0),
        Command::CopyBeforeProof(0),
    ] {
        m.apply(command).unwrap();
    }
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
    m.apply(Command::PausedMutation(0, 1, 0)).unwrap();
    assert_eq!(m.operations.borrow()[0].delivery_effects.get(), 1);
    m.quiesce().unwrap();
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
}

#[test]
fn model_legacy_acquired_completion_repair_is_atomic_and_rejects_invalid_proof() {
    use sha2::{Digest, Sha256};
    let mut m = Machine::new();
    for command in [
        Command::Admit(0, true),
        Command::ProviderComplete(0),
        Command::Acquire(0),
    ] {
        m.apply(command).unwrap();
    }
    let ops = m.operations.borrow();
    let op = &ops[0];
    let conn =
        rusqlite::Connection::open(m.fixture.profile.path().join("service-state/ledger.sqlite"))
            .unwrap();
    let mut a = m
        .store()
        .get(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    a.phase = AdmissionPhase::Released;
    a.disposition = Some("discarded".into());
    let status = op.receipt(json!({"state":"discarded"}));
    let raw = serde_json::to_string(&crate::service_state::receipt::validate(&status, &a).unwrap())
        .unwrap();
    conn.execute(
        "UPDATE operations SET phase='released',admission=?3 WHERE consumer=?1 AND operation=?2",
        rusqlite::params![
            op.consumer.package_id,
            op.id,
            serde_json::to_string(&a).unwrap()
        ],
    )
    .unwrap();
    conn.execute("UPDATE provider_receipts SET status=?3,revision=?4,digest=?5 WHERE consumer=?1 AND operation=?2", rusqlite::params![op.consumer.package_id,op.id,raw,status["revision"].as_u64().unwrap() as i64,hex::encode(Sha256::digest(raw.as_bytes()))]).unwrap();
    let before = m
        .store()
        .job_for_operation(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    let inventory = || {
        conn.query_row("SELECT group_concat(handle || ':' || status || ':' || bytes, ',') FROM artifacts WHERE consumer=?1 AND operation=?2", rusqlite::params![op.consumer.package_id,op.id], |r| r.get::<_,String>(0)).unwrap()
    };
    let charged = inventory();
    let unchanged = || {
        assert_eq!(
            m.store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap(),
            a
        );
        assert_eq!(
            m.store()
                .provider_receipt(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap(),
            serde_json::from_str::<Value>(&raw).unwrap()
        );
        assert_eq!(m.store().job(&before.job_key).unwrap().unwrap(), before);
        assert_eq!(inventory(), charged);
    };
    conn.execute_batch("CREATE TRIGGER fail_completion BEFORE UPDATE ON presentation_jobs BEGIN SELECT RAISE(ABORT,'injected presentation commit failure'); END;").unwrap();
    assert!(m
        .store()
        .complete_acquired_job(&op.consumer.package_id, &op.id)
        .is_err());
    unchanged();
    conn.execute_batch("DROP TRIGGER fail_completion").unwrap();
    let descriptor = op.descriptor.as_ref().unwrap();
    let mut corrupt = descriptor.clone();
    corrupt.sha256 = "0".repeat(64);
    conn.execute(
        "UPDATE evidence SET descriptor=?3 WHERE consumer=?1 AND operation=?2",
        rusqlite::params![
            op.consumer.package_id,
            op.id,
            serde_json::to_string(&corrupt).unwrap()
        ],
    )
    .unwrap();
    assert!(m
        .store()
        .complete_acquired_job(&op.consumer.package_id, &op.id)
        .is_err());
    unchanged();
    conn.execute(
        "UPDATE evidence SET descriptor=?3 WHERE consumer=?1 AND operation=?2",
        rusqlite::params![
            op.consumer.package_id,
            op.id,
            serde_json::to_string(descriptor).unwrap()
        ],
    )
    .unwrap();
    let done = m
        .store()
        .complete_acquired_job(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(done.state, JobState::Completed);
    assert_eq!(done.output_path.as_deref(), op.copy.to_str());
    assert_eq!(done.run_id, before.run_id);
    assert_eq!(
        m.store()
            .get(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap()
            .transfer_receipt,
        op.transfer
    );
    assert_eq!(
        m.store()
            .provider_receipt(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap()["revision"],
        status["revision"]
    );
    assert!(m
        .store()
        .complete_acquired_job(&op.consumer.package_id, &op.id)
        .unwrap()
        .is_none());
    m.store().gc().unwrap();
    m.assert_custody_clean(op, false).unwrap();
    assert_eq!(m.charges(), 0);
}

// Committed delivery must repair without provider RPC. Pending Terminal
// ledgers still exercise production receipt reconciliation and original resume.
struct LegacyLedgerPort<'a> {
    machine: &'a Machine,
    recovery_calls: Cell<usize>,
}

#[test]
fn model_discarded_acquisition_attempts_have_no_effect_or_leaked_fault() {
    for power_loss in [false, true] {
        for point in 0..3 {
            let mut m = Machine::new();
            for command in [
                Command::Admit(1, false),
                Command::Admit(0, false),
                Command::ProviderComplete(1),
                Command::DiscardCrash(1, 0, power_loss),
                Command::Sweep,
                Command::AggregateCrash(1, 3, point, power_loss),
                Command::CopyBeforeProof(1),
                Command::Probe(false),
            ] {
                m.apply(command).unwrap();
            }
            for action in 0..4 {
                m.apply(Command::PausedMutation(1, 1, action)).unwrap();
            }
            // A forbidden transition must not leave its fault armed for a
            // different operation's real, eligible production acquisition.
            for command in [
                Command::ProviderComplete(0),
                Command::Acquire(0),
                Command::Ack(0, false),
            ] {
                m.apply(command).unwrap();
            }
            m.quiesce().unwrap();
            let ops = m.operations.borrow();
            let discarded = &ops[m.index(1).unwrap()];
            let a = m
                .store()
                .get(&discarded.consumer.package_id, &discarded.id)
                .unwrap()
                .unwrap();
            assert_eq!(a.phase, AdmissionPhase::Released);
            assert_eq!(a.disposition.as_deref(), Some("discarded"));
            let job = m
                .store()
                .job_for_operation(&discarded.consumer.package_id, &discarded.id)
                .unwrap()
                .unwrap();
            assert_eq!(job.state, JobState::Discarded);
            assert!(job.output_path.is_none());
            assert!(!discarded.copy.exists());
            assert_eq!(discarded.delivery_effects.get(), 0);
            assert_eq!(ops[m.index(0).unwrap()].delivery_effects.get(), 1);
            assert!(!m.store().busy(&discarded.consumer.package_id).unwrap());
            assert!(!m.store().busy(&discarded.provider.package_id).unwrap());
            assert!(m.store().claims().unwrap().is_empty());
            assert!(m.store().auto_settlement_operations().unwrap().is_empty());
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
        }
    }
}

#[test]
fn model_released_preparation_replay_uses_compatible_provider_authority() {
    for provider in [false, true] {
        for power_loss in [false, true] {
            let mut m = Machine::new();
            for command in [
                Command::Register(1),
                Command::ReleasePreparationCrash(1, false),
                Command::CompatibleUpgradeCrash(provider, 5, power_loss),
                Command::Capture(1),
                Command::Dispatch(1),
            ] {
                m.apply(command).unwrap();
            }
            m.quiesce().unwrap();
            let ops = m.operations.borrow();
            let op = &ops[m.index(1).unwrap()];
            let a = m
                .store()
                .get(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            assert_eq!(a.phase, AdmissionPhase::Released);
            assert_eq!(a.disposition.as_deref(), Some("never_forwarded"));
            let upgraded = m
                .generation(if provider {
                    Role::Provider
                } else {
                    Role::Consumer
                })
                .unwrap();
            assert_ne!(
                upgraded.digest,
                if provider {
                    a.provider.digest.clone()
                } else {
                    a.consumer.digest.clone()
                },
                "the tested package must actually have been replaced"
            );
            assert!(op.captured_inputs.is_empty());
            assert!(!m
                .fixture
                .profile
                .path()
                .join(format!("{}-input.png", op.id))
                .exists());
            let job = m
                .store()
                .job_for_operation(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            assert_eq!(job.state, JobState::Discarded);
            assert!(!m.store().busy(&op.consumer.package_id).unwrap());
            assert!(!m.store().busy(&op.provider.package_id).unwrap());
            assert!(m.store().auto_settlement_operations().unwrap().is_empty());
            assert!(m.store().claims().unwrap().is_empty());
            assert_eq!(op.starts.get(), 0);
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
        }
    }
}

#[test]
fn model_authoritative_success_survives_unsealed_stage_loss() {
    let mut m = Machine::new();
    for command in [
        Command::SharedConsumerAdmit,
        Command::Publish(2, 0, false),
        Command::Stage(2, true, false),
        Command::Gc,
        Command::PowerLoss,
    ] {
        m.apply(command).unwrap();
    }
    let index = m.index(2).unwrap();
    {
        let ops = m.operations.borrow();
        let op = &ops[index];
        assert!(!op.valid_original, "volatile stage bytes must be lost");
        assert_eq!(
            op.outcome,
            Outcome::Succeeded,
            "durable provider execution must survive lost host bytes"
        );
    }
    m.quiesce().unwrap();
    let ops = m.operations.borrow();
    let op = &ops[index];
    let job = m
        .store()
        .job_for_operation(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(job.state, JobState::Error);
    assert_eq!(job.phase.as_deref(), Some("delivery_failed"));
    assert!(job.output_path.is_none());
    let a = m
        .store()
        .get(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AdmissionPhase::Terminal);
    assert_eq!(
        a.disposition, None,
        "missing success must not become an automatic discard"
    );
    let receipt = m
        .store()
        .provider_receipt(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt["execution"]["state"], "succeeded");
    assert_eq!(receipt["delivery"]["state"], "unavailable");
    assert!(!m.store().busy(&op.consumer.package_id).unwrap());
    assert!(!m.store().busy(&op.provider.package_id).unwrap());
    assert!(m.store().claims().unwrap().is_empty());
    assert_eq!(op.starts.get(), 1);
    assert_eq!(op.recovery_native_starts.get(), 0);
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
}

#[test]
fn model_interrupted_release_converges_through_quiescence() {
    for power_loss in [false, true] {
        let mut m = Machine::new();
        m.apply(Command::Register(0)).unwrap();
        m.apply(Command::Capture(0)).unwrap();
        m.apply(Command::ReleasePreparationCrash(0, power_loss))
            .unwrap();
        // A successful status-only replay must not invent a paid dispatch.
        m.apply(Command::Dispatch(0)).unwrap();
        // A reservation tombstone does not give the synthetic provider an
        // execution: these commands have unmet provider-visible preconditions.
        m.apply(Command::Stage(0, true, true)).unwrap();
        m.apply(Command::Publish(0, 0, false)).unwrap();
        m.quiesce().unwrap();
        let ops = m.operations.borrow();
        let op = &ops[0];
        let job = m
            .store()
            .job_for_operation(&op.consumer.package_id, &op.id)
            .unwrap()
            .unwrap();
        assert_eq!(job.state, JobState::Discarded);
        assert!(!m.store().busy(&op.consumer.package_id).unwrap());
        assert!(m.store().auto_settlement_operations().unwrap().is_empty());
        assert_eq!(op.starts.get(), 0);
        assert!(m.store().claims().unwrap().is_empty());
        assert_eq!(m.charges(), 0);
        assert_eq!(m.disk_bytes(), 0);
        for _ in 0..3 {
            assert!(ai_operations::auto_reconcile_in(
                m.store(),
                &LegacyLedgerPort {
                    machine: &m,
                    recovery_calls: Cell::new(0)
                }
            )
            .unwrap()
            .is_empty());
            assert_eq!(
                m.store().job(&job.job_key).unwrap().unwrap().revision,
                job.revision
            );
        }
    }
}

#[test]
fn model_never_forwarded_interrupted_release_settles_silently() {
    for power_loss in [false, true] {
        for startup_cleanup in [false, true] {
            let mut m = Machine::new();
            m.apply(Command::Register(0)).unwrap();
            m.apply(Command::Capture(0)).unwrap();
            if startup_cleanup {
                {
                    let ops = m.operations.borrow();
                    m.reserve_preparation(&ops[0]).unwrap();
                }
                m.restart(power_loss).unwrap();
                let ops = m.operations.borrow();
                assert_eq!(m.store().release_preparations(&ops[0].consumer).unwrap(), 1);
            } else {
                m.apply(Command::ReleasePreparationCrash(0, power_loss))
                    .unwrap();
            }
            let ops = m.operations.borrow();
            let op = &ops[0];
            let before = m
                .store()
                .job_for_operation(&op.consumer.package_id, &op.id)
                .unwrap()
                .unwrap();
            assert_eq!(before.state, JobState::Accepting);
            assert!(m.store().busy(&op.consumer.package_id).unwrap());
            let port = LegacyLedgerPort {
                machine: &m,
                recovery_calls: Cell::new(0),
            };
            let settled = ai_operations::auto_reconcile_in(m.store(), &port).unwrap();
            let job = m.store().job(&before.job_key).unwrap().unwrap();
            assert!(
                job.state.terminal(),
                "released intent must finish its presentation: {job:?}"
            );
            assert_eq!(settled, vec![job.clone()]);
            assert_eq!(job.state, JobState::Discarded);
            assert!(job.output_path.is_none());
            assert!(!m.store().busy(&op.consumer.package_id).unwrap());
            assert!(!m.store().busy(&op.provider.package_id).unwrap());
            assert_eq!(op.starts.get(), 0);
            assert_eq!(port.recovery_calls.get(), 0);
            m.assert_custody_clean(op, false).unwrap();
            assert_eq!(m.charges(), 0);
            assert_eq!(m.disk_bytes(), 0);
            for _ in 0..3 {
                assert!(ai_operations::auto_reconcile_in(m.store(), &port)
                    .unwrap()
                    .is_empty());
                assert_eq!(
                    m.store().job(&job.job_key).unwrap().unwrap().revision,
                    job.revision
                );
                assert!(m.store().auto_settlement_operations().unwrap().is_empty());
            }
        }
    }
}

#[test]
fn model_release_during_idle_probe_finishes_presentation() {
    struct ReleaseDuringProbe<'a>(&'a Store);
    impl ai_operations::AutomaticPort for ReleaseDuringProbe<'_> {
        fn active(
            &self,
            a: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            self.0.release_unaccepted(&a.consumer, &a.operation_id)?;
            Ok(false)
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            panic!("never-forwarded work must not recover provider execution")
        }
    }
    let mut m = Machine::new();
    m.apply(Command::Register(0)).unwrap();
    m.apply(Command::Capture(0)).unwrap();
    let ops = m.operations.borrow();
    let op = &ops[0];
    m.reserve_preparation(op).unwrap();
    let port = ReleaseDuringProbe(m.store());
    let settled = ai_operations::auto_reconcile_in(m.store(), &port).unwrap();
    let job = m
        .store()
        .job_for_operation(&op.consumer.package_id, &op.id)
        .unwrap()
        .unwrap();
    assert!(
        job.state.terminal(),
        "release during idle probe must finish: {job:?}"
    );
    assert_eq!(settled, vec![job.clone()]);
    assert_eq!(job.state, JobState::Discarded);
    assert!(job.output_path.is_none());
    assert!(!m.store().busy(&op.consumer.package_id).unwrap());
    assert!(!m.store().busy(&op.provider.package_id).unwrap());
    assert_eq!(m.charges(), 0);
    assert_eq!(m.disk_bytes(), 0);
    assert!(m.store().claims().unwrap().is_empty());
    for _ in 0..3 {
        assert!(ai_operations::auto_reconcile_in(m.store(), &port)
            .unwrap()
            .is_empty());
        assert_eq!(
            m.store().job(&job.job_key).unwrap().unwrap().revision,
            job.revision
        );
        assert!(m.store().auto_settlement_operations().unwrap().is_empty());
    }
}
impl ai_operations::AutomaticPort for LegacyLedgerPort<'_> {
    fn active(
        &self,
        a: &Admission,
        job: Option<&JobRecord>,
        stopped: bool,
        execution: &str,
    ) -> Result<bool, AppError> {
        if self
            .machine
            .operations
            .borrow()
            .iter()
            .any(|op| op.id == a.operation_id && (op.acquisition_committed || op.discard_committed))
        {
            panic!("committed delivery repair must not depend on provider activity/status RPC")
        } else if a.phase == AdmissionPhase::Released {
            // Never-forwarded work has no provider execution to query.
            Ok(false)
        } else {
            Transport {
                machine: self.machine,
            }
            .active(a, job, stopped, execution)
        }
    }
    fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
        self.recovery_calls.set(self.recovery_calls.get() + 1);
        if a.phase == AdmissionPhase::Released {
            Err(AppError::Other(
                "Legacy provider cannot answer status".into(),
            ))
        } else {
            Transport {
                machine: self.machine,
            }
            .recover(a, job)
        }
    }
}

#[test]
fn model_legacy_terminal_and_released_ledger_shapes_converge() {
    use sha2::{Digest, Sha256};
    // Every writable disposition from persisted(), including startup cleanup
    // and interrupted cancellation of an intent that was never forwarded.
    let admissions = ["terminal", "discarded", "acquired", "never_forwarded"];
    let receipts = [
        "discarded",
        "acquired",
        "absent",
        "available",
        "unavailable",
        "running",
        "unknown",
    ];
    // Presentation writes in origin/dev bounded phase/error text but did not
    // couple terminal state to delivery proof. Include null phases and both
    // error-bearing/errorless failure history, not only host stop phases.
    let jobs = [
        (JobState::NeedsAttention, Some("stopped"), false),
        (JobState::Accepting, Some("accepting"), false),
        (JobState::Running, Some("running"), false),
        (JobState::Recovering, Some("recovering"), false),
        (
            JobState::NeedsAttention,
            Some("provider_result_discarded"),
            false,
        ),
        (JobState::Discarded, Some("stopped"), false),
        (JobState::Error, Some("stopped"), true),
        (JobState::Error, Some("delivery_failed"), true),
        (JobState::Error, Some("storage_full"), true),
        (JobState::Error, Some("failed"), false),
        (JobState::Error, Some("failed"), true),
        (JobState::Cancelled, Some("consumer_removed"), false),
        (JobState::Cancelled, Some("cancelled"), false),
        (JobState::Discarded, Some("discarded"), false),
        (JobState::Completed, Some("complete"), false),
        (JobState::Accepting, None, false),
        (JobState::Running, None, false),
        (JobState::Recovering, None, false),
        (JobState::NeedsAttention, None, false),
        (JobState::Error, None, false),
        (JobState::Error, None, true),
        (JobState::Cancelled, None, false),
        (JobState::Discarded, None, false),
        (JobState::Completed, None, false),
    ];
    let mut failures = Vec::new();
    let mut cases = 0;
    for admission in admissions {
        for receipt in receipts {
            for proof in [true, false] {
                // release_preparations/release_unaccepted write this from a
                // Reserved admission before any receipt, output or acquisition.
                if admission == "never_forwarded" && (proof || receipt != "absent") {
                    continue;
                }
                // Acquired receipts and acquired releases require a committed
                // matching evidence row in both historical implementations.
                if !proof && (receipt == "acquired" || admission == "acquired") {
                    continue;
                }
                for ((state, phase, has_error), execution_released) in jobs
                    .into_iter()
                    .flat_map(|job| [false, true].map(|flag| (job, flag)))
                {
                    cases += 1;
                    let case = format!("{admission}/{receipt}/proof={proof}/{state:?}/{phase:?}/error={has_error}/execution_released={execution_released}");
                    let mut m = Machine::new();
                    if admission == "never_forwarded" {
                        m.apply(Command::Register(0)).unwrap();
                        m.apply(Command::Capture(0)).unwrap();
                        let ops = m.operations.borrow();
                        m.reserve_preparation(&ops[0]).unwrap();
                        m.store().release_preparations(&ops[0].consumer).unwrap();
                    } else {
                        m.apply(Command::Admit(0, true)).unwrap();
                        m.apply(Command::ProviderComplete(0)).unwrap();
                    }
                    if proof {
                        m.apply(Command::Acquire(0)).unwrap();
                    }
                    {
                        let mut ops = m.operations.borrow_mut();
                        let op = &mut ops[0];
                        // Host job APIs also allowed independently reported
                        // completion before acquisition. Preserve that history
                        // and real consumer output if no delivery proof exists.
                        if state == JobState::Completed && !proof {
                            if admission == "never_forwarded" {
                                fs::write(&op.copy, &op.original).unwrap();
                            } else {
                                let descriptor = op.descriptor.clone().unwrap();
                                m.consumer_copy(op, &descriptor).unwrap();
                            }
                        }
                        let mut a = m
                            .store()
                            .get(&op.consumer.package_id, &op.id)
                            .unwrap()
                            .unwrap();
                        if admission != "terminal" {
                            a.phase = AdmissionPhase::Released;
                            a.disposition = Some(admission.into());
                            a.transfer_receipt =
                                (admission == "acquired").then(|| op.transfer.clone().unwrap());
                        }
                        let conn = rusqlite::Connection::open(
                            m.fixture.profile.path().join("service-state/ledger.sqlite"),
                        )
                        .unwrap();
                        conn.execute("UPDATE operations SET phase=?3,admission=?4,exec_released=?5 WHERE consumer=?1 AND operation=?2", rusqlite::params![op.consumer.package_id, op.id, if admission == "terminal" { "terminal" } else { "released" }, serde_json::to_string(&a).unwrap(), execution_released]).unwrap();
                        let delivery = match receipt {
                            "discarded" => json!({"state":"discarded"}),
                            "acquired" => json!({"state":"acquired","transferReceipt":op.transfer}),
                            "unavailable" => json!({"state":"unavailable","reason":"missing"}),
                            "running" | "unknown" => json!({"state":"none"}),
                            _ => json!({"state":"available","output":op.descriptor}),
                        };
                        let outcome = op.outcome;
                        op.outcome = match receipt {
                            "running" => Outcome::Running,
                            "unknown" => Outcome::Unknown,
                            _ => outcome,
                        };
                        let status = op.receipt(delivery);
                        op.outcome = outcome;
                        if receipt == "absent" {
                            conn.execute(
                                "DELETE FROM provider_receipts WHERE consumer=?1 AND operation=?2",
                                rusqlite::params![op.consumer.package_id, op.id],
                            )
                            .unwrap();
                        } else {
                            let status =
                                crate::service_state::receipt::validate(&status, &a).unwrap();
                            let raw = serde_json::to_string(&status).unwrap();
                            conn.execute("UPDATE provider_receipts SET status=?3,revision=?4,digest=?5 WHERE consumer=?1 AND operation=?2", rusqlite::params![op.consumer.package_id, op.id, raw, status["revision"].as_u64().unwrap() as i64, hex::encode(Sha256::digest(raw.as_bytes()))]).unwrap();
                        }
                        op.provider_discarded = receipt == "discarded";
                        op.provider_acknowledged = receipt == "acquired";
                        op.discard_committed =
                            !proof && (receipt == "discarded" || admission == "discarded");
                        let mut job = m
                            .store()
                            .job_for_operation(&op.consumer.package_id, &op.id)
                            .unwrap()
                            .unwrap();
                        job.state = state;
                        job.phase = phase.map(str::to_owned);
                        job.error = has_error.then(|| "Historical delivery error".into());
                        job.output_path = (state == JobState::Completed)
                            .then(|| op.copy.to_string_lossy().into_owned());
                        job.settled_at_ms = (state.terminal() || state == JobState::NeedsAttention)
                            .then_some(job.updated_at_ms);
                        conn.execute(
                            "UPDATE presentation_jobs SET record=?2 WHERE key=?1",
                            rusqlite::params![job.job_key, serde_json::to_string(&job).unwrap()],
                        )
                        .unwrap();
                    }
                    m.restart(false).unwrap();
                    let port = LegacyLedgerPort {
                        machine: &m,
                        recovery_calls: Cell::new(0),
                    };
                    let result = (|| -> Result<(), String> {
                        // Other tests' lifecycle work is not simulated provider
                        // latency. Own the shared action lane before the sweeps
                        // start their bounded reconciliation clocks.
                        let _action = ai_operations::action_guard().map_err(|e| e.to_string())?;
                        for _ in 0..3 {
                            ai_operations::auto_reconcile_in(m.store(), &port)
                                .map_err(|e| e.to_string())?;
                        }
                        let ops = m.operations.borrow();
                        let op = &ops[0];
                        let a = m
                            .store()
                            .get(&op.consumer.package_id, &op.id)
                            .unwrap()
                            .unwrap();
                        let job = m
                            .store()
                            .job_for_operation(&op.consumer.package_id, &op.id)
                            .unwrap()
                            .unwrap();
                        let acquired = proof || admission == "terminal" && receipt != "discarded";
                        if a.phase != AdmissionPhase::Released
                            || a.disposition.as_deref()
                                != Some(if acquired {
                                    "acquired"
                                } else if admission == "never_forwarded" {
                                    "never_forwarded"
                                } else {
                                    "discarded"
                                })
                            || !job.state.terminal()
                        {
                            return Err(format!("unsettled: admission={a:?}, job={job:?}"));
                        }
                        if acquired
                            && (job.state != JobState::Completed
                                || job.output_path.as_deref() != op.copy.to_str()
                                || fs::read(&op.copy).ok().as_ref() != Some(&op.original))
                        {
                            return Err(format!("incorrect acquired presentation: {job:?}"));
                        }
                        if !acquired {
                            if admission == "never_forwarded"
                                && !state.terminal()
                                && job.state != JobState::Discarded
                            {
                                return Err(format!(
                                    "never-forwarded work was not settled silently: {job:?}"
                                ));
                            }
                            if state == JobState::Completed {
                                if job.state != JobState::Completed
                                    || job.output_path.as_deref() != op.copy.to_str()
                                    || job.error.is_some()
                                    || fs::read(&op.copy).ok().as_ref() != Some(&op.original)
                                {
                                    return Err(format!("reported completion regressed: {job:?}"));
                                }
                            } else if job.state == JobState::Completed || job.output_path.is_some()
                            {
                                return Err(format!("discard shown as delivered: {job:?}"));
                            }
                        }
                        let historical_execution = proof
                            && matches!(receipt, "running" | "unknown")
                            || admission != "terminal" && matches!(receipt, "running" | "unknown");
                        if historical_execution
                            && m.store()
                                .provider_receipt(&op.consumer.package_id, &op.id)
                                .unwrap()
                                .unwrap()["execution"]["state"]
                                != receipt
                        {
                            return Err("historical execution metadata was changed".into());
                        }
                        if acquired
                            && receipt != "absent"
                            && !historical_execution
                            && m.store()
                                .provider_receipt(&op.consumer.package_id, &op.id)
                                .unwrap()
                                .unwrap()["delivery"]["state"]
                                != "acquired"
                        {
                            return Err("provider receipt was not repaired".into());
                        }
                        if acquired && a.transfer_receipt.is_none() {
                            return Err("acquired tombstone lacks verified receipt".into());
                        }
                        m.assert_custody_clean(op, false)
                            .map_err(|e| e.to_string())?;
                        if m.charges() != 0
                            || m.disk_bytes() != 0
                            || !m.store().claims().unwrap().is_empty()
                            || m.store().busy(&op.consumer.package_id).unwrap()
                            || m.store().busy(&op.provider.package_id).unwrap()
                        {
                            return Err("custody/charges/capacity held".into());
                        }
                        let calls = port.recovery_calls.get();
                        let revision = job.revision;
                        for _ in 0..3 {
                            ai_operations::auto_reconcile_in(m.store(), &port)
                                .map_err(|e| e.to_string())?;
                        }
                        if calls != port.recovery_calls.get()
                            || m.store().job(&job.job_key).unwrap().unwrap().revision != revision
                            || !m.store().auto_settlement_operations().unwrap().is_empty()
                        {
                            return Err("settled ledger retries forever".into());
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        failures.push(format!("{case}: {error}"));
                    }
                }
            }
        }
    }
    eprintln!(
        "legacy ledger convergence: {cases} reachable cases, {} failures",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
