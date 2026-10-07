//! Returning to a root with uncertain native cleanup must establish coverage.
use super::{
    map_event_paths, reconcile_watch_plan, PhaseRecorder, Registrations, WatchPlan,
    WatchRegistration,
};
use notify::RecursiveMode;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

struct Backend {
    active: Vec<PathBuf>,
    fail_removal: Option<(PathBuf, bool)>,
    fail_registration: Option<PathBuf>,
    cascades: bool,
}

impl WatchRegistration for Backend {
    type Error = &'static str;

    fn register(&mut self, root: &Path, _mode: RecursiveMode) -> Result<(), Self::Error> {
        if self.fail_registration.as_deref() == Some(root) {
            self.fail_registration = None;
            return Err("registration failed");
        }
        if self.cascades {
            self.active.retain(|existing| existing != root);
        }
        self.active.push(root.to_path_buf());
        Ok(())
    }

    fn unregister(&mut self, root: &Path) -> Result<(), Self::Error> {
        if self
            .fail_removal
            .as_ref()
            .is_some_and(|(failed, _)| failed == root)
        {
            let (_, after_native) = self.fail_removal.take().expect("injected failure");
            if after_native {
                self.remove_native(root);
            }
            return Err("ambiguous native removal failure");
        }
        self.remove_native(root);
        Ok(())
    }

    fn unregister_removes_descendants(&self) -> bool {
        self.cascades
    }
}

impl Backend {
    fn remove_native(&mut self, root: &Path) {
        // An already-absent inotify ancestor does not remove live children.
        if self.active.iter().any(|existing| existing == root) {
            self.active.retain(|existing| {
                existing != root && !(self.cascades && existing.starts_with(root))
            });
        }
    }

    fn write_callbacks(&self, plan: &Mutex<WatchPlan>, target: &Path) -> Vec<String> {
        std::fs::write(target, "canonical edit after refresh").expect("canonical target write");
        let owners = self
            .active
            .iter()
            .filter(|root| target.starts_with(root))
            .count();
        // inotify registrations share native descendant coverage; exact-root
        // backends allocate independent callback owners for repeated watches.
        let events = if self.cascades {
            usize::from(owners > 0)
        } else {
            owners
        };
        (0..events)
            .flat_map(|_| map_event_paths(plan, &[target.to_path_buf()]))
            .map(|(name, _)| name)
            .collect()
    }
}

fn plan(config: &Path, target: &Path) -> WatchPlan {
    WatchPlan {
        config_dir: config.to_path_buf(),
        external_roots: vec![(
            target.parent().expect("target root").to_path_buf(),
            RecursiveMode::Recursive,
        )],
        external_files: HashMap::from([(target.to_path_buf(), "settings.json".into())]),
        external_themes_dir: None,
    }
}

fn target(root: &Path) -> PathBuf {
    std::fs::create_dir_all(root).expect("target directory");
    let target = root.join("settings.json");
    std::fs::write(&target, "initial").expect("settings target");
    std::fs::canonicalize(target).expect("canonical target")
}

fn refresh(target: &Path, current: &Mutex<WatchPlan>, registrations: &mut Registrations<Backend>) {
    let config = current.lock().expect("plan").config_dir.clone();
    reconcile_watch_plan(
        plan(&config, target),
        current,
        registrations,
        &PhaseRecorder::default(),
    );
}

#[test]
fn returning_to_ambiguously_retired_root_restores_exactly_one_callback() {
    for after_native in [true, false] {
        let temp = tempfile::tempdir().expect("config tree");
        let first = target(&temp.path().join("a"));
        let second = target(&temp.path().join("b"));
        let root = first.parent().expect("first root").to_path_buf();
        let initial = plan(&temp.path().join("config"), &first);
        let mut registrations = Registrations::new(
            Backend {
                active: vec![root.clone()],
                fail_removal: Some((root, after_native)),
                fail_registration: None,
                cascades: false,
            },
            initial.external_roots.iter().cloned().collect(),
        );
        let current = Mutex::new(initial);
        refresh(&second, &current, &mut registrations);
        refresh(&first, &current, &mut registrations);
        assert_eq!(
            registrations.watcher.write_callbacks(&current, &first),
            ["settings.json"],
            "return after removal failure (after native = {after_native})"
        );
        assert!(registrations
            .watcher
            .write_callbacks(&current, &second)
            .is_empty());
        // A later refresh must neither remove nor duplicate the recovered root.
        refresh(&first, &current, &mut registrations);
        assert_eq!(
            registrations.watcher.write_callbacks(&current, &first),
            ["settings.json"]
        );
    }
}

#[test]
fn returning_root_cleanup_failure_keeps_previous_callbacks_until_retry() {
    let temp = tempfile::tempdir().expect("config tree");
    let first = target(&temp.path().join("a"));
    let second = target(&temp.path().join("b"));
    let root = first.parent().expect("first root").to_path_buf();
    let initial = plan(&temp.path().join("config"), &first);
    let mut registrations = Registrations::new(
        Backend {
            active: vec![root.clone()],
            fail_removal: Some((root.clone(), true)),
            fail_registration: None,
            cascades: false,
        },
        initial.external_roots.iter().cloned().collect(),
    );
    let current = Mutex::new(initial);
    refresh(&second, &current, &mut registrations);
    registrations.watcher.fail_removal = Some((root, false));
    refresh(&first, &current, &mut registrations);
    assert_eq!(
        registrations.watcher.write_callbacks(&current, &second),
        ["settings.json"]
    );
    refresh(&first, &current, &mut registrations);
    assert_eq!(
        registrations.watcher.write_callbacks(&current, &first),
        ["settings.json"]
    );
}

#[test]
fn failed_return_registration_restores_previous_descendant_callbacks() {
    let temp = tempfile::tempdir().expect("config tree");
    let first = target(&temp.path().join("a"));
    let second = target(&temp.path().join("a/sub"));
    let root = first.parent().expect("first root").to_path_buf();
    let initial = plan(&temp.path().join("config"), &first);
    let mut registrations = Registrations::new(
        Backend {
            active: vec![root.clone()],
            fail_removal: Some((root.clone(), false)),
            fail_registration: None,
            cascades: true,
        },
        initial.external_roots.iter().cloned().collect(),
    );
    let current = Mutex::new(initial);
    refresh(&second, &current, &mut registrations);
    registrations.watcher.fail_registration = Some(root);
    refresh(&first, &current, &mut registrations);
    assert_eq!(
        registrations.watcher.write_callbacks(&current, &second),
        ["settings.json"]
    );
    refresh(&first, &current, &mut registrations);
    assert_eq!(
        registrations.watcher.write_callbacks(&current, &first),
        ["settings.json"]
    );
}
