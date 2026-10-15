//! Backend contract coverage for the independent review's two findings (#938).
use super::{
    map_event_paths, reconcile_watch_plan, PhaseRecorder, Registrations, WatchPlan,
    WatchRegistration,
};
use notify::RecursiveMode;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Exact-root backends allocate a fresh callback owner on every registration.
/// Cascading backends share descendant coverage and can fail partway through
/// removal, leaving native child watches alive after forgetting the parent.
struct Backend {
    roots: Vec<PathBuf>,
    cascades: bool,
    fail_once: HashSet<PathBuf>,
    partial_parent: Option<PathBuf>,
}

impl WatchRegistration for Backend {
    type Error = &'static str;

    fn register(&mut self, path: &Path, _mode: RecursiveMode) -> Result<(), Self::Error> {
        if self.cascades {
            self.roots.retain(|root| root != path);
        }
        self.roots.push(path.to_path_buf());
        Ok(())
    }

    fn unregister(&mut self, path: &Path) -> Result<(), Self::Error> {
        if self.fail_once.remove(path) {
            if self.partial_parent.as_deref() == Some(path) {
                self.roots.retain(|root| root != path);
            }
            return Err("native removal failed before descendants were removed");
        }
        // Like inotify, an absent root does not remove any remaining children.
        if !self.roots.iter().any(|root| root == path) {
            return Ok(());
        }
        self.roots
            .retain(|root| root != path && !(self.cascades && root.starts_with(path)));
        Ok(())
    }

    fn unregister_removes_descendants(&self) -> bool {
        self.cascades
    }
}

impl Backend {
    fn callbacks_for(&self, plan: &Mutex<WatchPlan>, changed: &Path) -> Vec<String> {
        self.roots
            .iter()
            .filter(|root| changed.starts_with(root))
            .flat_map(|_| map_event_paths(plan, &[changed.to_path_buf()]))
            .map(|(name, _)| name)
            .collect()
    }
}

fn plan(config: &Path, settings: &Path, themes: &Path) -> WatchPlan {
    WatchPlan {
        config_dir: config.to_path_buf(),
        external_roots: vec![
            (
                settings.parent().expect("settings parent").to_path_buf(),
                RecursiveMode::Recursive,
            ),
            (themes.to_path_buf(), RecursiveMode::Recursive),
        ],
        external_files: HashMap::from([(settings.to_path_buf(), "settings.json".into())]),
        external_themes_dir: Some(themes.to_path_buf()),
    }
}

fn create_dir(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).expect("test directory");
    std::fs::canonicalize(path).expect("canonical directory")
}

fn create_file(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    std::fs::write(&path, "initial").expect("test config file");
    path
}

#[test]
fn exact_root_backend_keeps_one_callback_owner_per_surviving_root() {
    let temp = tempfile::tempdir().expect("config tree");
    let dots = create_dir(&temp.path().join("dots"));
    let config = create_dir(&dots.join("config"));
    let nested = create_dir(&dots.join("sub"));
    let themes = create_dir(&dots.join("themes-target"));
    let old_file = create_file(&dots, "settings.json");
    let new_file = create_file(&nested, "settings.json");
    let theme = create_file(&themes, "custom.css");
    let bookmarks = create_file(&config, "bookmarks.json");
    let initial = plan(&config, &old_file, &themes);
    let mut registrations = Registrations::new(
        Backend {
            roots: vec![config.clone(), dots, themes.clone()],
            cascades: false,
            fail_once: HashSet::new(),
            partial_parent: None,
        },
        initial.external_roots.iter().cloned().collect(),
    );
    let current = Mutex::new(initial);
    reconcile_watch_plan(
        plan(&config, &new_file, &themes),
        &current,
        &mut registrations,
        &PhaseRecorder::default(),
    );

    for (target, expected) in [
        (&new_file, "settings.json"),
        (&theme, "themes/custom.css"),
        (&bookmarks, "bookmarks.json"),
    ] {
        std::fs::write(target, "after handover").expect("canonical write");
        assert_eq!(
            registrations.watcher.callbacks_for(&current, target),
            [expected],
            "exact-root retirement must not duplicate native callback owners"
        );
    }
}

#[test]
fn partial_ancestor_removal_keeps_obsolete_child_cleanup_obligations() {
    let temp = tempfile::tempdir().expect("config tree");
    let config = create_dir(&temp.path().join("config"));
    let dots = create_dir(&temp.path().join("dots"));
    let stale = create_dir(&dots.join("stale"));
    let new = create_dir(&temp.path().join("new"));
    let new_themes = create_dir(&new.join("themes"));
    let old_file = create_file(&dots, "settings.json");
    let old_theme = create_file(&stale, "custom.css");
    let new_file = create_file(&new, "settings.json");
    let initial = plan(&config, &old_file, &stale);
    let mut registrations = Registrations::new(
        Backend {
            roots: vec![config.clone(), dots.clone(), stale.clone()],
            cascades: true,
            // Both roots fail once, so the partial-removal result is the same
            // regardless of HashMap cleanup order.
            fail_once: HashSet::from([dots.clone(), stale]),
            partial_parent: Some(dots.clone()),
        },
        initial.external_roots.iter().cloned().collect(),
    );
    let current = Mutex::new(initial);
    for _ in 0..2 {
        reconcile_watch_plan(
            plan(&config, &new_file, &new_themes),
            &current,
            &mut registrations,
            &PhaseRecorder::default(),
        );
    }

    assert!(
        registrations
            .watcher
            .roots
            .iter()
            .all(|root| !root.starts_with(&dots)),
        "cleanup retry must release every obsolete native callback owner"
    );
    assert_eq!(
        registrations.watcher.callbacks_for(&current, &new_file),
        ["settings.json"]
    );
    assert!(registrations
        .watcher
        .callbacks_for(&current, &old_theme)
        .is_empty());
}
