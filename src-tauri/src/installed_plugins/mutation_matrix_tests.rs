//! Package mutations against real durable AI claims, in both service roles.
//! Each case owns a private profile and calls the production mutation entry
//! points. Only the candidate preflight, which starts a native process, is a
//! counter; every claim, fence, queue and index write is the real one.
use super::super::{backend, package, service_host};
use super::{set_enabled, uninstall, upgrade, Profile};
use crate::{
    error::AppError,
    service_state::{model::*, Store},
};
use std::{cell::Cell, fs, path::PathBuf};

#[derive(Clone, Copy, Debug)]
enum Role {
    Consumer,
    Provider,
}
#[derive(Clone, Copy, Debug)]
enum Action {
    Disable,
    Remove,
    Upgrade,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Prepared,
    Accepted,
    Running,
    SucceededUnacknowledged,
    OutcomeUnknown,
    Released,
}
const OP: &str = "matrix-operation";

struct Fixture {
    profile: tempfile::TempDir,
    root: PathBuf,
    store: Store,
    consumer: package::Installed,
    provider: package::Installed,
    /// Version 2.0.0 archives, by role.
    next: [PathBuf; 2],
}
impl Fixture {
    fn new(case: &str) -> Self {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().join("installed-plugins");
        let archives = profile.path().join("archives");
        fs::create_dir_all(&archives).unwrap();
        let archive = |id: &str, version: &str| {
            package::tests::archive_named(&archives, &format!("{id}-{version}.teplugin"), |m| {
                m.id = id.into();
                m.version = version.into();
                m.sdk_version = 3;
                m.contributions = vec![id.replace('.', "-")];
            })
        };
        let ids = [
            format!("matrix.consumer-{case}"),
            format!("matrix.provider-{case}"),
        ];
        let current = ids.clone().map(|id| {
            package::publish(
                &root,
                package::prepare(&root, &archive(&id, "1.0.0")).unwrap(),
            )
            .unwrap()
        });
        let [consumer, provider] = current;
        let store = Store::open(profile.path().join("service-state"), Limits::default()).unwrap();
        Self {
            next: ids.map(|id| archive(&id, "2.0.0")),
            profile,
            root,
            store,
            consumer,
            provider,
        }
    }
    fn package(&self, role: Role) -> &package::Installed {
        match role {
            Role::Consumer => &self.consumer,
            Role::Provider => &self.provider,
        }
    }
    fn id(&self, role: Role) -> &str {
        &self.package(role).manifest.id
    }
    fn generation(&self, role: Role) -> PackageGeneration {
        PackageGeneration {
            package_id: self.id(role).into(),
            digest: self.package(role).digest.clone(),
            incarnation: 1,
        }
    }
    fn admission(&self) -> Admission {
        Admission {
            consumer: self.generation(Role::Consumer),
            provider: self.generation(Role::Provider),
            target: ServiceTarget {
                package_id: self.id(Role::Provider).into(),
                service_id: "image-generation".into(),
                major: 1,
            },
            operation_id: OP.into(),
            fingerprint: "b".repeat(64),
            phase: AdmissionPhase::Reserved,
            inputs: vec![],
            output: None,
            needs_attention: false,
            disposition: None,
            transfer_receipt: None,
        }
    }
    fn index(&self) -> Vec<u8> {
        fs::read(self.root.join("installed.json")).unwrap()
    }
    fn installed(&self, role: Role) -> Option<package::Installed> {
        package::list(&self.root)
            .unwrap()
            .into_iter()
            .find(|entry| entry.manifest.id == self.id(role))
    }
    fn succeed(&self) {
        let provider = self.generation(Role::Provider);
        let consumer = self.id(Role::Consumer);
        let stage = self.store.stage(&provider, consumer, OP).unwrap();
        image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
            .save_with_format(&stage.path, image::ImageFormat::Png)
            .unwrap();
        let output = self
            .store
            .seal(&provider, consumer, OP, &stage.handle, "image/png")
            .unwrap();
        self.store
            .terminal(&provider, consumer, OP, Some(output), false)
            .unwrap();
    }
    fn discard(&self) {
        self.store
            .release(
                &self.generation(Role::Provider),
                self.id(Role::Consumer),
                OP,
                "discarded",
                None,
            )
            .unwrap();
    }
    /// Durable state for `phase`. Running also holds live native calls in
    /// both roles, as an in-flight consumer-to-provider request does.
    fn enter(&self, phase: Phase) -> Vec<backend::CallLease> {
        self.store.reserve(self.admission()).unwrap();
        if phase == Phase::Prepared {
            return vec![];
        }
        let consumer = self.generation(Role::Consumer);
        let provider = self.generation(Role::Provider);
        assert!(self.store.claim_forwarding(&consumer, OP).unwrap().1);
        self.store
            .accepted(&provider, &consumer.package_id, OP)
            .unwrap();
        match phase {
            Phase::Prepared | Phase::Accepted => vec![],
            Phase::Running => [Role::Consumer, Role::Provider]
                .map(|role| backend::CallLease::acquire(self.id(role)).unwrap())
                .into(),
            Phase::SucceededUnacknowledged => {
                self.succeed();
                vec![]
            }
            Phase::OutcomeUnknown => {
                self.store
                    .terminal(&provider, &consumer.package_id, OP, None, true)
                    .unwrap();
                vec![]
            }
            Phase::Released => {
                self.succeed();
                self.discard();
                vec![]
            }
        }
    }
    /// The legitimate way each phase stops owning its packages.
    fn settle(&self, phase: Phase) {
        match phase {
            Phase::Prepared => assert!(self
                .store
                .release_unaccepted(&self.generation(Role::Consumer), OP)
                .unwrap()),
            Phase::Accepted | Phase::Running => {
                self.succeed();
                self.discard();
            }
            Phase::SucceededUnacknowledged => self.discard(),
            Phase::OutcomeUnknown => {
                self.store
                    .stop_recovery(
                        &self.generation(Role::Provider),
                        self.id(Role::Consumer),
                        OP,
                        true,
                    )
                    .unwrap();
            }
            Phase::Released => {}
        }
    }
    fn act(
        &self,
        store: &Store,
        action: Action,
        role: Role,
        preflights: &Cell<usize>,
    ) -> Result<(), AppError> {
        let profile = Profile {
            root: &self.root,
            store,
        };
        let id = self.id(role);
        match action {
            Action::Disable => set_enabled(&profile, id, false),
            Action::Remove => uninstall(&profile, id),
            Action::Upgrade => upgrade(&profile, &self.next[role as usize], &|candidate, _, _| {
                assert_eq!(candidate.manifest.version, "2.0.0");
                preflights.set(preflights.get() + 1);
                Ok(())
            })
            .map(|_| ()),
        }
    }
    fn assert_refused(&self, result: Result<(), AppError>, role: Role, before: &[u8], case: &str) {
        let error = result.expect_err(case);
        assert!(service_host::is_busy(&error), "{case}: {error}");
        assert_eq!(self.index(), before, "{case}: index changed");
        assert!(
            !self.root.join("upgrade-pending").exists(),
            "{case}: refusal left an upgrade journal"
        );
        // A refusal never leaves the package fenced.
        drop(backend::CallLease::acquire(self.id(role)).expect(case));
    }
}
fn other(role: Role) -> Role {
    match role {
        Role::Consumer => Role::Provider,
        Role::Provider => Role::Consumer,
    }
}

#[test]
fn each_role_mutation_waits_for_claims_and_live_work_then_commits_safely() {
    let mut case = 0;
    for role in [Role::Consumer, Role::Provider] {
        for action in [Action::Disable, Action::Remove, Action::Upgrade] {
            for phase in [
                Phase::Prepared,
                Phase::Accepted,
                Phase::Running,
                Phase::SucceededUnacknowledged,
                Phase::OutcomeUnknown,
                Phase::Released,
            ] {
                case += 1;
                let name = format!("{role:?} {action:?} at {phase:?}");
                let fx = Fixture::new(&case.to_string());
                let preflights = Cell::new(0);
                let leases = fx.enter(phase);
                let before = fx.index();
                if phase != Phase::Released {
                    let result = fx.act(&fx.store, action, role, &preflights);
                    fx.assert_refused(result, role, &before, &name);
                    assert_eq!(preflights.get(), 0, "{name}: preflight ran while owned");
                    fx.settle(phase);
                }
                if !leases.is_empty() {
                    // Durable claims are resolved, but native calls still run.
                    let result = fx.act(&fx.store, action, role, &preflights);
                    fx.assert_refused(result, role, &before, &format!("{name} (live calls)"));
                    drop(leases);
                }
                fx.act(&fx.store, action, role, &preflights)
                    .unwrap_or_else(|cause| panic!("{name}: eventual mutation failed: {cause}"));
                let after = fx.installed(role);
                match action {
                    Action::Disable => assert!(!after.expect(&name).enabled, "{name}"),
                    Action::Remove => assert!(after.is_none(), "{name}"),
                    Action::Upgrade => {
                        let after = after.expect(&name);
                        assert_eq!(after.manifest.version, "2.0.0", "{name}");
                        assert_ne!(after.digest, fx.package(role).digest, "{name}");
                        assert!(after.enabled, "{name}");
                        assert_eq!(preflights.get(), 1, "{name}");
                    }
                }
                // The other participant is never collateral damage.
                let untouched = fx.installed(other(role)).expect(&name);
                assert_eq!(untouched.digest, fx.package(other(role)).digest, "{name}");
                assert!(untouched.enabled, "{name}");
            }
        }
    }
    assert_eq!(case, 36);
}

#[cfg(target_os = "linux")]
#[test]
fn cold_start_keeps_both_queued_upgrades_until_claims_recover() {
    use std::time::{Duration, SystemTime};
    let fx = Fixture::new("cold-start");
    let queue = fx.profile.path().join("pending-plugins");
    fs::create_dir(&queue).unwrap();
    let queued = [Role::Consumer, Role::Provider].map(|role| {
        let path = queue.join(format!("{}.teplugin", role as usize));
        fs::copy(&fx.next[role as usize], &path).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1 + role as u64))
            .unwrap();
        path
    });
    let leases = fx.enter(Phase::Accepted);
    assert!(leases.is_empty());
    let before = fx.index();
    let preflights = Cell::new(0);
    // Each launch reopens the durable ledger: nothing in memory survives.
    let launch = || {
        let store =
            Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
        super::recover(&fx.root).unwrap();
        super::super::queue::apply(
            &queue,
            |path| {
                upgrade(
                    &Profile {
                        root: &fx.root,
                        store: &store,
                    },
                    path,
                    &|_, _, _| {
                        preflights.set(preflights.get() + 1);
                        Ok(())
                    },
                )
                .map(|_| ())
            },
            || false,
        )
        .unwrap()
    };
    let errors = launch();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(fx.index(), before);
    assert_eq!(preflights.get(), 0);
    for (role, path) in [Role::Consumer, Role::Provider].into_iter().zip(&queued) {
        assert_eq!(
            fs::read(path).unwrap(),
            fs::read(&fx.next[role as usize]).unwrap()
        );
    }
    assert!(!queue.join("failed").exists());
    // A launch before recovery still defers both, never consuming a request.
    assert_eq!(launch().len(), 1);
    assert!(queued.iter().all(|path| path.exists()));
    // The provider proves success and the consumer's handoff settles.
    fx.settle(Phase::Accepted);
    assert!(launch().is_empty());
    assert_eq!(preflights.get(), 2);
    for role in [Role::Consumer, Role::Provider] {
        let installed = fx.installed(role).unwrap();
        assert_eq!(installed.manifest.version, "2.0.0");
        assert!(installed.enabled);
    }
    assert!(queued.iter().all(|path| !path.exists()));
    assert!(!queue.join("failed").exists());
}
