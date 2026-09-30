//! Contracts of the one admitted-execute seam, on a real temp-dir runtime.
use super::*;

#[test]
fn only_completed_or_uncertain_results_count_as_changed() {
    assert!(changed(&Ok::<(), AppError>(())));
    assert!(changed(&Err::<(), _>(AppError::WorkerFailed(
        "lost".into()
    ))));
    assert!(changed(&Err::<(), _>(AppError::MutationUncertain(
        "partial".into()
    ))));
    for unchanged in [
        AppError::NotFound("missing".into()),
        AppError::AlreadyExists("occupied".into()),
        AppError::InvalidPath("bad".into()),
        AppError::Other("refused".into()),
    ] {
        assert!(!changed(&Err::<(), _>(unchanged)));
    }
}

#[test]
fn retirement_failures_keep_each_operations_warning_text() {
    let lost = || AppError::Other("lost".into());
    let mut moved = <super::super::move_execution::Outcome as Settle>::refused(lost());
    moved.unretired(lost());
    assert_eq!(
        moved.completion.warning.as_deref(),
        Some("Move finished, but its ownership record could not be retired: lost")
    );

    let mut batch: Result<_, AppError> = Ok(crate::files::trash::FileBatchOutcome {
        worker_error: Some("partial".into()),
        ..Default::default()
    });
    batch.unretired(lost());
    assert_eq!(
        batch.unwrap().worker_error.as_deref(),
        Some("partial; File operation finished, but ownership cleanup failed: lost")
    );
    let mut refused = <Result<crate::files::trash::FileBatchOutcome, _> as Settle>::refused(lost());
    refused.unretired(AppError::Other("other".into()));
    assert_eq!(refused.unwrap_err().to_string(), "lost");
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::*;
    use crate::files::recovery::{Access, ResourceRequest, Scope};
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
    };

    fn write(path: &Path) -> Vec<ResourceRequest> {
        vec![ResourceRequest {
            path: path.to_owned(),
            access: Access::Write,
            scope: Scope::Subtree,
        }]
    }

    fn block<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    /// User entries and recovery storage live in separate temp trees: the
    /// recovery root and its ancestors are protected resources.
    struct Fixture {
        files: tempfile::TempDir,
        storage: tempfile::TempDir,
        runtime: Runtime,
    }

    fn fixture() -> Fixture {
        let storage = tempfile::tempdir().unwrap();
        Fixture {
            files: tempfile::tempdir().unwrap(),
            runtime: Runtime::new(storage.path().join("recovery")),
            storage,
        }
    }

    impl Fixture {
        fn target(&self) -> PathBuf {
            self.files.path().join("target")
        }

        fn claimable(&self, path: &Path) -> bool {
            block(self.runtime.admit(write(path)))
                .map(|admission| admission.finish().unwrap())
                .is_ok()
        }

        /// Make the next retirement fail without disturbing held claims.
        fn break_retirement(&self) -> impl FnOnce() + Send + 'static {
            let storage = self.storage.path().join("recovery");
            move || fs::rename(storage.join("admission.lock"), storage.join("moved.lock")).unwrap()
        }
    }

    struct Probe {
        target: PathBuf,
        bind: Option<Box<dyn FnOnce() -> Result<(), AppError> + Send>>,
    }

    impl Plan for Probe {
        fn resources(&self) -> Vec<ResourceRequest> {
            write(&self.target)
        }

        fn resolve(mut self, _: impl Iterator<Item = PathBuf>) -> Result<Self, AppError> {
            match self.bind.take() {
                Some(bind) => bind().map(|()| self),
                None => Ok(self),
            }
        }
    }

    #[derive(Debug, Default)]
    struct Report {
        executed: bool,
        refused: Option<String>,
        unretired: Vec<String>,
    }

    impl Settle for Report {
        fn refused(error: AppError) -> Self {
            Self {
                refused: Some(error.to_string()),
                ..Self::default()
            }
        }

        fn unretired(&mut self, error: AppError) {
            self.unretired.push(error.to_string());
        }
    }

    fn run(f: &Fixture, plan: Probe, during: impl FnOnce(Owner) + Send + 'static) -> Report {
        block(admitted_execute(
            plan,
            &f.runtime,
            |_plan, owner| async move {
                during(owner);
                Report {
                    executed: true,
                    ..Report::default()
                }
            },
        ))
    }

    fn probe(f: &Fixture) -> Probe {
        Probe {
            target: f.target(),
            bind: None,
        }
    }

    #[test]
    fn a_held_claim_refuses_the_plan_without_dispatching_work() {
        let f = fixture();
        let held = block(f.runtime.admit(write(&f.target()))).unwrap();
        let report = run(&f, probe(&f), |_| panic!("refused work must not run"));
        assert!(!report.executed);
        assert!(report
            .refused
            .unwrap()
            .starts_with("Could not acquire file operation ownership"));
        assert!(report.unretired.is_empty());
        held.finish().unwrap();
        assert!(f.claimable(&f.target()));
    }

    #[test]
    fn work_holds_its_claim_until_it_returns_then_retires_it() {
        let f = fixture();
        let runtime = f.runtime.clone();
        let target = f.target();
        let report: Report = block(admitted_execute(probe(&f), &f.runtime, |_, _| async move {
            Report {
                // A competing writer is refused while the work runs.
                executed: runtime.admit(write(&target)).await.is_err(),
                ..Report::default()
            }
        }));
        assert!(report.executed && report.refused.is_none() && report.unretired.is_empty());
        assert!(f.claimable(&f.target()), "completion retires the claim");
    }

    #[test]
    fn a_binding_failure_is_refused_and_retires_its_admission() {
        let f = fixture();
        let mut plan = probe(&f);
        plan.bind = Some(Box::new(|| Err(AppError::InvalidPath("rebound".into()))));
        let report = run(&f, plan, |_| panic!("an unbound plan must not run"));
        assert_eq!(report.refused.as_deref(), Some("Invalid path: rebound"));
        assert!(report.unretired.is_empty());
        assert!(
            f.claimable(&f.target()),
            "a refused binding must not strand its claim"
        );

        let mut plan = probe(&f);
        let displace = f.break_retirement();
        plan.bind = Some(Box::new(move || {
            displace();
            Err(AppError::InvalidPath("rebound".into()))
        }));
        let report = run(&f, plan, |_| panic!("an unbound plan must not run"));
        assert_eq!(report.refused.as_deref(), Some("Invalid path: rebound"));
        assert_eq!(report.unretired.len(), 1, "{report:?}");
    }

    #[test]
    fn an_owner_outliving_the_work_is_a_retirement_diagnostic_not_an_error() {
        let f = fixture();
        let leaked = Arc::new(Mutex::new(None));
        let keep = Arc::clone(&leaked);
        let report = run(&f, probe(&f), move |owner| {
            *keep.lock().unwrap() = Some(owner);
        });
        assert!(report.executed && report.refused.is_none());
        assert_eq!(report.unretired.len(), 1, "{report:?}");
        assert!(report.unretired[0].contains("still owns"));
        assert!(
            !f.claimable(&f.target()),
            "an outstanding owner keeps the claim"
        );
        drop(leaked.lock().unwrap().take());
    }

    #[test]
    fn prepared_admission_refuses_before_work_and_retires_after_it() {
        let f = fixture();
        let refused: Report = block(admitted_prepared(
            &f.runtime,
            || Err::<((), _), _>(AppError::Other("preparation failed".into())),
            |(), _| async { panic!("refused work must not run") },
        ));
        assert_eq!(
            refused.refused.as_deref(),
            Some("Could not acquire file operation ownership: preparation failed")
        );

        let resources =
            crate::files::recovery::resources::capture_requests(&write(&f.target())).unwrap();
        let runtime = f.runtime.clone();
        let target = f.target();
        let report: Report = block(admitted_prepared(
            &f.runtime,
            move || Ok(((), resources.clone())),
            |(), _owner| async move {
                Report {
                    executed: runtime.admit(write(&target)).await.is_err(),
                    ..Report::default()
                }
            },
        ));
        assert!(report.executed, "the prepared claims are held during work");
        assert!(report.unretired.is_empty());
        assert!(f.claimable(&f.target()));
    }
}
