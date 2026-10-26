//! Package mutations against real durable AI claims, in both service roles.
//! Each case owns a private profile and calls the production mutation entry
//! points. Only the candidate preflight, which starts a native process, is a
//! counter; every claim, fence, queue and index write is the real one.
use super::super::{
    ai_operations::{exclusive_host_profile, HostProfile},
    backend, package,
};
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
    Forwarding,
    Accepted,
    Running,
    SucceededUnacknowledged,
    OutcomeUnknown,
    SettledAccepted,
    SettledRunning,
    SettledUnknown,
    Released,
    Acquired,
}
const OP: &str = "matrix-operation";

struct Fixture {
    /// Owns every path below; only the Linux queue test reads it directly.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    profile: tempfile::TempDir,
    root: PathBuf,
    store: Store,
    consumer: package::Installed,
    provider: package::Installed,
    /// Version 2.0.0 archives, by role.
    next: [PathBuf; 2],
    /// Declared last so it is released after the profile is torn down.
    _host: HostProfile,
}
impl Fixture {
    fn new(case: &str) -> Self {
        let host = exclusive_host_profile();
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
                if id.contains("provider") {
                    m.services = serde_json::from_value(serde_json::json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}])).unwrap();
                } else {
                    m.service_dependencies = serde_json::from_value(serde_json::json!([{"packageId":format!("matrix.provider-{case}"),"serviceId":"image-generation","major":1,"optional":true}])).unwrap();
                }
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
            _host: host,
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
        let input = self.profile.path().join("input.png");
        image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
            .save(&input)
            .unwrap();
        let captured = self
            .store
            .capture(
                &self.generation(Role::Consumer),
                OP,
                vec![CaptureInput {
                    path: input.to_string_lossy().into(),
                    expected_digest: None,
                }],
            )
            .unwrap();
        let mut admission = self.admission();
        admission.inputs = captured.into_iter().map(|c| c.artifact).collect();
        self.store.reserve(admission).unwrap();
        if phase == Phase::Prepared {
            return vec![];
        }
        let consumer = self.generation(Role::Consumer);
        let provider = self.generation(Role::Provider);
        assert!(self.store.claim_forwarding(&consumer, OP).unwrap().1);
        if phase == Phase::Forwarding {
            return vec![];
        }
        self.store
            .accepted(&provider, &consumer.package_id, OP)
            .unwrap();
        match phase {
            Phase::Prepared | Phase::Forwarding | Phase::Accepted => vec![],
            Phase::SettledAccepted | Phase::SettledRunning | Phase::SettledUnknown => {
                let state = match phase {
                    Phase::SettledAccepted => "accepted",
                    Phase::SettledRunning => "running",
                    _ => "unknown",
                };
                let mut receipt = serde_json::json!({"version":1,"operationId":OP,"requestFingerprint":"b".repeat(64),"provider":{"packageId":provider.package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":state},"delivery":{"state":"none"}});
                if state == "unknown" {
                    receipt["execution"]["error"] = serde_json::json!({"code":"interrupted","message":"Unconfirmed","correlationId":null});
                }
                super::super::service_bridge::reconcile_at(
                    &self.store,
                    &provider,
                    &self.store.get(&consumer.package_id, OP).unwrap().unwrap(),
                    &receipt,
                )
                .unwrap();
                self.store
                    .auto_settle_operation(&consumer.package_id, OP, true)
                    .unwrap();
                vec![]
            }
            Phase::Acquired => {
                self.succeed();
                let a = self.store.get(&consumer.package_id, OP).unwrap().unwrap();
                let d = a.output.unwrap();
                let data = self.profile.path().join("consumer-data");
                fs::create_dir(&data).unwrap();
                self.store
                    .register_consumer_root(&consumer.package_id, data.clone())
                    .unwrap();
                let copy = data.join("generated.png");
                fs::copy(
                    self.store
                        .read(&consumer, &consumer.package_id, OP, &d)
                        .unwrap()
                        .path,
                    &copy,
                )
                .unwrap();
                let proof = self
                    .store
                    .acquired(&consumer, OP, &d, copy.to_str().unwrap())
                    .unwrap();
                self.store
                    .release(
                        &provider,
                        &consumer.package_id,
                        OP,
                        "acquired",
                        Some(&proof.transfer_receipt),
                    )
                    .unwrap();
                vec![]
            }
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
}

#[test]
fn review_successful_consumer_can_upgrade_disable_and_uninstall_without_losing_automatic_output() {
    for (action, role) in [Role::Consumer, Role::Provider]
        .into_iter()
        .flat_map(|role| {
            [Action::Upgrade, Action::Disable, Action::Remove].map(|action| (action, role))
        })
    {
        let fx = Fixture::new(&format!("delivery-repair-{role:?}-{action:?}").to_lowercase());
        fx.enter(Phase::SucceededUnacknowledged);
        let output = fx
            .store
            .get(fx.id(Role::Consumer), OP)
            .unwrap()
            .unwrap()
            .output
            .unwrap();
        let path = fx
            .store
            .read(
                &fx.generation(Role::Consumer),
                fx.id(Role::Consumer),
                OP,
                &output,
            )
            .unwrap()
            .path;
        let preflights = Cell::new(0);
        fx.act(&fx.store, action, role, &preflights)
            .expect("retained success must permit explicit package repair/removal");
        let a = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
        match action {
            Action::Upgrade => {
                assert_eq!(a.phase, AdmissionPhase::Terminal);
                assert_eq!(a.output, Some(output));
                assert!(std::path::Path::new(&path).exists());
            }
            Action::Disable | Action::Remove => {
                assert_eq!(a.phase, AdmissionPhase::Released);
                assert!(!std::path::Path::new(&path).exists());
                let report = fx
                    .store
                    .job_for_operation(fx.id(Role::Consumer), OP)
                    .unwrap()
                    .unwrap();
                assert_eq!(report.state, crate::service_state::job::JobState::Error);
                assert!(report.error.unwrap().contains("could not be delivered"));
                super::recover(&fx.root).unwrap();
                assert_eq!(
                    fx.store.snapshot_jobs().unwrap().jobs.len(),
                    1,
                    "removal recovery must report the undelivered image once"
                );
            }
        }
    }
}

#[test]
fn review_consumer_removal_recovers_each_durable_index_commit_order() {
    for committed in [false, true] {
        let fx = Fixture::new(&format!("removal-crash-{committed}"));
        fx.enter(Phase::SucceededUnacknowledged);
        let consumer = fx.id(Role::Consumer);
        fx.store.prepare_consumer_removal(consumer).unwrap();
        if committed {
            let mut index = package::list(&fx.root).unwrap();
            index
                .iter_mut()
                .find(|p| p.manifest.id == consumer)
                .unwrap()
                .enabled = false;
            package::write_index(&fx.root, &index).unwrap();
        }
        // Crash after intention, either side of the actual index commit.
        super::recover(&fx.root).unwrap();
        let recovered =
            Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
        assert!(recovered.pending_consumer_removals().unwrap().is_empty());
        let a = recovered.get(consumer, OP).unwrap().unwrap();
        assert_eq!(
            a.phase,
            if committed {
                AdmissionPhase::Released
            } else {
                AdmissionPhase::Terminal
            }
        );
        let report = recovered.job_for_operation(consumer, OP).unwrap();
        if committed {
            assert!(report
                .unwrap()
                .error
                .unwrap()
                .contains("could not be delivered"));
        } else {
            assert!(report.is_none());
        }
        super::recover(&fx.root).unwrap();
        assert_eq!(recovered.get(consumer, OP).unwrap().unwrap(), a);
    }
}

#[test]
fn review_provider_removal_disables_required_dependents_and_reports_once_after_restart() {
    for action in [Action::Disable, Action::Remove] {
        let fx = Fixture::new(&format!("required-provider-{action:?}").to_lowercase());
        let mut entries = package::list(&fx.root).unwrap();
        entries.iter_mut().find(|p|p.manifest.id==fx.id(Role::Provider)).unwrap().manifest.services=serde_json::from_value(serde_json::json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}])).unwrap();
        entries.iter_mut().find(|p|p.manifest.id==fx.id(Role::Consumer)).unwrap().manifest.service_dependencies=serde_json::from_value(serde_json::json!([{"packageId":fx.id(Role::Provider),"serviceId":"image-generation","major":1}])).unwrap();
        package::write_index(&fx.root, &entries).unwrap();
        fx.enter(Phase::SucceededUnacknowledged);
        let live = backend::CallLease::acquire(fx.id(Role::Consumer)).unwrap();
        fx.act(&fx.store, action, Role::Provider, &Cell::new(0))
            .unwrap();
        drop(live);
        assert!(!fx.installed(Role::Consumer).unwrap().enabled);
        super::recover(&fx.root).unwrap();
        let reopened =
            Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
        assert!(reopened.claims().unwrap().is_empty());
        assert_eq!(reopened.snapshot_jobs().unwrap().jobs.len(), 1);
        assert!(reopened.snapshot_jobs().unwrap().jobs[0]
            .error
            .as_ref()
            .unwrap()
            .contains("could not be delivered"));
        super::super::service_graph::validate_enabled(&package::list(&fx.root).unwrap()).unwrap();
    }
}

const PHASES: [Phase; 11] = [
    Phase::Prepared,
    Phase::Forwarding,
    Phase::Accepted,
    Phase::Running,
    Phase::SucceededUnacknowledged,
    Phase::OutcomeUnknown,
    Phase::SettledAccepted,
    Phase::SettledRunning,
    Phase::SettledUnknown,
    Phase::Released,
    Phase::Acquired,
];
const JOB_STATES: [crate::service_state::job::JobState; 8] = {
    use crate::service_state::job::JobState::*;
    [
        Accepting,
        Running,
        Recovering,
        NeedsAttention,
        Completed,
        Error,
        Cancelled,
        Discarded,
    ]
};

#[test]
fn ninth_compatible_upgrade_retains_captured_accepting_preparation_without_admission() {
    use crate::service_state::job::JobState;
    let fx = Fixture::new("ninth-preparation");
    fx.present(JobState::Accepting);
    let input = fx.profile.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let spec = vec![CaptureInput {
        path: input.to_string_lossy().into(),
        expected_digest: None,
    }];
    let captured = fx
        .store
        .capture(&fx.generation(Role::Consumer), OP, spec.clone())
        .unwrap();
    assert!(fx.store.get(fx.id(Role::Consumer), OP).unwrap().is_none());
    let original_path = fx
        .store
        .read(
            &fx.generation(Role::Consumer),
            fx.id(Role::Consumer),
            OP,
            &captured[0].artifact,
        )
        .unwrap()
        .path;
    let upgraded = upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &fx.next[Role::Consumer as usize],
        &|_, _, _| Ok(()),
    )
    .unwrap();
    assert_eq!(
        fx.store
            .job_for_operation(fx.id(Role::Consumer), OP)
            .unwrap()
            .unwrap()
            .state,
        JobState::Accepting,
        "compatible upgrade cancelled captured work before service admission"
    );
    assert!(std::path::Path::new(&original_path).is_file());
    let reopened = Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
    reopened
        .release_preparations(&fx.generation(Role::Consumer))
        .unwrap();
    let current = PackageGeneration {
        package_id: upgraded.manifest.id.clone(),
        digest: upgraded.digest.clone(),
        incarnation: 2,
    };
    let caller =
        super::super::service_bridge::recovery_caller(&reopened, &upgraded.manifest, &current, OP)
            .unwrap();
    assert_eq!(caller, current);
    let recovered = reopened
        .capture(&caller, OP, spec)
        .expect("replacement must reuse the original captured snapshot");
    assert_eq!(recovered[0].artifact, captured[0].artifact);
    let mut admission = fx.admission();
    admission.consumer = caller.clone();
    admission.inputs = recovered.into_iter().map(|c| c.artifact).collect();
    reopened
        .reserve(admission)
        .expect("retained preparation ID must remain admissible");
    assert_eq!(
        reopened
            .job_for_operation(fx.id(Role::Consumer), OP)
            .unwrap()
            .unwrap()
            .owner,
        caller
    );
}

#[test]
fn ninth_incompatible_sdk2_upgrade_releases_custodyless_spool_without_admissions() {
    let fx = Fixture::new("ninth-custodyless");
    let owner = fx.generation(Role::Provider);
    let (handle, path) = fx
        .store
        .reserve_host_spool(&owner, "host:standalone", 1024)
        .unwrap();
    fs::write(path.join("stdout"), b"paid original reply").unwrap();
    fs::write(path.join("stderr"), []).unwrap();
    fx.store.seal_host_spool(&owner, &handle, 0).unwrap();
    assert!(fx
        .store
        .package_operations(fx.id(Role::Provider))
        .unwrap()
        .is_empty());
    let archive =
        package::tests::archive_named(&fx.profile.path().join("archives"), "sdk2.teplugin", |m| {
            m.id = fx.id(Role::Provider).into();
            m.version = "2.0.0".into();
            m.sdk_version = 2;
            m.contributions = vec![m.id.replace('.', "-")];
        });
    upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &archive,
        &|_, _, _| Ok(()),
    )
    .unwrap();
    assert!(
        !path.exists(),
        "incompatible replacement kept a custody-less paid spool"
    );
    let reopened = Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
    reopened.sweep_host_spools(|_| true).unwrap();
    assert!(reopened
        .host_spool_result(&owner.package_id, "host:standalone")
        .unwrap()
        .is_none());
    let conn =
        rusqlite::Connection::open(fx.profile.path().join("service-state/ledger.sqlite")).unwrap();
    let charged: i64 = conn
        .query_row("SELECT coalesce(sum(bytes),0) FROM host_spools", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        charged, 0,
        "incompatible replacement must release durable quota"
    );
}
#[test]
fn ninth_compatible_upgrade_keeps_custodyless_original_without_admissions() {
    let fx = Fixture::new("ninth-standalone-compatible");
    let owner = fx.generation(Role::Provider);
    let (handle, path) = fx
        .store
        .reserve_host_spool(&owner, "host:standalone", 1024)
        .unwrap();
    fs::write(path.join("stdout"), b"paid standalone reply").unwrap();
    fs::write(path.join("stderr"), []).unwrap();
    fx.store.seal_host_spool(&owner, &handle, 0).unwrap();
    upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &fx.next[Role::Provider as usize],
        &|_, _, _| Ok(()),
    )
    .unwrap();
    let reopened = Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
    reopened.sweep_host_spools(|_| false).unwrap();
    let recovered = reopened
        .host_spool_result(&owner.package_id, "host:standalone")
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
        b"paid standalone reply"
    );
    // SDK 2 temporary handles remain a harmless no-op, while that protocol can
    // release the modern opaque handle through the same durable host boundary.
    reopened
        .release_host_spool_if_present(&owner.package_id, "host:temporary")
        .unwrap();
    assert!(path.exists());
    reopened
        .release_host_spool_if_present(&owner.package_id, &handle)
        .unwrap();
    assert!(!path.exists());
}

#[test]
fn ninth_compatible_preparation_recovers_interrupted_capture_before_receipt() {
    use crate::service_state::job::JobState;
    let fx = Fixture::new("ninth-interrupted-capture");
    fx.present(JobState::Accepting);
    let input = fx.profile.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let spec = vec![CaptureInput {
        path: input.to_string_lossy().into(),
        expected_digest: None,
    }];
    let captured = fx
        .store
        .capture(&fx.generation(Role::Consumer), OP, spec.clone())
        .unwrap();
    // File publication precedes the single capture-receipt transaction. Keep
    // its bytes but restore the ledger state at that real crash boundary.
    let conn =
        rusqlite::Connection::open(fx.profile.path().join("service-state/ledger.sqlite")).unwrap();
    conn.execute(
        "UPDATE operations SET captures=NULL WHERE consumer=?1 AND operation=?2",
        rusqlite::params![fx.id(Role::Consumer), OP],
    )
    .unwrap();
    conn.execute("UPDATE artifacts SET status='capturing',descriptor=NULL,source=NULL,width=NULL,height=NULL WHERE consumer=?1 AND operation=?2",rusqlite::params![fx.id(Role::Consumer),OP]).unwrap();
    drop(conn);
    let upgraded = upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &fx.next[Role::Consumer as usize],
        &|_, _, _| Ok(()),
    )
    .unwrap();
    let reopened = Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
    let current = PackageGeneration {
        package_id: upgraded.manifest.id.clone(),
        digest: upgraded.digest,
        incarnation: 2,
    };
    let caller =
        super::super::service_bridge::recovery_caller(&reopened, &upgraded.manifest, &current, OP)
            .unwrap();
    assert!(
        reopened
            .capture(
                &caller,
                OP,
                vec![CaptureInput {
                    path: "another-input.png".into(),
                    expected_digest: None
                }]
            )
            .is_err(),
        "recovery cannot change the original capture spec"
    );
    let recovered = reopened
        .capture(&caller, OP, spec)
        .expect("unreceipted capture must retry once old IO has gone");
    assert_eq!(recovered[0].artifact.sha256, captured[0].artifact.sha256);
    let mut admission = fx.admission();
    admission.consumer = caller;
    admission.inputs = recovered.into_iter().map(|c| c.artifact).collect();
    reopened.reserve(admission).unwrap();
}

#[test]
fn ninth_compatible_upgrade_keeps_presentation_before_first_capture() {
    use crate::service_state::job::JobState;
    let fx = Fixture::new("ninth-before-capture");
    fx.present(JobState::Accepting);
    let before = fx
        .store
        .job_for_operation(fx.id(Role::Consumer), OP)
        .unwrap()
        .unwrap();
    let upgraded = upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &fx.next[Role::Consumer as usize],
        &|_, _, _| Ok(()),
    )
    .unwrap();
    let current = PackageGeneration {
        package_id: upgraded.manifest.id.clone(),
        digest: upgraded.digest.clone(),
        incarnation: 2,
    };
    let after =
        super::super::job_bridge::recovery_job(&fx.store, &upgraded.manifest, &current, &before)
            .expect(
                "a callback holding the original snapshot must adopt once and continue immediately",
            );
    assert_eq!(after.state, JobState::Accepting);
    assert_eq!(after.owner, current);
    assert_eq!(after.job_key, before.job_key);
    assert_eq!(after.job_id, before.job_id);
}

#[test]
fn ninth_dead_consumer_cleanup_cannot_collect_preparation_during_upgrade_preflight() {
    use crate::service_state::job::JobState;
    use std::time::{Duration, Instant};
    let fx = Fixture::new("ninth-preflight-death");
    fx.present(JobState::Accepting);
    let input = fx.profile.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let spec = vec![CaptureInput {
        path: input.to_string_lossy().into(),
        expected_digest: None,
    }];
    let captured = fx
        .store
        .capture(&fx.generation(Role::Consumer), OP, spec.clone())
        .unwrap();
    let original = fx
        .store
        .read(
            &fx.generation(Role::Consumer),
            fx.id(Role::Consumer),
            OP,
            &captured[0].artifact,
        )
        .unwrap()
        .path;
    struct Unadmitted;
    impl super::super::service_bridge::RecoveryPort for Unadmitted {
        fn closing(&self) -> bool {
            false
        }
        fn signal_cancel(&self, _: &Admission) {
            panic!("preparation has no provider execution");
        }
        fn control(
            &self,
            _: &Admission,
            _: &str,
            _: &mut dyn FnMut(&PackageGeneration, &serde_json::Value) -> Result<(), AppError>,
        ) -> Result<serde_json::Value, AppError> {
            panic!("preparation has no provider execution");
        }
    }
    let upgraded = std::thread::scope(|scope| {
        let (start, ready) = std::sync::mpsc::channel();
        let (done, completed) = std::sync::mpsc::channel();
        let store = &fx.store;
        let owner = fx.generation(Role::Consumer);
        let worker = scope.spawn(move || {
            ready.recv().unwrap();
            let deadline = Instant::now() + Duration::from_millis(200);
            let result = crate::native_deadline::scoped(deadline, || {
                super::super::service_bridge::recover_owned(
                    store,
                    &Unadmitted,
                    &owner,
                    crate::recovery_actor::Mode::TailOnly,
                    deadline,
                    deadline,
                )
            });
            done.send(result).unwrap();
        });
        let upgraded = upgrade(&Profile { root: &fx.root, store: &fx.store }, &fx.next[Role::Consumer as usize], &|_, _, _| {
            // The broker is already retired here, while the old preparation
            // still awaits the committed compatibility decision.
            start.send(()).unwrap();
            let result = completed.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(std::path::Path::new(&original).is_file(), "dead-consumer cleanup discarded captured inputs before upgrade could retain them");
            assert!(result.is_err(), "recovery must retain its budget rather than bypass the lifecycle custody decision");
            Ok(())
        }).unwrap();
        worker.join().unwrap();
        upgraded
    });
    let current = PackageGeneration {
        package_id: upgraded.manifest.id.clone(),
        digest: upgraded.digest,
        incarnation: 2,
    };
    let caller =
        super::super::service_bridge::recovery_caller(&fx.store, &upgraded.manifest, &current, OP)
            .unwrap();
    assert_eq!(
        fx.store.capture(&caller, OP, spec).unwrap()[0].artifact,
        captured[0].artifact
    );
}

#[test]
fn ninth_published_upgrade_journal_preserves_incomplete_preparation_before_grant() {
    use crate::service_state::job::JobState;
    let fx = Fixture::new("ninth-journal-preparation");
    fx.present(JobState::Accepting);
    let input = fx.profile.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let spec = vec![CaptureInput {
        path: input.to_string_lossy().into(),
        expected_digest: None,
    }];
    let captured = fx
        .store
        .capture(&fx.generation(Role::Consumer), OP, spec.clone())
        .unwrap();
    let original = fx
        .store
        .read(
            &fx.generation(Role::Consumer),
            fx.id(Role::Consumer),
            OP,
            &captured[0].artifact,
        )
        .unwrap()
        .path;
    super::crash_at_boundary("upgrade-published");
    let result = upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &fx.next[Role::Consumer as usize],
        &|_, _, _| {
            // Restore an unfinished capture's ledger state after its file write,
            // before the compatibility decision has published a replacement grant.
            let conn =
                rusqlite::Connection::open(fx.profile.path().join("service-state/ledger.sqlite"))
                    .unwrap();
            conn.execute(
                "UPDATE operations SET captures=NULL WHERE consumer=?1 AND operation=?2",
                rusqlite::params![fx.id(Role::Consumer), OP],
            )
            .unwrap();
            conn.execute("UPDATE artifacts SET status='capturing',descriptor=NULL,source=NULL,width=NULL,height=NULL WHERE consumer=?1 AND operation=?2",rusqlite::params![fx.id(Role::Consumer),OP]).unwrap();
            Ok(())
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("injected lifecycle crash"));
    assert!(fx.root.join("upgrade-pending/upgrade.json").is_file());
    assert!(std::path::Path::new(&original).is_file());
    let reopened = Store::open(fx.profile.path().join("service-state"), Limits::default()).unwrap();
    assert!(std::path::Path::new(&original).is_file(), "Store startup collected retained preparation before forward journal recovery could grant it");
    super::recover(&fx.root).unwrap();
    let installed = fx.installed(Role::Consumer).unwrap();
    let current = PackageGeneration {
        package_id: installed.manifest.id.clone(),
        digest: installed.digest,
        incarnation: 2,
    };
    let caller =
        super::super::service_bridge::recovery_caller(&reopened, &installed.manifest, &current, OP)
            .unwrap();
    assert_eq!(
        reopened.capture(&caller, OP, spec).unwrap()[0]
            .artifact
            .sha256,
        captured[0].artifact.sha256
    );
}

#[test]
fn ninth_compatible_upgrade_collects_orphaned_and_cancelled_preparations() {
    use crate::service_state::job::JobState;
    for with_cancelled_job in [false, true] {
        let fx = Fixture::new(if with_cancelled_job {
            "ninth-cancelled-prep"
        } else {
            "ninth-orphan-prep"
        });
        if with_cancelled_job {
            fx.present(JobState::Cancelled);
        }
        let input = fx.profile.path().join("input.png");
        image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
            .save(&input)
            .unwrap();
        let captured = fx
            .store
            .capture(
                &fx.generation(Role::Consumer),
                OP,
                vec![CaptureInput {
                    path: input.to_string_lossy().into(),
                    expected_digest: None,
                }],
            )
            .unwrap();
        let original = fx
            .store
            .read(
                &fx.generation(Role::Consumer),
                fx.id(Role::Consumer),
                OP,
                &captured[0].artifact,
            )
            .unwrap()
            .path;
        let upgraded = upgrade(
            &Profile {
                root: &fx.root,
                store: &fx.store,
            },
            &fx.next[Role::Consumer as usize],
            &|_, _, _| Ok(()),
        )
        .unwrap();
        assert!(!std::path::Path::new(&original).exists());
        let current = PackageGeneration {
            package_id: upgraded.manifest.id,
            digest: upgraded.digest,
            incarnation: 2,
        };
        assert!(!fx.store.adopt_preparation(&current, OP).unwrap());
    }
}

impl Fixture {
    fn present(&self, state: crate::service_state::job::JobState) {
        use crate::service_state::job::*;
        let j = self
            .store
            .register_job(JobRecord {
                job_key: "a".repeat(48),
                job_id: 91,
                owner: self.generation(Role::Consumer),
                operation_id: OP.into(),
                kind: "openai-image".into(),
                label: "AI image".into(),
                origin_window: "matrix".into(),
                revision: 0,
                source_revision: 0,
                ownership_epoch: 0,
                created_at_ms: 1,
                updated_at_ms: 1,
                settled_at_ms: None,
                estimate_key: None,
                state: JobState::Accepting,
                phase: None,
                output_path: None,
                cost: None,
                reveal: None,
                run_id: None,
                error: None,
            })
            .unwrap();
        if state != JobState::Accepting {
            self.store
                .update_job(
                    &j.owner,
                    &j.job_key,
                    state,
                    Some("fixture".into()),
                    (state == JobState::Completed).then(|| "/delivered.png".into()),
                    Some(17),
                    None,
                )
                .unwrap();
        }
    }
}
#[test]
fn invariant_a_disable_and_uninstall_release_every_phase_and_job_state() {
    let mut case = 0;
    for role in [Role::Consumer, Role::Provider] {
        for action in [Action::Disable, Action::Remove] {
            for phase in PHASES {
                for state in JOB_STATES {
                    case += 1;
                    let fx = Fixture::new(&format!("exit-{case}"));
                    let leases = fx.enter(phase);
                    fx.present(state);
                    fx.act(&fx.store, action, role, &Cell::new(0))
                        .unwrap_or_else(|e| panic!("{role:?}/{action:?}/{phase:?}/{state:?}: {e}"));
                    assert!(fx.store.claims().unwrap().is_empty());
                    assert!(!fx.store.busy(fx.id(Role::Consumer)).unwrap());
                    assert!(!fx.store.busy(fx.id(Role::Provider)).unwrap());
                    assert_eq!(
                        fx.store
                            .get(fx.id(Role::Consumer), OP)
                            .unwrap()
                            .unwrap()
                            .phase,
                        AdmissionPhase::Released
                    );
                    let jobs = fx.store.snapshot_jobs().unwrap().jobs;
                    assert_eq!(jobs.len(), 1);
                    assert!(jobs[0].state.terminal());
                    let notices = jobs
                        .iter()
                        .filter(|j| {
                            j.error
                                .as_ref()
                                .is_some_and(|e| e.starts_with("An image from "))
                        })
                        .count();
                    assert_eq!(
                        notices,
                        usize::from(
                            phase == Phase::SucceededUnacknowledged
                                && state != crate::service_state::job::JobState::Completed
                        )
                    );
                    drop(leases);
                    super::recover(&fx.root).unwrap();
                    let reopened =
                        Store::open(fx.profile.path().join("service-state"), Limits::default())
                            .unwrap();
                    assert_eq!(reopened.snapshot_jobs().unwrap().jobs, jobs);
                    assert!(reopened.claims().unwrap().is_empty());
                    assert!(fs::read_dir(fx.profile.path().join("service-state/bytes"))
                        .unwrap()
                        .next()
                        .is_none());
                    assert!(fs::read_dir(fx.profile.path().join("service-state/stages"))
                        .unwrap()
                        .next()
                        .is_none());
                }
            }
        }
    }
}
#[test]
fn upgrade_preserves_compatible_custody_and_authority_and_releases_incompatible_phases() {
    // This matrix checks durable custody and authority, not recovery IO. The
    // native compatible upgrade tests execute LiveAutomatic through real
    // replacement brokers, artifact callbacks, acquisition and completion.
    let mut case = 0;
    for role in [Role::Consumer, Role::Provider] {
        for compatible in [true, false] {
            for phase in PHASES {
                for state in JOB_STATES {
                    case += 1;
                    let fx = Fixture::new(&format!("repair-{case}"));
                    let leases = fx.enter(phase);
                    fx.present(state);
                    let before = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
                    let archive = if compatible {
                        fx.next[role as usize].clone()
                    } else {
                        package::tests::archive_named(
                            &fx.profile.path().join("archives"),
                            "incompatible.teplugin",
                            |m| {
                                m.id = fx.id(role).into();
                                m.version = "2.0.0".into();
                                m.sdk_version = 3;
                                m.contributions = vec![fx.id(role).replace('.', "-")];
                            },
                        )
                    };
                    let upgraded = upgrade(
                        &Profile {
                            root: &fx.root,
                            store: &fx.store,
                        },
                        &archive,
                        &|_, _, _| Ok(()),
                    )
                    .unwrap_or_else(|e| panic!("{role:?}/{compatible}/{phase:?}/{state:?}: {e}"));
                    let after = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
                    if compatible {
                        assert_eq!(after, before, "upgrade changed original custody");
                        let reopened =
                            Store::open(fx.profile.path().join("service-state"), Limits::default())
                                .unwrap();
                        assert_eq!(
                            reopened.get(fx.id(Role::Consumer), OP).unwrap(),
                            Some(before.clone())
                        );
                        assert_eq!(
                            reopened
                                .execution_released(fx.id(Role::Consumer), OP)
                                .unwrap(),
                            matches!(
                                phase,
                                Phase::SettledAccepted
                                    | Phase::SettledRunning
                                    | Phase::SettledUnknown
                            )
                        );
                        if phase != Phase::Released
                            && (phase != Phase::Acquired || !state.terminal())
                        {
                            assert!(
                                reopened
                                    .auto_settlement_operations()
                                    .unwrap()
                                    .iter()
                                    .any(|(a, _, _)| a.operation_id == OP),
                                "replacement recovery was not re-armed"
                            );
                        }

                        let current = PackageGeneration {
                            package_id: upgraded.manifest.id.clone(),
                            digest: upgraded.digest.clone(),
                            incarnation: 2,
                        };
                        let authority = match role {
                            Role::Consumer => super::super::service_bridge::recovery_caller(
                                &fx.store,
                                &upgraded.manifest,
                                &current,
                                OP,
                            ),
                            Role::Provider => super::super::service_bridge::recovery_provider(
                                &fx.store,
                                &upgraded.manifest,
                                &current,
                                fx.id(Role::Consumer),
                                OP,
                            ),
                        }
                        .expect("every compatible phase retains recovery authority");
                        assert_eq!(authority, fx.generation(role));
                        if let Some(output) = before
                            .output
                            .as_ref()
                            .filter(|_| phase != Phase::Released && phase != Phase::Acquired)
                        {
                            assert!(fx
                                .store
                                .read(
                                    &fx.generation(Role::Consumer),
                                    fx.id(Role::Consumer),
                                    OP,
                                    output
                                )
                                .is_ok());
                        }
                    } else {
                        assert_eq!(after.phase, AdmissionPhase::Released);
                        assert!(fx.store.claims().unwrap().is_empty());
                        assert!(fx
                            .store
                            .snapshot_jobs()
                            .unwrap()
                            .jobs
                            .iter()
                            .all(|j| j.state.terminal()));
                    }
                    drop(leases);
                }
            }
        }
    }
}

#[test]
fn compatible_upgrade_recovers_or_settles_every_original_phase_without_new_paid_work() {
    use super::super::ai_operations::{auto_reconcile_in, AutomaticPort};
    use crate::service_state::job::{JobRecord, JobState};
    struct ReplacementDelivery<'a> {
        fx: &'a Fixture,
        recovered: Cell<usize>,
    }
    impl AutomaticPort for ReplacementDelivery<'_> {
        fn active(
            &self,
            a: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            let installed = package::list(&self.fx.root)?;
            for role in [Role::Consumer, Role::Provider] {
                let p = installed
                    .iter()
                    .find(|p| p.manifest.id == self.fx.id(role))
                    .unwrap();
                let current = PackageGeneration {
                    package_id: p.manifest.id.clone(),
                    digest: p.digest.clone(),
                    incarnation: if p.digest == self.fx.generation(role).digest {
                        1
                    } else {
                        2
                    },
                };
                let original = match role {
                    Role::Consumer => super::super::service_bridge::recovery_caller(
                        &self.fx.store,
                        &p.manifest,
                        &current,
                        &a.operation_id,
                    )?,
                    Role::Provider => super::super::service_bridge::recovery_provider(
                        &self.fx.store,
                        &p.manifest,
                        &current,
                        &a.consumer.package_id,
                        &a.operation_id,
                    )?,
                };
                assert_eq!(original, self.fx.generation(role));
            }
            Ok(false)
        }
        fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
            let job = job.expect("every recoverable original has a presentation job");
            let artifact = a
                .output
                .as_ref()
                .expect("production reconciliation recovered original bytes");
            let source = self.fx.store.read(
                &a.consumer,
                &a.consumer.package_id,
                &a.operation_id,
                artifact,
            )?;
            let data = self.fx.profile.path().join("replacement-delivery");
            fs::create_dir_all(&data)?;
            self.fx
                .store
                .register_consumer_root(&a.consumer.package_id, data.clone())?;
            let target = data.join("original.png");
            fs::copy(&source.path, &target)?;
            let acquired = self.fx.store.acquired(
                &a.consumer,
                &a.operation_id,
                artifact,
                target.to_str().unwrap(),
            )?;
            self.fx.store.release(
                &a.provider,
                &a.consumer.package_id,
                &a.operation_id,
                "acquired",
                Some(&acquired.transfer_receipt),
            )?;
            let completed = self
                .fx
                .store
                .complete_acquired_job(&a.consumer.package_id, &a.operation_id)?
                .expect("acknowledged original must complete");
            assert_eq!(completed.job_key, job.job_key);
            self.recovered.set(self.recovered.get() + 1);
            Ok(())
        }
    }
    for role in [Role::Consumer, Role::Provider] {
        for phase in PHASES {
            let fx = Fixture::new(&format!("recovery-{role:?}-{phase:?}").to_lowercase());
            let leases = fx.enter(phase);
            fx.present(if phase == Phase::Prepared {
                JobState::Accepting
            } else if phase == Phase::Released {
                JobState::Discarded
            } else {
                JobState::Running
            });
            let original = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
            let expects_delivery = !matches!(phase, Phase::Prepared | Phase::Released);
            if expects_delivery && phase != Phase::Acquired && original.output.is_none() {
                // This is a late original status, never another provider start.
                let success = serde_json::json!({"version":1,"operationId":OP,"requestFingerprint":original.fingerprint,"provider":{"packageId":original.provider.package_id,"serviceId":"image-generation","major":1},"revision":2,"execution":{"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"fixture","requestedModel":null,"actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}},"delivery":{"state":"unavailable","reason":"storage_unavailable"}});
                super::super::service_bridge::reconcile_at(
                    &fx.store,
                    &original.provider,
                    &original,
                    &success,
                )
                .unwrap();
                let current = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
                let _permit = fx.store.output_recovery_guard(&current).unwrap();
                let stage = fx
                    .store
                    .stage(&original.provider, &original.consumer.package_id, OP)
                    .unwrap();
                image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
                    .save_with_format(stage.path, image::ImageFormat::Png)
                    .unwrap();
            }
            fx.act(&fx.store, Action::Upgrade, role, &Cell::new(0))
                .unwrap();
            drop(leases);
            let port = ReplacementDelivery {
                fx: &fx,
                recovered: Cell::new(0),
            };
            for _ in 0..2 {
                auto_reconcile_in(&fx.store, &port).unwrap();
            }
            let after = fx.store.get(fx.id(Role::Consumer), OP).unwrap().unwrap();
            let job = fx
                .store
                .job_for_operation(fx.id(Role::Consumer), OP)
                .unwrap()
                .unwrap();
            if phase == Phase::Prepared {
                assert!(fx
                    .store
                    .execution_released(fx.id(Role::Consumer), OP)
                    .unwrap());
            } else {
                assert_eq!(after.phase, AdmissionPhase::Released, "{role:?}/{phase:?}");
            }
            if expects_delivery {
                assert_eq!(
                    after.disposition.as_deref(),
                    Some("acquired"),
                    "{role:?}/{phase:?}"
                );
                assert_eq!(job.state, JobState::Completed, "{role:?}/{phase:?}");
                let delivered = image::open(job.output_path.unwrap()).unwrap().to_rgba8();
                assert_eq!(
                    delivered,
                    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
                );
                assert_eq!(port.recovered.get(), usize::from(phase != Phase::Acquired));
            } else {
                assert!(job.state.terminal(), "{role:?}/{phase:?}");
                assert_eq!(port.recovered.get(), 0);
            }
            assert_eq!(after.consumer, original.consumer);
            assert_eq!(after.provider, original.provider);
            assert!(fx.store.claims().unwrap().is_empty());
        }
    }
}
#[test]
fn invariant_a_removal_intent_finishes_before_or_after_index_publication() {
    for published in [false, true] {
        let fx = Fixture::new(&format!("durable-exit-{published}"));
        fx.enter(Phase::SucceededUnacknowledged);
        fx.present(crate::service_state::job::JobState::Running);
        let mut entries = package::list(&fx.root).unwrap();
        entries.retain(|p| p.manifest.id != fx.id(Role::Provider));
        let removal = super::Removal {
            entries,
            packages: vec![fx.id(Role::Provider).into()],
        };
        super::write_removal(&fx.root, &removal).unwrap();
        if published {
            package::write_index(&fx.root, &removal.entries).unwrap();
        }
        super::recover(&fx.root).unwrap();
        assert!(fx.installed(Role::Provider).is_none());
        assert!(fx.store.claims().unwrap().is_empty());
        let jobs = fx.store.snapshot_jobs().unwrap().jobs;
        assert_eq!(jobs.len(), 1);
        assert!(jobs[0]
            .error
            .as_ref()
            .unwrap()
            .starts_with("An image from "));
        super::recover(&fx.root).unwrap();
        assert_eq!(fx.store.snapshot_jobs().unwrap().jobs, jobs);
    }
}

#[test]
fn invariant_a_delayed_workers_cannot_create_custody_or_jobs_after_lifecycle_change() {
    use crate::service_state::job::*;
    for action in [Action::Disable, Action::Remove, Action::Upgrade] {
        let fx = Fixture::new(&format!("late-worker-{action:?}").to_lowercase());
        fx.enter(Phase::Accepted);
        let lease = backend::CallLease::acquire(fx.id(Role::Consumer)).unwrap();
        let admission = fx.admission();
        let old = fx.generation(Role::Consumer);
        let delayed = crate::service_state::job::JobRecord {
            job_key: "d".repeat(48),
            job_id: 94,
            owner: old.clone(),
            operation_id: "late-registration".into(),
            kind: "openai-image".into(),
            label: "AI image".into(),
            origin_window: "matrix".into(),
            revision: 0,
            source_revision: 0,
            ownership_epoch: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: None,
            output_path: None,
            cost: None,
            reveal: None,
            run_id: None,
            error: None,
        };
        let waiting = std::sync::Arc::new(std::sync::Barrier::new(2));
        let finished = waiting.clone();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                finished.wait();
                let store = Store::open(fx.profile.path().join("service-state"), Limits::default())
                    .unwrap();
                assert!(
                    store.register_job(delayed).is_err(),
                    "retired worker registered after removal sweep"
                );
                let mut late = admission;
                late.operation_id = "late-admission".into();
                assert!(
                    store.reserve(late).is_err(),
                    "retired worker recreated an admission"
                );
                assert!(
                    store
                        .capture(
                            &old,
                            "late-capture",
                            vec![CaptureInput {
                                path: fx.profile.path().join("input.png").to_string_lossy().into(),
                                expected_digest: None
                            }]
                        )
                        .is_err(),
                    "retired worker recreated input custody"
                );
            });
            fx.act(&fx.store, action, Role::Consumer, &Cell::new(0))
                .unwrap();
            waiting.wait();
            worker.join().unwrap();
        });
        drop(lease);
        assert!(fx
            .store
            .job_for_operation(fx.id(Role::Consumer), "late-registration")
            .unwrap()
            .is_none());
    }
}
#[test]
fn invariant_a_same_session_journal_retry_retires_admissions_after_failed_sweep() {
    let fx = Fixture::new("failed-removal-retirement");
    fx.enter(Phase::Accepted);
    fx.present(crate::service_state::job::JobState::Running);
    let delayed = backend::CallLease::acquire(fx.id(Role::Consumer)).unwrap();
    fx.store.fail_next_write();
    assert!(fx
        .act(&fx.store, Action::Disable, Role::Consumer, &Cell::new(0))
        .is_err());
    assert!(fx.root.join("removal-pending.json").is_file());
    assert!(backend::CallLease::acquire(fx.id(Role::Consumer)).is_err());
    super::recover(&fx.root).unwrap();
    assert!(!fx.installed(Role::Consumer).unwrap().enabled);
    assert!(fx.store.claims().unwrap().is_empty());
    assert!(fx
        .store
        .snapshot_jobs()
        .unwrap()
        .jobs
        .iter()
        .all(|j| j.state.terminal()));
    assert!(backend::call_admitted(
        fx.id(Role::Consumer),
        "jobs.start",
        serde_json::json!({"kind":"image"}),
        "main",
        std::time::SystemTime::now(),
        &delayed,
    )
    .unwrap_err()
    .to_string()
    .contains("lifecycle change"));
    let mut late = fx.admission();
    late.operation_id = "post-recovery-admission".into();
    assert!(fx.store.reserve(late).is_err());
    assert!(backend::CallLease::acquire(fx.id(Role::Consumer)).is_ok());
    assert!(!fx.root.join("removal-pending.json").exists());
}

#[test]
fn invariant_a_repeated_disable_releases_preparations_and_orphan_presentation() {
    let fx = Fixture::new("already-disabled");
    fx.enter(Phase::Accepted);
    fx.present(crate::service_state::job::JobState::Accepting);
    let mut entries = package::list(&fx.root).unwrap();
    entries
        .iter_mut()
        .find(|p| p.manifest.id == fx.id(Role::Consumer))
        .unwrap()
        .enabled = false;
    package::write_index(&fx.root, &entries).unwrap();
    let input = fx.profile.path().join("input.png");
    fx.store
        .capture(
            &fx.generation(Role::Consumer),
            "unadmitted",
            vec![CaptureInput {
                path: input.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    fx.act(&fx.store, Action::Disable, Role::Consumer, &Cell::new(0))
        .unwrap();
    assert!(fx.store.claims().unwrap().is_empty());
    assert!(!fx.store.busy(fx.id(Role::Consumer)).unwrap());
    assert!(fx.store.list_preparations().unwrap().is_empty());
    assert!(fx
        .store
        .snapshot_jobs()
        .unwrap()
        .jobs
        .iter()
        .all(|j| j.state.terminal()));
    assert!(fs::read_dir(fx.profile.path().join("service-state/bytes"))
        .unwrap()
        .next()
        .is_none());
}
#[test]
fn invariant_b_incompatible_provider_upgrade_disables_required_consumers_and_recovers_commit() {
    let fx = Fixture::new("incompatible-required");
    let mut index = package::list(&fx.root).unwrap();
    index
        .iter_mut()
        .find(|p| p.manifest.id == fx.id(Role::Consumer))
        .unwrap()
        .manifest
        .service_dependencies[0]
        .optional = false;
    package::write_index(&fx.root, &index).unwrap();
    fx.enter(Phase::SucceededUnacknowledged);
    fx.present(crate::service_state::job::JobState::Running);
    let archive = package::tests::archive_named(
        &fx.profile.path().join("archives"),
        "missing-service.teplugin",
        |m| {
            m.id = fx.id(Role::Provider).into();
            m.sdk_version = 3;
            m.version = "2.0.0".into();
            m.contributions = vec![fx.id(Role::Provider).replace('.', "-")];
        },
    );
    upgrade(
        &Profile {
            root: &fx.root,
            store: &fx.store,
        },
        &archive,
        &|_, _, _| Ok(()),
    )
    .unwrap();
    assert!(!fx.installed(Role::Consumer).unwrap().enabled);
    assert!(fx.store.claims().unwrap().is_empty());
    assert_eq!(fx.store.snapshot_jobs().unwrap().jobs.len(), 1);
    super::recover(&fx.root).unwrap();
    assert_eq!(fx.store.snapshot_jobs().unwrap().jobs.len(), 1);
}

#[path = "ai_operations_model_tests.rs"]
mod model_tests;
