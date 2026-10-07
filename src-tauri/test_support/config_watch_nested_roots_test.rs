//! Real inotify coverage of the production symlink-plan handover (#938).
#![cfg(target_os = "linux")]

use super::{
    config_watch_plan, map_event_paths, reconcile_watch_plan, PhaseRecorder, Registrations,
    WatchPlan, WatchRegistration,
};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Fail only the requested native operation, leaving event delivery real.
struct FaultWatcher {
    native: RecommendedWatcher,
    fail_registration: Option<PathBuf>,
    fail_removal_after_native: Option<PathBuf>,
}

impl WatchRegistration for FaultWatcher {
    type Error = notify::Error;

    fn register(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        if self.fail_registration.as_deref() == Some(path) {
            self.fail_registration = None;
            return Err(notify::Error::generic("injected restoration failure"));
        }
        self.native.watch(path, mode)
    }

    fn unregister(&mut self, path: &Path) -> notify::Result<()> {
        let result = WatchRegistration::unregister(&mut self.native, path);
        if self.fail_removal_after_native.as_deref() == Some(path) {
            self.fail_removal_after_native = None;
            return Err(notify::Error::generic("injected partial removal failure"));
        }
        result
    }

    fn unregister_removes_descendants(&self) -> bool {
        self.native.unregister_removes_descendants()
    }
}

struct Fixture {
    registrations: Registrations<FaultWatcher>,
    plan: Arc<Mutex<WatchPlan>>,
    received: mpsc::Receiver<(String, PathBuf)>,
    config: PathBuf,
    dots: PathBuf,
    _temp: tempfile::TempDir,
}

impl Fixture {
    fn new(config_inside_dots: bool, themes: bool) -> Self {
        let temp = tempfile::tempdir().expect("watcher tree");
        let dots = temp.path().join("dots");
        let config = if config_inside_dots {
            dots.join("config")
        } else {
            temp.path().join("config")
        };
        for root in [&config, &dots.join("sub"), &dots.join("theme-target")] {
            std::fs::create_dir_all(root).expect("fixture root");
        }
        for root in [&dots, &dots.join("sub")] {
            std::fs::write(root.join("settings.json"), "{}").expect("settings target");
        }
        symlink(dots.join("settings.json"), config.join("settings.json")).expect("settings link");
        if themes {
            std::fs::write(dots.join("theme-target/custom.css"), "initial").expect("theme target");
            symlink(dots.join("theme-target"), config.join("themes")).expect("themes link");
        }
        let initial = config_watch_plan(&config);
        let external_roots = initial.external_roots.iter().cloned().collect();
        let plan = Arc::new(Mutex::new(initial));
        let callback_plan = Arc::clone(&plan);
        let (sent, received) = mpsc::channel();
        let mut native =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let event = result.expect("native watcher event");
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                for change in map_event_paths(&callback_plan, &event.paths) {
                    let _ = sent.send(change);
                }
            })
            .expect("native watcher");
        native
            .watch(&config, RecursiveMode::Recursive)
            .expect("config watch");
        for (root, mode) in &plan.lock().expect("initial plan").external_roots {
            native.watch(root, *mode).expect("external watch");
        }
        Self {
            registrations: Registrations {
                watcher: FaultWatcher {
                    native,
                    fail_registration: None,
                    fail_removal_after_native: None,
                },
                external_roots,
                config_root_needs_restore: false,
            },
            plan,
            received,
            config,
            dots,
            _temp: temp,
        }
    }

    fn refresh(&mut self) {
        // Drive the same operation as the two-second production worker
        // synchronously: an ancestor still watching must not yield a false
        // positive before handover has actually removed it.
        reconcile_watch_plan(
            config_watch_plan(&self.config),
            &self.plan,
            &mut self.registrations,
            &PhaseRecorder::default(),
        );
        while self.received.try_recv().is_ok() {}
    }

    fn retarget(&mut self) {
        let link = self.config.join("settings.json");
        let replacement = self.config.join("replacement-link");
        symlink(self.dots.join("sub/settings.json"), &replacement).expect("replacement link");
        std::fs::rename(replacement, link).expect("atomic retarget");
        self.refresh();
    }

    fn assert_write_reported(&self, target: &Path, expected: &str) {
        let canonical = std::fs::canonicalize(target).expect("canonical target");
        std::fs::write(&canonical, "external edit after completed handover").expect("target write");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.received.recv_timeout(remaining) {
                Ok((name, source)) if source == canonical => {
                    assert_eq!(name, expected);
                    return;
                }
                Ok(_) => continue,
                Err(error) => panic!(
                    "canonical write to {} was not reported as {expected}: {error}",
                    canonical.display()
                ),
            }
        }
    }

    fn assert_retired_target_filtered(&self) {
        std::fs::write(self.dots.join("settings.json"), "retired edit").expect("old target write");
        // The next config-dir event is an ordered barrier for retired writes.
        let sentinel = self.config.join("bookmarks.json");
        std::fs::write(&sentinel, "[]").expect("sentinel write");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (name, source) = self
                .received
                .recv_timeout(remaining)
                .expect("sentinel receipt");
            assert_ne!(
                source,
                self.dots.join("settings.json"),
                "retired target reported"
            );
            if source == sentinel {
                assert_eq!(name, "bookmarks.json");
                return;
            }
        }
    }
}

#[test]
fn nested_settings_retarget_keeps_canonical_write_callbacks() {
    let mut fixture = Fixture::new(false, false);
    fixture.assert_write_reported(&fixture.dots.join("settings.json"), "settings.json");
    fixture.retarget();
    fixture.assert_write_reported(&fixture.dots.join("sub/settings.json"), "settings.json");
    fixture.assert_retired_target_filtered();
}

#[test]
fn ancestor_retirement_preserves_themes_and_nested_config_directory() {
    let mut fixture = Fixture::new(true, true);
    std::fs::write(fixture.config.join("bookmarks.json"), "[]").expect("bookmarks");
    fixture.retarget();
    fixture.assert_write_reported(
        &fixture.dots.join("theme-target/custom.css"),
        "themes/custom.css",
    );
    fixture.assert_write_reported(&fixture.config.join("bookmarks.json"), "bookmarks.json");
    fixture.assert_retired_target_filtered();
}

#[test]
fn failed_surviving_theme_restoration_is_retried() {
    let mut fixture = Fixture::new(false, true);
    fixture.registrations.watcher.fail_registration = Some(fixture.dots.join("theme-target"));
    fixture.retarget();
    fixture.refresh();
    fixture.assert_write_reported(
        &fixture.dots.join("theme-target/custom.css"),
        "themes/custom.css",
    );
    fixture.assert_write_reported(&fixture.dots.join("sub/settings.json"), "settings.json");
    fixture.assert_retired_target_filtered();
}

#[test]
fn failed_config_directory_restoration_is_retried() {
    let mut fixture = Fixture::new(true, false);
    std::fs::write(fixture.config.join("bookmarks.json"), "[]").expect("bookmarks");
    fixture.registrations.watcher.fail_registration = Some(fixture.config.clone());
    fixture.retarget();
    fixture.refresh();
    fixture.assert_write_reported(&fixture.config.join("bookmarks.json"), "bookmarks.json");
    fixture.assert_write_reported(&fixture.dots.join("sub/settings.json"), "settings.json");
}

#[test]
fn partial_ancestor_removal_error_preserves_surviving_callbacks() {
    let mut fixture = Fixture::new(true, true);
    fixture.registrations.watcher.fail_removal_after_native = Some(fixture.dots.clone());
    fixture.retarget();
    fixture.assert_write_reported(&fixture.dots.join("sub/settings.json"), "settings.json");
    fixture.assert_write_reported(
        &fixture.dots.join("theme-target/custom.css"),
        "themes/custom.css",
    );
    fixture.refresh();
    fixture.assert_retired_target_filtered();
}
