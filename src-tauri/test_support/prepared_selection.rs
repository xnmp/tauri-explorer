use super::*;
use std::{cell::RefCell, fs};

/// An inert prepared effect: executing it only records its key.
struct Fake {
    key: String,
    retained: usize,
}

impl SelectionItem for Fake {
    const NOUN: &'static str = "Fake";
    const EXECUTION: &'static str = "Fake execution";

    fn retained_bytes(&self) -> usize {
        self.retained
    }
}

fn keys(names: &[&str]) -> Arc<Vec<String>> {
    Arc::new(names.iter().map(|name| (*name).to_owned()).collect())
}

fn fake(key: &str) -> Fake {
    Fake {
        key: key.to_owned(),
        retained: 0,
    }
}

/// One inert item per key, in key order.
fn prepare_fakes(paths: Arc<Vec<String>>) -> PreparedSelection<Fake> {
    PreparedSelection::prepare(paths, MAX_PLAN_BYTES, |preparation, paths| {
        for path in paths {
            preparation.push(Ok(fake(path)))?;
        }
        Ok(())
    })
    .unwrap()
}

/// Run `key` and report which prepared item executed.
fn run(selection: &mut PreparedSelection<Fake>, key: &str) -> Result<String, AppError> {
    selection.run_next(key, |item| Ok(item.key))
}

#[test]
fn items_execute_in_prepared_order_under_their_receipt_keys() {
    let mut selection = prepare_fakes(keys(&["a", "b", "c"]));
    let executed: Vec<_> = ["a", "b", "c"]
        .iter()
        .map(|key| run(&mut selection, key).unwrap())
        .collect();
    assert_eq!(executed, ["a", "b", "c"]);
}

#[test]
fn a_mismatched_key_is_refused_without_consuming_its_item() {
    let mut selection = prepare_fakes(keys(&["a", "b"]));
    let ran = RefCell::new(false);
    let result = selection.run_next("b", |_| {
        *ran.borrow_mut() = true;
        Ok(())
    });
    assert!(
        matches!(result, Err(AppError::WorkerFailed(_))),
        "{result:?}"
    );
    assert!(!*ran.borrow(), "a refused key must not execute any item");
    assert_eq!(run(&mut selection, "a").unwrap(), "a");
    assert_eq!(run(&mut selection, "b").unwrap(), "b");
}

#[test]
fn execution_beyond_the_selection_is_refused() {
    let mut selection = prepare_fakes(keys(&["a"]));
    run(&mut selection, "a").unwrap();
    assert!(matches!(
        run(&mut selection, "a"),
        Err(AppError::WorkerFailed(_))
    ));
}

#[test]
fn a_per_item_preparation_failure_is_reported_for_its_own_key_only() {
    let mut selection =
        PreparedSelection::prepare(keys(&["a", "b", "c"]), MAX_PLAN_BYTES, |preparation, _| {
            preparation.push(Ok(fake("a")))?;
            preparation.push(Err(AppError::NotFound("b is gone".into())))?;
            preparation.push(Ok(fake("c")))
        })
        .unwrap();
    assert_eq!(run(&mut selection, "a").unwrap(), "a");
    let failed = selection.run_next("b", |_| -> Result<(), AppError> {
        panic!("a failed preparation must not execute")
    });
    assert!(
        matches!(&failed, Err(AppError::Other(message)) if message.contains("b is gone")),
        "{failed:?}"
    );
    assert_eq!(run(&mut selection, "c").unwrap(), "c");
}

#[test]
fn a_failure_after_execution_starts_leaves_later_items_runnable() {
    let mut selection = prepare_fakes(keys(&["a", "b"]));
    let failed = selection.run_next("a", |_| -> Result<(), AppError> {
        Err(AppError::MutationUncertain("partial".into()))
    });
    assert!(matches!(failed, Err(AppError::MutationUncertain(_))));
    assert_eq!(run(&mut selection, "b").unwrap(), "b");
}

#[test]
fn a_batch_stopped_mid_selection_executes_nothing_further() {
    let executed = RefCell::new(Vec::new());
    {
        let mut selection = prepare_fakes(keys(&["a", "b", "c"]));
        selection
            .run_next("a", |item| {
                executed.borrow_mut().push(item.key);
                Ok(())
            })
            .unwrap();
        // The batch stops here (an uncertain item or cancellation): the
        // remaining prepared items are dropped with the selection.
    }
    assert_eq!(*executed.borrow(), ["a"]);
}

#[test]
fn a_plan_refused_mid_selection_yields_no_selection() {
    let observed = RefCell::new(Vec::new());
    let result = PreparedSelection::<Fake>::prepare(
        keys(&["a", "b", "c"]),
        MAX_PLAN_BYTES,
        |preparation, paths| {
            for path in paths {
                observed.borrow_mut().push(path.clone());
                if path == "b" {
                    return Err(AppError::InvalidPath("overlapping selection".into()));
                }
                preparation.push(Ok(fake(path)))?;
            }
            Ok(())
        },
    );
    assert!(matches!(result, Err(AppError::InvalidPath(_))));
    assert_eq!(*observed.borrow(), ["a", "b"]);
}

#[test]
fn a_plan_that_is_not_aligned_with_its_keys_is_refused() {
    let result =
        PreparedSelection::<Fake>::prepare(keys(&["a", "b"]), MAX_PLAN_BYTES, |preparation, _| {
            preparation.push(Ok(fake("a")))
        });
    assert!(matches!(result, Err(AppError::WorkerFailed(_))));
}

#[test]
fn keys_are_budgeted_before_the_plan_observes_anything() {
    let planned = RefCell::new(false);
    let result = PreparedSelection::<Fake>::prepare(keys(&["a"; 64]), 256, |_, _| {
        *planned.borrow_mut() = true;
        Ok(())
    });
    assert!(
        matches!(&result, Err(AppError::InvalidPath(message)) if message.starts_with("Fake selection")),
        "{:?}",
        result.err()
    );
    assert!(!*planned.borrow());
}

#[test]
fn reserved_key_capacity_counts_against_the_budget() {
    let mut paths = Vec::with_capacity(MAX_PLAN_BYTES / std::mem::size_of::<String>() + 1);
    paths.push("a".to_owned());
    let result = PreparedSelection::<Fake>::prepare(Arc::new(paths), MAX_PLAN_BYTES, |_, _| {
        panic!("an oversized selection must not be planned")
    });
    assert!(matches!(result, Err(AppError::InvalidPath(_))));
}

#[test]
fn retained_item_bytes_and_failure_messages_count_against_the_budget() {
    let maximum = 64 * 1024;
    let within = PreparedSelection::prepare(keys(&["a"]), maximum, |preparation, _| {
        preparation.push(Ok(Fake {
            key: "a".into(),
            retained: maximum / 2,
        }))
    });
    assert!(within.is_ok());
    let oversized_item = PreparedSelection::prepare(keys(&["a"]), maximum, |preparation, _| {
        preparation.push(Ok(Fake {
            key: "a".into(),
            retained: maximum,
        }))
    });
    assert!(matches!(oversized_item, Err(AppError::InvalidPath(_))));
    let oversized_failure =
        PreparedSelection::<Fake>::prepare(keys(&["a"]), maximum, |preparation, _| {
            preparation.push(Err(AppError::Other("x".repeat(maximum))))
        });
    assert!(matches!(oversized_failure, Err(AppError::InvalidPath(_))));
}

#[test]
fn observation_claims_the_physical_source_and_its_alias_dependency() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("entry"), b"x").unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let requested = alias.join("entry");
    let key = requested.to_str().unwrap().to_owned();
    let mut observed = None;
    let (_, claims) =
        PreparedSelection::prepare(keys(&[&key]), MAX_PLAN_BYTES, |preparation, paths| {
            let source = preparation.observe(Path::new(&paths[0]))?;
            observed = Some((source.path.clone(), source.version.is_some()));
            preparation.push(Ok(fake(&paths[0])))
        })
        .unwrap()
        .into_admission();
    let physical = fs::canonicalize(real.join("entry")).unwrap();
    assert_eq!(observed, Some((physical.clone(), true)));
    assert!(claims.iter().any(|claim| claim.path.0 == physical));
    let alias_physical = fs::canonicalize(root.path()).unwrap().join("alias");
    assert!(
        claims.iter().any(|claim| claim.path.0 == alias_physical),
        "the alias that resolved the request must stay claimed"
    );
}

#[test]
fn a_missing_entry_is_observed_without_a_version_but_stays_claimed() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing");
    let key = missing.to_str().unwrap().to_owned();
    let (_, claims) =
        PreparedSelection::<Fake>::prepare(keys(&[&key]), MAX_PLAN_BYTES, |preparation, paths| {
            let source = preparation.observe(Path::new(&paths[0]))?;
            assert!(source.version.is_none());
            preparation.push(Err(AppError::NotFound(paths[0].clone())))
        })
        .unwrap()
        .into_admission();
    let physical = fs::canonicalize(root.path()).unwrap().join("missing");
    assert!(claims.iter().any(|claim| claim.path.0 == physical));
}

fn observe_all(paths: &[&Path]) -> Result<PreparedSelection<Fake>, AppError> {
    let keys = Arc::new(
        paths
            .iter()
            .map(|path| path.to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
    );
    PreparedSelection::prepare(keys, MAX_PLAN_BYTES, |preparation, paths| {
        for path in paths {
            preparation.observe(Path::new(path))?;
            preparation.push(Ok(fake(path)))?;
        }
        Ok(())
    })
}

#[test]
fn overlapping_or_aliased_sources_refuse_the_whole_selection() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    fs::create_dir(&real).unwrap();
    let entry = real.join("entry");
    fs::write(&entry, b"x").unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    assert!(observe_all(&[&entry, &alias.join("entry")]).is_err());
    assert!(observe_all(&[&real, &entry]).is_err());
    assert!(observe_all(&[&entry, &real]).is_err());
    let sibling = real.join("sibling");
    fs::write(&sibling, b"y").unwrap();
    assert!(observe_all(&[&entry, &sibling]).is_ok());
}

#[test]
fn container_claims_exclude_sources_but_are_not_admitted() {
    let root = tempfile::tempdir().unwrap();
    let container = root.path().join("container");
    fs::create_dir(&container).unwrap();
    let inside = container.join("inside");
    fs::write(&inside, b"x").unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, b"y").unwrap();
    let with_container = |source: &Path| {
        let key = source.to_str().unwrap().to_owned();
        PreparedSelection::prepare(keys(&[&key]), MAX_PLAN_BYTES, |preparation, paths| {
            preparation.claim(
                &resources::capture(&container, Access::Write, Scope::Subtree)?,
                SelectionRole::Container,
            )?;
            preparation.observe(Path::new(&paths[0]))?;
            preparation.push(Ok(fake(&paths[0])))
        })
        .map(PreparedSelection::into_admission)
    };
    assert!(with_container(&inside).is_err());
    let (_, claims) = with_container(&outside).unwrap();
    let physical = fs::canonicalize(&container).unwrap();
    assert!(claims.iter().all(|claim| claim.path.0 != physical));
    assert!(claims
        .iter()
        .any(|claim| claim.path.0 == fs::canonicalize(&outside).unwrap()));
}

#[test]
fn prepared_items_can_claim_their_own_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::write(&source, b"x").unwrap();
    let key = source.to_str().unwrap().to_owned();
    let artifact = |item: &Fake| PathBuf::from(format!("{}.artifact", item.key));
    let prepared =
        PreparedSelection::prepare(keys(&[&key]), MAX_PLAN_BYTES, |preparation, paths| {
            preparation.observe(Path::new(&paths[0]))?;
            preparation.push(Ok(fake(&paths[0])))?;
            preparation.claim_prepared(|item, claims| {
                claims.insert(
                    &resources::capture(&artifact(item), Access::Write, Scope::Entry)?,
                    SelectionRole::Exclusive,
                )?;
                Ok(())
            })
        });
    let (_, claims) = prepared.unwrap().into_admission();
    let expected = fs::canonicalize(root.path())
        .unwrap()
        .join("source.artifact");
    assert!(claims.iter().any(|claim| claim.path.0 == expected));
    // An artifact that overlaps a selected source refuses the selection.
    let overlapping =
        PreparedSelection::prepare(keys(&[&key]), MAX_PLAN_BYTES, |preparation, paths| {
            preparation.observe(Path::new(&paths[0]))?;
            preparation.push(Ok(fake(&paths[0])))?;
            preparation.claim_prepared(|item, claims| {
                claims.insert(
                    &resources::capture(Path::new(&item.key), Access::Write, Scope::Entry)?,
                    SelectionRole::Exclusive,
                )?;
                Ok(())
            })
        });
    assert!(overlapping.is_err());
}
