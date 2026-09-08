use super::{run, BatchPlan};
use crate::error::AppError;
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn plan(paths: &[&Path]) -> BatchPlan {
    BatchPlan::new(paths.iter().map(|path| path_string(path)).collect()).unwrap()
}

#[test]
fn pooled_setup_context_stays_on_its_worker_and_preserves_effects_after_a_later_panic() {
    struct LocalContext {
        worker: std::thread::ThreadId,
        cleanup: std::rc::Rc<std::path::PathBuf>,
    }
    impl Drop for LocalContext {
        fn drop(&mut self) {
            assert_eq!(self.worker, std::thread::current().id());
            fs::write(self.cleanup.as_ref(), b"cleanup finished").unwrap();
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let active = dir.path().join("active");
    let last = dir.path().join("last");
    let created = dir.path().join("created");
    let cleanup = dir.path().join("cleanup");
    for path in [&first, &active, &last] {
        fs::write(path, b"original").unwrap();
    }
    let context_cleanup = cleanup.clone();
    let active_path = path_string(&active);
    let create_path = created.clone();
    let caller = std::thread::current().id();
    let outcome = tauri::async_runtime::block_on(super::run_with_setup_owned(
        (),
        plan(&[&first, &active, &last]),
        move |_| {
            let worker = std::thread::current().id();
            assert_ne!(worker, caller);
            Ok(LocalContext {
                worker,
                cleanup: std::rc::Rc::new(context_cleanup),
            })
        },
        move |context, path, effects| {
            assert_eq!(context.worker, std::thread::current().id());
            if path == active_path {
                effects.before_create(&create_path)?;
                fs::create_dir(&create_path)?;
                panic!("after auxiliary directory creation");
            }
            fs::remove_file(path)?;
            Ok(Default::default())
        },
    ))
    .unwrap();
    assert_eq!(outcome.succeeded, [path_string(&first)]);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert_eq!(outcome.unstarted, [path_string(&last)]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.refresh_dirs.contains(&path_string(&created)));
    assert!(outcome.refresh_dirs.contains(&path_string(dir.path())));
    assert!(!first.exists());
    assert_eq!(fs::read(active).unwrap(), b"original");
    assert_eq!(fs::read(last).unwrap(), b"original");
    assert!(created.is_dir());
    assert_eq!(fs::read(cleanup).unwrap(), b"cleanup finished");
}

#[test]
fn exact_receipts_survive_later_worker_panic_and_never_serialize_to_the_renderer() {
    use crate::files::trash_artifact::{TrashArtifact, TrashSuccess};
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    let first_path = path_string(&first);
    let expected = Arc::new(TrashArtifact::WindowsShell {
        parsing_name_utf16: vec![65, 66],
    });
    let receipt = expected.clone();
    let succeeded = first_path.clone();
    let outcome = tauri::async_runtime::block_on(super::run_with_receipts(
        plan(&[&first, &second]),
        move |path, _| {
            if path != succeeded {
                panic!("worker exited after an earlier exact receipt");
            }
            Ok(TrashSuccess {
                publication: None,
                artifact: Some(receipt.clone()),
                warning: None,
            })
        },
    ));
    assert_eq!(outcome.artifacts.get(&first_path), Some(&expected));
    assert_eq!(outcome.succeeded, std::slice::from_ref(&first_path));
    assert_eq!(outcome.uncertain[0].path, path_string(&second));
    let wire = serde_json::to_value(&outcome).unwrap();
    assert!(wire.get("artifacts").is_none());
    assert_eq!(wire["succeeded"][0], first_path);
}

#[test]
fn oversized_receipt_is_a_committed_warning_and_later_items_still_run() {
    use crate::files::trash_artifact::{TrashArtifact, TrashSuccess};
    let dir = tempfile::tempdir().unwrap();
    let paths = [dir.path().join("large"), dir.path().join("small")];
    let large = path_string(&paths[0]);
    let outcome = tauri::async_runtime::block_on(super::run_with_receipts(
        plan(&[&paths[0], &paths[1]]),
        move |path, _| {
            Ok(TrashSuccess {
                publication: None,
                artifact: Some(Arc::new(TrashArtifact::WindowsShell {
                    parsing_name_utf16: vec![65; if path == large { 16 * 1024 * 1024 } else { 2 }],
                })),
                warning: None,
            })
        },
    ));
    assert_eq!(
        outcome.succeeded,
        paths
            .iter()
            .map(|path| path_string(path))
            .collect::<Vec<_>>()
    );
    assert!(
        outcome.failed.is_empty() && outcome.uncertain.is_empty() && outcome.unstarted.is_empty()
    );
    assert!(!outcome.artifacts.contains_key(&path_string(&paths[0])));
    assert!(outcome.artifacts.contains_key(&path_string(&paths[1])));
    assert_eq!(outcome.warnings.len(), 1);
    assert_eq!(outcome.warnings[0].path, path_string(&paths[0]));
    assert!(outcome.error().unwrap().contains("batch memory budget"));
}

#[cfg(unix)]
#[test]
fn trash_and_restored_publications_share_a_budget_without_losing_successes() {
    use crate::files::{
        file_identity,
        mutation::PublishedEntry,
        trash_artifact::{TrashArtifact, TrashSuccess},
    };
    let dir = tempfile::tempdir().unwrap();
    let paths = [
        dir.path().join("trash"),
        dir.path().join("large-publication"),
        dir.path().join("small-publication"),
    ];
    fs::write(&paths[2], "restored bytes").unwrap();
    let small = Arc::new(PublishedEntry {
        path: paths[2].clone(),
        parent: file_identity::from_metadata(&fs::metadata(dir.path()).unwrap()),
        version: file_identity::version_from_metadata(&fs::symlink_metadata(&paths[2]).unwrap())
            .unwrap(),
    });
    let mut large = (*small).clone();
    large.path = paths[1].clone();
    large.path.reserve(20 * 1024 * 1024);
    let large = Arc::new(large);
    let artifact = Arc::new(TrashArtifact::WindowsShell {
        parsing_name_utf16: vec![65; 10 * 1024 * 1024],
    });
    let first = path_string(&paths[0]);
    let second = path_string(&paths[1]);
    let expected = small.clone();
    let outcome = tauri::async_runtime::block_on(super::run_with_receipts(
        plan(&[&paths[0], &paths[1], &paths[2]]),
        move |path, _| {
            Ok(if path == first {
                TrashSuccess {
                    artifact: Some(artifact.clone()),
                    ..Default::default()
                }
            } else {
                TrashSuccess {
                    publication: Some(if path == second {
                        large.clone()
                    } else {
                        small.clone()
                    }),
                    ..Default::default()
                }
            })
        },
    ));
    assert_eq!(
        outcome.succeeded,
        paths
            .iter()
            .map(|path| path_string(path))
            .collect::<Vec<_>>()
    );
    assert!(outcome.failure_message().is_none());
    assert!(outcome.artifacts.contains_key(&path_string(&paths[0])));
    assert!(!outcome.publications.contains_key(&path_string(&paths[1])));
    assert_eq!(
        outcome.publications.get(&path_string(&paths[2])),
        Some(&expected)
    );
    assert_eq!(outcome.warnings.len(), 1);
    assert_eq!(outcome.warnings[0].path, path_string(&paths[1]));
    assert!(serde_json::to_value(outcome)
        .unwrap()
        .get("publications")
        .is_none());
}

#[test]
fn worker_panic_preserves_settled_effects_and_marks_only_the_active_item_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let active = dir.path().join("active.txt");
    let unstarted = dir.path().join("unstarted.txt");
    fs::write(&first, b"first bytes").unwrap();
    fs::write(&active, b"active bytes").unwrap();
    fs::write(&unstarted, b"unstarted bytes").unwrap();
    let first_path = path_string(&first);
    let active_path = path_string(&active);

    let outcome =
        tauri::async_runtime::block_on(run(plan(&[&first, &active, &unstarted]), move |path| {
            fs::remove_file(path)?;
            if path == active_path {
                panic!("injected worker panic after active mutation");
            }
            assert_eq!(path, first_path);
            Ok(())
        }));

    assert_eq!(outcome.succeeded, [path_string(&first)]);
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert!(outcome.uncertain[0].error.contains("injected worker panic"));
    assert_eq!(outcome.unstarted, [path_string(&unstarted)]);
    assert_eq!(
        outcome.affected_paths().cloned().collect::<Vec<_>>(),
        [path_string(&first), path_string(&active)]
    );
    assert!(!first.exists());
    assert!(!active.exists());
    assert_eq!(fs::read(&unstarted).unwrap(), b"unstarted bytes");
}

#[test]
fn ordinary_preflight_failure_does_not_prevent_later_items_from_committing() {
    let dir = tempfile::tempdir().unwrap();
    let rejected = dir.path().join("rejected.txt");
    let later = dir.path().join("later.txt");
    fs::write(&rejected, b"unchanged bytes").unwrap();
    fs::write(&later, b"later bytes").unwrap();
    let rejected_path = path_string(&rejected);

    let outcome = tauri::async_runtime::block_on(run(plan(&[&rejected, &later]), move |path| {
        if path == rejected_path {
            return Err(AppError::AlreadyExists(path.into()));
        }
        fs::remove_file(path)?;
        Ok(())
    }));

    assert_eq!(outcome.succeeded, [path_string(&later)]);
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, path_string(&rejected));
    assert!(outcome.failed[0].error.contains("already exists"));
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
    assert_eq!(fs::read(&rejected).unwrap(), b"unchanged bytes");
    assert!(!later.exists());
}

#[test]
fn typed_uncertainty_stops_after_the_partial_effect_and_preserves_exact_sibling_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let active = dir.path().join("active");
    let removed = active.join("removed.txt");
    let retained = active.join("retained.txt");
    let unstarted = dir.path().join("unstarted.txt");
    fs::create_dir(&active).unwrap();
    fs::write(&removed, b"remove me").unwrap();
    fs::write(&retained, b"retain these exact bytes").unwrap();
    fs::write(&unstarted, b"never touched").unwrap();
    let active_path = path_string(&active);

    let outcome = tauri::async_runtime::block_on(run(plan(&[&active, &unstarted]), move |path| {
        if path == active_path {
            fs::remove_file(Path::new(path).join("removed.txt"))?;
            return Err(AppError::MutationUncertain(
                "directory removal stopped after one child".into(),
            ));
        }
        fs::remove_file(path)?;
        Ok(())
    }));

    assert!(outcome.succeeded.is_empty());
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert_eq!(outcome.unstarted, [path_string(&unstarted)]);
    assert!(!removed.exists());
    assert_eq!(fs::read(&retained).unwrap(), b"retain these exact bytes");
    assert_eq!(fs::read(&unstarted).unwrap(), b"never touched");
}

#[test]
fn raw_count_limit_is_checked_before_duplicate_paths_are_removed() {
    let path = path_string(&std::env::temp_dir().join("batch-count-item"));
    assert!(BatchPlan::new(vec![path.clone(); 32_768]).is_ok());
    let error = BatchPlan::new(vec![path; 32_769])
        .err()
        .expect("raw count over the limit must be rejected");
    assert!(error.contains("count or size limit"));
}

#[test]
fn raw_byte_limit_is_checked_before_duplicate_paths_are_removed() {
    let prefix = format!(
        "{}{}",
        path_string(&std::env::temp_dir()),
        std::path::MAIN_SEPARATOR
    );
    let path = format!("{prefix}{}", "x".repeat(1024 - prefix.len()));
    assert_eq!(path.len(), 1024);
    assert!(BatchPlan::new(vec![path.clone(); 8_192]).is_ok());
    let error = BatchPlan::new(vec![path; 8_193])
        .err()
        .expect("raw bytes over the limit must be rejected");
    assert!(error.contains("count or size limit"));
}

#[test]
fn malformed_and_non_leaf_paths_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir
        .path()
        .ancestors()
        .find(|path| path.has_root() && path.parent().is_none())
        .unwrap();
    let separator = std::path::MAIN_SEPARATOR;
    let cases = [
        "relative.txt".to_string(),
        format!("{}\0bad", path_string(&dir.path().join("valid"))),
        path_string(root),
        format!(
            "{}{separator}safe{separator}..{separator}escape",
            dir.path().display()
        ),
    ];

    for malformed in cases {
        let error = BatchPlan::new(vec![malformed.clone()])
            .err()
            .unwrap_or_else(|| panic!("malformed path was admitted: {malformed:?}"));
        assert!(error.contains("absolute non-root paths"));
    }
}

#[test]
fn ancestor_and_descendant_are_rejected_before_any_operation_can_start() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let child = parent.join("child.txt");
    fs::create_dir(&parent).unwrap();
    fs::write(&child, b"untouched").unwrap();

    let admitted = BatchPlan::new(vec![path_string(&parent), path_string(&child)]);
    assert!(admitted
        .err()
        .unwrap()
        .contains("either a directory or its descendants"));
    assert_eq!(fs::read(child).unwrap(), b"untouched");
}

#[test]
fn exact_duplicates_are_removed_stably_before_execution() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let first_path = path_string(&first);
    let second_path = path_string(&second);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&calls);

    let outcome = tauri::async_runtime::block_on(run(
        BatchPlan::new(vec![
            first_path.clone(),
            second_path.clone(),
            first_path.clone(),
        ])
        .unwrap(),
        move |path| {
            observed.lock().unwrap().push(path.to_string());
            fs::remove_file(path)?;
            Ok(())
        },
    ));

    assert_eq!(
        *calls.lock().unwrap(),
        [first_path.clone(), second_path.clone()]
    );
    assert_eq!(outcome.succeeded, [first_path, second_path]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
}

#[cfg(target_os = "windows")]
#[test]
fn windows_aliases_and_case_folded_ancestors_fail_batch_admission() {
    for paths in [
        vec![r"C:\Work\file.txt", r"c:\WORK\FILE.TXT"],
        vec![r"C:\Work\file.txt", r"\\?\C:\Work\file.txt"],
        vec![r"\\server\share\file", r"\\?\UNC\SERVER\SHARE\file"],
        vec![r"C:\Work\dir", r"C:\Work\dir-file", r"c:\work\DIR\child"],
        vec![r"C:\Work\file", r"C:\Work\file::$DATA"],
    ] {
        assert!(
            BatchPlan::new(paths.iter().map(|path| (*path).to_owned()).collect()).is_err(),
            "ambiguous Windows selection was admitted: {paths:?}"
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_batch_retains_original_spelling_and_exact_duplicate_order() {
    let paths = vec![
        r"C:/Mixed/First.TXT".to_owned(),
        r"\\?\D:\Other\Second.txt".to_owned(),
    ];
    let plan = BatchPlan::new(vec![paths[0].clone(), paths[1].clone(), paths[0].clone()]).unwrap();
    assert_eq!(plan.paths, paths);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_component_budget_admits_the_full_path_count_at_ordinary_depth() {
    let parents = (0..14)
        .map(|index| format!("dir{index}"))
        .collect::<Vec<_>>()
        .join(r"\");
    let paths: Vec<_> = (0..32_768)
        .map(|index| format!(r"C:\{parents}\file-{index}.txt"))
        .collect();
    let admitted = BatchPlan::new(paths.clone()).unwrap();
    assert_eq!(admitted.paths, paths);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_batch_keeps_case_distinct_files_independent() {
    let root = tempfile::tempdir().unwrap();
    let paths = [root.path().join("item"), root.path().join("ITEM")];
    fs::write(&paths[0], b"lower").unwrap();
    fs::write(&paths[1], b"upper").unwrap();
    let spellings: Vec<_> = paths.iter().map(|path| path_string(path)).collect();
    let plan = BatchPlan::new(spellings.clone()).unwrap();
    assert_eq!(plan.paths, spellings);
    let outcome = tauri::async_runtime::block_on(run(plan, move |path| {
        fs::remove_file(path)?;
        Ok(())
    }));
    assert_eq!(outcome.succeeded, spellings);
    assert!(paths.iter().all(|path| !path.exists()));
}

#[test]
fn empty_batch_has_no_effects_or_outcome_partitions() {
    let calls = Arc::new(Mutex::new(0usize));
    let observed = Arc::clone(&calls);
    let outcome =
        tauri::async_runtime::block_on(run(BatchPlan::new(Vec::new()).unwrap(), move |_| {
            *observed.lock().unwrap() += 1;
            Ok(())
        }));

    assert_eq!(*calls.lock().unwrap(), 0);
    assert!(outcome.succeeded.is_empty());
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
    assert_eq!(outcome.error(), None);
}

#[test]
fn component_order_detects_ancestors_without_rejecting_similar_sibling_names() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let sibling = root.path().join("a-sibling");
    let child = a.join("child");
    assert!(BatchPlan::new(vec![
        path_string(&sibling),
        path_string(&child),
        path_string(&a)
    ])
    .is_err());
    assert!(BatchPlan::new(vec![path_string(&child), path_string(&sibling)]).is_ok());
    let deep = root.path().join("component/".repeat(10_000)).join("leaf");
    assert!(BatchPlan::new(vec![path_string(&deep), path_string(&deep.join("child"))]).is_err());
}

#[test]
fn directory_effects_survive_worker_panic_without_claiming_leaf_success() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("created");
    let leaf = directory.join("not-restored.txt");
    let worker_directory = directory.clone();
    let outcome = tauri::async_runtime::block_on(super::run_with_effects(
        plan(&[&leaf]),
        move |_, effects| {
            effects.before_create(&worker_directory)?;
            fs::create_dir(&worker_directory)?;
            panic!("interrupted after creating parent");
        },
    ));
    assert!(directory.is_dir());
    assert!(!leaf.exists());
    assert!(outcome.succeeded.is_empty());
    assert_eq!(outcome.uncertain[0].path, path_string(&leaf));
    assert_eq!(
        outcome.refresh_dirs,
        [path_string(root.path()), path_string(&directory)]
    );
}

#[test]
fn directory_effect_budget_stops_before_unrecorded_mutation_and_deduplicates() {
    for component_size in [8, 1024] {
        let root = tempfile::tempdir().unwrap();
        let leaf = root.path().join("not-restored.txt");
        let worker_root = root.path().to_owned();
        let outcome = tauri::async_runtime::block_on(super::run_with_effects(
            plan(&[&leaf]),
            move |path, effects| {
                let repeated = worker_root.join("repeated");
                for _ in 0..40_000 {
                    effects.before_create(&repeated)?;
                }
                for index in 0..32_768 {
                    let name = format!("{index:08}{}", "x".repeat(component_size));
                    effects.before_create(&worker_root.join(name))?;
                }
                fs::write(path, b"must not run after exhausted budget")?;
                Ok(())
            },
        ));
        assert!(!leaf.exists());
        assert!(outcome.succeeded.is_empty());
        assert!(outcome.uncertain.is_empty());
        assert!(outcome.failed[0].error.contains("path count or size limit"));
        assert!(outcome.refresh_dirs.len() <= 32_768);
        assert!(outcome.refresh_dirs.iter().map(String::len).sum::<usize>() <= 8 * 1024 * 1024);
        assert!(
            outcome.refresh_dirs.len() > 2,
            "duplicates must not exhaust the budget"
        );
    }
}
