//! Reference-state-machine exploration over production Store, image_call,
//! automatic reconciliation and lifecycle mutations. Only native preflight and
//! provider transport are fake. Paid outcomes and original bytes are oracle
//! state, independent of host receipts; delivery is checked by reading bytes.
use super::{Fixture, Role};
use crate::{
    error::AppError,
    installed_plugins::{ai_operations, backend, package, service_bridge},
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
    Stage(u8, bool, bool),
    RecoveryWriterGc(u8),
    CrashMidWrite(u8),
    Seal(u8),
    ProviderComplete(u8),
    Publish(u8, u8, bool),
    Spool(u8),
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
}
impl Command {
    fn family(&self) -> &'static str {
        match self {
            Self::Admit(..) => "admit",
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
        }
    }
}
fn commands(max_steps: usize) -> impl Strategy<Value = Vec<Command>> {
    let slot = 0u8..SLOTS as u8;
    proptest::collection::vec(
        prop_oneof![
            5 => (slot.clone(), any::<bool>()).prop_map(|(s,i)| Command::Admit(s,i)),
            6 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,c,d)| Command::Stage(s,c,d)),
            2 => slot.clone().prop_map(Command::RecoveryWriterGc),
            2 => slot.clone().prop_map(Command::CrashMidWrite),
            4 => slot.clone().prop_map(Command::Seal),
            4 => slot.clone().prop_map(Command::ProviderComplete),
            6 => (slot.clone(), 0u8..4, any::<bool>()).prop_map(|(s,o,f)| Command::Publish(s,o,f)),
            2 => slot.clone().prop_map(Command::Spool), 3 => any::<bool>().prop_map(Command::Probe),
            3 => (slot.clone(), any::<bool>(), any::<bool>()).prop_map(|(s,p,a)| Command::WorkerActive(s,p,a)),
            3 => slot.clone().prop_map(Command::Acquire),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,c)| Command::Ack(s,c)),
            3 => (slot.clone(), any::<bool>()).prop_map(|(s,c)| Command::ConsumerReceive(s,c)),
            2 => slot.prop_map(Command::Replay),
            4 => (any::<bool>(),any::<bool>(),any::<bool>()).prop_map(|(r,c,q)| Command::Upgrade(r,c,q)),
            3 => (any::<bool>(),any::<bool>()).prop_map(|(r,e)| Command::Enable(r,e)),
            1 => any::<bool>().prop_map(Command::Uninstall), 5 => Just(Command::Sweep), 2 => Just(Command::Gc),
            2 => any::<bool>().prop_map(Command::UnlinkFailure),
            2 => any::<bool>().prop_map(Command::DirectorySyncFailure),
            3 => Just(Command::Restart), 3 => Just(Command::PowerLoss),
        ],
        1..=max_steps,
    )
}
#[derive(Debug)]
struct Operation {
    id: String,
    consumer: PackageGeneration,
    provider: PackageGeneration,
    outcome: Outcome,
    paid_success: bool,
    valid_original: bool,
    durable_original: bool,
    original: Vec<u8>,
    removed: bool,
    stage: Option<OutputStage>,
    descriptor: Option<ArtifactDescriptor>,
    spool: Option<String>,
    transfer: Option<String>,
    copy: PathBuf,
    acknowledged: bool,
    provider_live: bool,
    consumer_live: bool,
    revision: Cell<u64>,
    starts: Cell<usize>,
    stopped: Cell<bool>,
}
impl Operation {
    fn receipt(&self, delivery: Value) -> Value {
        self.revision.set(self.revision.get() + 1);
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
        json!({"version":1,"operationId":self.id,"requestFingerprint":"b".repeat(64),"provider":{"packageId":self.provider.package_id,"serviceId":"image-generation","major":1},"revision":self.revision.get(),"execution":execution,"delivery":delivery})
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
struct ProfileFixture {
    profile: tempfile::TempDir,
    root: PathBuf,
    consumer: package::Installed,
    provider: package::Installed,
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
    dirty_writes: BTreeMap<PathBuf, Vec<u8>>,
    jobs: BTreeMap<String, JobRecord>,
    applied: usize,
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
        let fixture = ProfileFixture {
            profile,
            root,
            consumer,
            provider,
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
            dirty_writes: BTreeMap::new(),
            jobs: BTreeMap::new(),
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
                incarnation: self.incarnation,
            })
    }
    fn enabled(&self) -> bool {
        self.generation(Role::Consumer).is_some() && self.generation(Role::Provider).is_some()
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
        ai_operations::auto_reconcile_in(self.store(), &Transport { machine: self }).map(|_| ())
    }
    fn request(op: &Operation) -> Value {
        json!({"operationId":op.id,"connectionId":"model-profile","expectedConnectionRevision":"revision-1","model":null,"prompt":"model test","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"local-token","effectiveRecipeDigest":"b".repeat(64)})
    }
    fn admit(&mut self, slot: u8, input: bool) -> Result<(), TestCaseError> {
        if !self.enabled() {
            return Ok(());
        }
        if let Some(index) = self.index(slot) {
            let ops = self.operations.borrow();
            let op = &ops[index];
            if !op.removed
                && !op.acknowledged
                && !self
                    .store()
                    .execution_released(&op.consumer.package_id, &op.id)
                    .unwrap()
            {
                return Ok(());
            }
        }
        self.incarnation += 1;
        let index = self.operations.borrow().len();
        // Rejected preparation also tombstones its request identity. Each
        // generated admission attempt therefore gets a fresh ID.
        let id = format!("model-operation-{}-{index}", self.incarnation);
        let consumer = self.generation(Role::Consumer).unwrap();
        let provider = self.generation(Role::Provider).unwrap();
        let op = Operation {
            id: id.clone(),
            consumer: consumer.clone(),
            provider: provider.clone(),
            outcome: Outcome::Running,
            paid_success: false,
            valid_original: false,
            durable_original: false,
            original: image_bytes(index as u8),
            removed: false,
            stage: None,
            descriptor: None,
            spool: None,
            transfer: None,
            copy: self
                .fixture
                .profile
                .path()
                .join("consumer-data")
                .join(format!("{id}.png")),
            acknowledged: false,
            provider_live: false,
            consumer_live: false,
            revision: Cell::new(0),
            starts: Cell::new(0),
            stopped: Cell::new(false),
        };
        let mut request = Self::request(&op);
        if input {
            let path = self.fixture.profile.path().join(format!("{id}-input.png"));
            fs::write(&path, &op.original).unwrap();
            let captures = match self.store().capture(
                &consumer,
                &id,
                vec![CaptureInput {
                    path: path.to_string_lossy().into(),
                    expected_digest: None,
                }],
            ) {
                Ok(captures) => captures,
                Err(error) if expected_capacity(&error) => return Ok(()),
                Err(error) => {
                    return Err(fail(format!("unexpected input capture rejection: {error}")))
                }
            };
            request["inputs"] = json!(captures.into_iter().map(|c| c.artifact).collect::<Vec<_>>());
        }
        let target = ServiceTarget {
            package_id: provider.package_id.clone(),
            service_id: "image-generation".into(),
            major: 1,
        };
        let started = service_bridge::image_call(
            self.store(),
            &consumer,
            &provider,
            &target,
            "start",
            request,
            || true,
            |method, _| {
                if method.ends_with(".start") {
                    op.starts.set(op.starts.get() + 1)
                }
                Ok(op.receipt(json!({"state":"none"})))
            },
        );
        if let Err(error) = started {
            if expected_capacity(&error) {
                return Ok(());
            }
            return Err(fail(format!("unexpected admission rejection: {error}")));
        }
        if op.starts.get() != 1 {
            return Err(fail("admission did not execute exactly once"));
        }
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
    fn stage(&mut self, slot: u8, complete: bool, synced: bool) -> Result<(), TestCaseError> {
        let Some(index) = self.index(slot) else {
            return Ok(());
        };
        if !self.enabled() {
            return Ok(());
        }
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
            fs::OpenOptions::new()
                .read(true)
                .open(&path)
                .unwrap()
                .sync_all()
                .unwrap();
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
        fs::copy(source.path, &op.copy)?;
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
                        m.sdk_version = 3;
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
            if (remove || !compatible) && !op.removed {
                op.removed = true;
                op.provider_live = false;
                op.consumer_live = false;
            } else if provider {
                op.provider_live = false;
            } else {
                op.consumer_live = false;
            }
        }
        self.incarnation += 1;
        self.applied += 1;
        Ok(())
    }
    fn restart(&mut self, power_loss: bool) -> Result<(), TestCaseError> {
        let oracle = self.oracle.clone();
        for op in self.operations.borrow_mut().iter_mut() {
            op.provider_live = false;
            op.consumer_live = false;
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
        ]
    }
    fn apply(&mut self, command: Command) -> Result<(), TestCaseError> {
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
        match command {
            Command::Admit(s, i) => self.admit(s, i)?,
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
            Command::Spool(s) => {
                if let Some(i) = self.index(s) {
                    let mut ops = self.operations.borrow_mut();
                    let op = &mut ops[i];
                    let admission = checked(self.store().get(&op.consumer.package_id, &op.id))?
                        .expect("model admission exists");
                    if !op.removed
                        && !op.acknowledged
                        && op.spool.is_none()
                        && !matches!(op.outcome, Outcome::Failed | Outcome::Cancelled)
                        && matches!(
                            admission.phase,
                            AdmissionPhase::Forwarding | AdmissionPhase::Accepted
                        )
                        && !checked(
                            self.store()
                                .execution_released(&op.consumer.package_id, &op.id),
                        )?
                    {
                        match self.store().reserve_host_spool(&op.provider, &op.id, 4096) {
                            Ok((handle, path)) => {
                                checked(self.store().bind_host_spool(
                                    &op.provider,
                                    &handle,
                                    &op.consumer.package_id,
                                    &op.id,
                                ))?;
                                fs::write(path.join("stdout"), &op.original).unwrap();
                                fs::write(path.join("stderr"), []).unwrap();
                                op.spool = Some(handle.clone());
                                op.paid_success = true;
                                op.valid_original = true;
                                match self.store().seal_host_spool(&op.provider, &handle, 0) {
                                    Ok(()) => op.durable_original = true,
                                    Err(_) if self.sync_failure || self.unlink_failure => {}
                                    Err(error) => {
                                        return Err(fail(format!(
                                            "unexpected host spool sealing rejection: {error}"
                                        )))
                                    }
                                }
                                self.applied += 1
                            }
                            Err(error)
                                if expected_capacity(&error)
                                    || self.sync_failure
                                    || self.unlink_failure
                                    || error
                                        .to_string()
                                        .contains("plugin incarnation was retired") => {}
                            Err(error) => {
                                return Err(fail(format!(
                                    "unexpected host spool reservation rejection: {error}"
                                )))
                            }
                        }
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
                        Self::request(op),
                        || true,
                        |method, _| {
                            if method.ends_with(".start") {
                                op.starts.set(op.starts.get() + 1)
                            }
                            Ok(op.receipt(op.delivery()))
                        },
                    );
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
                if old.phase.as_deref() == Some("consumer_removed")
                    && job.phase == old.phase
                    && job.revision != old.revision
                {
                    return Err(fail("undelivered image notice was republished"));
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
            if op.starts.get() != 1 {
                return Err(fail(format!("paid execution replayed: {}", op.id)));
            }
            let a = checked(self.store().get(&op.consumer.package_id, &op.id))?.unwrap();
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
                && (op.provider_live || op.consumer_live)
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
    fn quiesce(&mut self) -> Result<(), TestCaseError> {
        self.healthy = true;
        self.unlink_failure = false;
        self.sync_failure = false;
        self.oracle.faults(false, false);
        if self.store.is_none() {
            self.restart(false)?
        }
        for op in self.operations.borrow_mut().iter_mut() {
            op.provider_live = false;
            op.consumer_live = false;
            if op.outcome == Outcome::Running {
                op.outcome = Outcome::Unknown
            }
        }
        for _ in 0..4 {
            let _ = self.sweep();
            checked(self.store().gc())?;
            checked(self.store().sweep_host_spools(|_| false))?;
        }
        self.invariants()?;
        for op in self.operations.borrow().iter() {
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
        let m = self.machine;
        if !m.healthy {
            return Err(AppError::Other(
                "Injected unhealthy status transport".into(),
            ));
        }
        let mut ops = m.operations.borrow_mut();
        let op = ops.iter_mut().find(|o| o.id == a.operation_id).unwrap();
        if op.removed || op.acknowledged {
            return Ok(false);
        }
        if op.outcome == Outcome::Succeeded && op.descriptor.is_none() {
            let _permit = m.store().output_recovery_guard(a)?;
            if let Some(spool) = m
                .store()
                .host_spool_result(&op.provider.package_id, &op.id)?
            {
                let stage = m
                    .store()
                    .stage(&op.provider, &op.consumer.package_id, &op.id)?;
                fs::copy(spool["stdout"].as_str().unwrap(), &stage.path)?;
                op.stage = Some(stage);
                op.outcome = Outcome::Succeeded;
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
                }
            }
        }
        service_bridge::reconcile_at(m.store(), &op.provider, a, &op.receipt(op.delivery()))?;
        Ok(op.provider_live || op.consumer_live)
    }
    fn recover(&self, a: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
        let m = self.machine;
        let mut ops = m.operations.borrow_mut();
        let op = ops.iter_mut().find(|o| o.id == a.operation_id).unwrap();
        if op.removed || op.acknowledged {
            return Ok(());
        }
        // Provider recovery can discover only original bytes. It publishes
        // the success that those bytes establish; it never invokes start.
        let _permit = m.store().output_recovery_guard(a)?;
        if op.descriptor.is_none() {
            if let Some(spool) = m
                .store()
                .host_spool_result(&op.provider.package_id, &op.id)?
            {
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
                let current = m.store().get(&op.consumer.package_id, &op.id)?.unwrap();
                service_bridge::reconcile_at(
                    m.store(),
                    &op.provider,
                    &current,
                    &op.receipt(op.delivery()),
                )?;
            }
        }
        let current = m.store().get(&op.consumer.package_id, &op.id)?.unwrap();
        let Some(d) = current.output.as_ref() else {
            return Ok(());
        };
        if fs::read(&op.copy).ok().as_ref() != Some(&op.original) {
            let source = m
                .store()
                .read(&op.consumer, &op.consumer.package_id, &op.id, d)?;
            fs::copy(source.path, &op.copy)?;
        }
        let proof = m
            .store()
            .acquired(&op.consumer, &op.id, d, op.copy.to_str().unwrap())?;
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
fn run(cases: u32, steps: usize) {
    let totals = RefCell::new(BTreeMap::<&'static str, u64>::new());
    let mut runner = TestRunner::new(Config {
        cases,
        max_shrink_iters: 10_000,
        source_file: Some(file!()),
        ..Config::default()
    });
    runner
        .run(&commands(steps), |commands| {
            let mut m = Machine::new();
            m.admit(0, false)?;
            if m.operations.borrow().len() != 1 {
                return Err(fail("seed admission did not apply"));
            }
            for command in commands {
                m.apply(command)?
            }
            m.quiesce()?;
            for (family, n) in m.coverage {
                *totals.borrow_mut().entry(family).or_default() += n;
            }
            Ok(())
        })
        .unwrap();
    println!(
        "model applied transition coverage ({cases} cases): {:?}",
        totals.into_inner()
    );
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
