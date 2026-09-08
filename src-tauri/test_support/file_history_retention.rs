use super::{retain, settlement};
use crate::{
    file_history::model::{
        entry_bytes, Action, Direction, Execution, ForwardEffect, Histories, Recovery,
    },
    files::trash_artifact::TrashArtifact,
};
use std::{collections::BTreeMap, sync::Arc};

const CLIENT: u64 = 41;

fn rename(id: &str) -> Action {
    Action::Rename {
        path: format!("/history/{id}-new.txt"),
        old_name: format!("{id}-old.txt"),
        new_name: format!("{id}-new.txt"),
    }
}

fn artifact(id: usize, units: usize) -> Arc<TrashArtifact> {
    let mut parsing_name_utf16 = Vec::with_capacity(units);
    parsing_name_utf16.extend(id.to_string().encode_utf16());
    parsing_name_utf16.resize(units, b'x' as u16);
    Arc::new(TrashArtifact::WindowsShell { parsing_name_utf16 })
}

fn delete_restore(paths: &[String], artifact_units: usize) -> Action {
    let artifacts = paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.clone(), artifact(index, artifact_units)))
        .collect::<BTreeMap<_, _>>();
    Action::Delete {
        paths: paths.to_vec(),
        parent_dir: "/history".into(),
        recovery: Recovery::Restore(Arc::new(artifacts)),
    }
}

fn copy_restore(id: &str, artifact_units: usize) -> Action {
    Action::Copy {
        publication: None,
        copied_path: format!("/history/{id}.txt"),
        parent_dir: "/history".into(),
        restore_supported: true,
        recovery: Recovery::Restore(artifact(1, artifact_units)),
    }
}

fn retained(action: Action, direction: Direction, budget: usize) -> Action {
    retain(action, direction, budget)
        .action
        .expect("fitting recovery action")
}

#[test]
fn entry_budget_includes_the_history_slot_overhead_at_the_exact_boundary() {
    let action = rename("boundary");
    let exact = entry_bytes(&action);

    assert_eq!(retained(action.clone(), Direction::Undo, exact), action);
    let rejected = retain(action, Direction::Undo, exact - 1);
    assert!(rejected.action.is_none());
    assert!(rejected
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("1 completed item")));
}

#[test]
fn restore_delete_keeps_only_the_fitting_prefix_and_its_matching_receipts() {
    let paths = vec![
        "/first-parent/first.txt".to_string(),
        "/second-parent/second.txt".to_string(),
        "/third-parent/third.txt".to_string(),
    ];
    let full = delete_restore(&paths, 256);
    let expected = delete_restore(&paths[..2], 256);
    let result = retain(full, Direction::Undo, entry_bytes(&expected));

    assert_eq!(result.action, Some(expected));
    assert!(result
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("1 completed item")));
    let Some(Action::Delete {
        paths: retained_paths,
        recovery: Recovery::Restore(receipts),
        ..
    }) = result.action
    else {
        panic!("retained delete recovery");
    };
    assert_eq!(retained_paths, paths[..2]);
    assert_eq!(receipts.keys().cloned().collect::<Vec<_>>(), paths[..2]);
}

#[test]
fn oversized_copy_is_indivisible_and_is_dropped_with_a_warning() {
    let action = copy_restore("oversized", 2048);
    let budget = entry_bytes(&action) - 1;
    let result = retain(action, Direction::Redo, budget);

    assert!(result.action.is_none());
    assert!(result
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("1 completed item")));
}

#[test]
fn nested_batches_keep_a_contiguous_prefix_in_the_next_execution_order() {
    let a = rename("a");
    let b = rename("b");
    let c = rename("c");
    let d = rename("d");
    let nested = |actions| Action::Batch {
        actions,
        label: "nested".into(),
    };
    let full = Action::Batch {
        actions: vec![a.clone(), nested(vec![b.clone(), c.clone()]), d.clone()],
        label: "outer".into(),
    };

    let expected_undo = Action::Batch {
        actions: vec![nested(vec![c.clone()]), d],
        label: "outer".into(),
    };
    assert_eq!(
        retained(full.clone(), Direction::Undo, entry_bytes(&expected_undo),),
        expected_undo
    );

    let expected_redo = Action::Batch {
        actions: vec![a, nested(vec![b])],
        label: "outer".into(),
    };
    assert_eq!(
        retained(full, Direction::Redo, entry_bytes(&expected_redo)),
        expected_redo
    );
}

#[test]
fn incidental_vector_capacity_is_compacted_before_recovery_is_dropped() {
    let child = rename("only-child");
    let mut actions = Vec::with_capacity(4096);
    actions.push(child.clone());
    let bloated_batch = Action::Batch {
        actions,
        label: "compact batch".into(),
    };
    let compact_batch = Action::Batch {
        actions: vec![child],
        label: "compact batch".into(),
    };
    assert!(entry_bytes(&bloated_batch) > entry_bytes(&compact_batch));
    assert_eq!(
        retained(bloated_batch, Direction::Undo, entry_bytes(&compact_batch),),
        compact_batch
    );

    let path = "/history/only.txt".to_string();
    let mut paths = Vec::with_capacity(4096);
    paths.push(path.clone());
    let bloated_delete = Action::Delete {
        paths,
        parent_dir: "/history".into(),
        recovery: Recovery::Capture,
    };
    let compact_delete = Action::Delete {
        paths: vec![path],
        parent_dir: "/history".into(),
        recovery: Recovery::Capture,
    };
    assert!(entry_bytes(&bloated_delete) > entry_bytes(&compact_delete));
    assert_eq!(
        retained(
            bloated_delete,
            Direction::Redo,
            entry_bytes(&compact_delete),
        ),
        compact_delete
    );
}

#[test]
fn remaining_work_uses_the_combined_budget_before_completed_recovery() {
    let remaining = rename("remaining");
    let completed_paths = vec![
        "/history/completed-a.txt".to_string(),
        "/history/completed-b.txt".to_string(),
    ];
    let full_opposite = delete_restore(&completed_paths, 256);
    let fitting_opposite = delete_restore(&completed_paths[..1], 256);
    let combined_budget = entry_bytes(&remaining) + entry_bytes(&fitting_opposite);

    let fitted = retain(
        full_opposite,
        Direction::Redo,
        combined_budget - entry_bytes(&remaining),
    );
    assert_eq!(fitted.action, Some(fitting_opposite.clone()));
    assert_eq!(
        entry_bytes(&remaining) + entry_bytes(fitted.action.as_ref().unwrap()),
        combined_budget
    );

    let settled = settlement(
        Execution {
            remaining: Some(remaining.clone()),
            opposite: Some(fitting_opposite.clone()),
            ..Execution::default()
        },
        Direction::Undo,
    );
    assert_eq!(settled.remaining, Some(remaining));
    assert_eq!(settled.opposite, Some(fitting_opposite));
}

#[test]
fn a_dropped_opposite_never_turns_a_completed_effect_into_retryable_work() {
    let completed = rename("completed");
    let inverse = copy_restore("inverse", 1024);
    let budget = entry_bytes(&inverse) - 1;
    let fitted = retain(inverse, Direction::Redo, budget);
    assert!(fitted.action.is_none());

    let mut histories = Histories::default();
    histories.register(CLIENT);
    histories
        .push(CLIENT, Some(completed.clone()), false)
        .unwrap();
    let source_id = histories.summary(CLIENT).undo_id.unwrap();
    let reservation = histories.begin(CLIENT, Direction::Undo, source_id).unwrap();
    histories.finish(
        reservation,
        &Execution {
            completed: Some(completed),
            opposite: fitted.action,
            remaining: None,
            error: fitted.warning,
            ..Execution::default()
        },
    );

    let summary = histories.summary(CLIENT);
    assert_eq!(summary.undo_id, None);
    assert_eq!(summary.redo_id, None);
    assert_eq!(summary.stack_size, 0);
}

#[test]
fn forward_warning_does_not_hide_the_fitting_undo_entry_after_settlement() {
    let paths = vec![
        "/one/a.txt".to_string(),
        "/two/b.txt".to_string(),
        "/three/c.txt".to_string(),
    ];
    let full = delete_restore(&paths, 256);
    let expected = delete_restore(&paths[..2], 256);
    let fitted = retain(full, Direction::Undo, entry_bytes(&expected));
    assert!(fitted.warning.is_some());

    let mut histories = Histories::default();
    histories.register(CLIENT);
    let reservation = histories.begin_forward(CLIENT, false).unwrap();
    histories.finish_forward(reservation, ForwardEffect::Changed(fitted.action.clone()));

    let summary = histories.summary(CLIENT);
    assert!(!summary.busy);
    let undo_id = summary.undo_id.expect("fitting Undo remains available");
    let admitted = histories.begin(CLIENT, Direction::Undo, undo_id).unwrap();
    assert_eq!(admitted.action, expected);
}
