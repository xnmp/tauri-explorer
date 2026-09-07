use super::{Action, Direction, Execution, Histories};

const FIRST: u64 = 11;
const SECOND: u64 = 22;

fn copy(path: &str, restore_supported: bool) -> Action {
    Action::Copy {
        copied_path: path.into(),
        parent_dir: path
            .rsplit_once('/')
            .map_or("", |(parent, _)| parent)
            .into(),
        restore_supported,
    }
}

fn deleted(paths: &[&str]) -> Action {
    Action::Delete {
        paths: paths.iter().map(|path| (*path).into()).collect(),
        parent_dir: "/trash".into(),
    }
}

fn completed(action: &Action, opposite: Option<Action>) -> Execution {
    Execution {
        completed: Some(action.clone()),
        opposite,
        remaining: None,
        error: None,
    }
}

#[test]
fn shared_entry_has_one_admission_and_rejects_its_stale_id_after_settlement() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let action = copy("/shared/report.txt", true);
    histories.push(FIRST, Some(action.clone()), true).unwrap();
    let expected = histories.summary(FIRST).undo_id.unwrap();
    assert_eq!(histories.summary(SECOND).undo_id, Some(expected));

    let reservation = histories.begin(FIRST, Direction::Undo, expected).unwrap();
    assert_eq!(reservation.action, action);
    assert!(histories
        .begin(SECOND, Direction::Undo, expected)
        .unwrap_err()
        .contains("in progress"));
    histories.finish(reservation, &completed(&action, Some(action.clone())));

    let first = histories.summary(FIRST);
    let second = histories.summary(SECOND);
    assert_eq!(first.undo_id, None);
    assert_eq!(second.undo_id, None);
    assert_eq!(first.redo_id, second.redo_id);
    assert!(first.redo_id.is_some());
    assert!(histories
        .begin(SECOND, Direction::Undo, expected)
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn local_entry_and_its_settlement_remain_local_to_the_originating_participant() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let action = copy("/local/draft.txt", true);
    histories.push(FIRST, Some(action.clone()), false).unwrap();

    let first = histories.summary(FIRST);
    assert!(first.undo_id.is_some());
    assert_eq!(histories.summary(SECOND).undo_id, None);
    let reservation = histories
        .begin(FIRST, Direction::Undo, first.undo_id.unwrap())
        .unwrap();
    histories.finish(reservation, &completed(&action, Some(action.clone())));

    assert!(histories.summary(FIRST).redo_id.is_some());
    let second = histories.summary(SECOND);
    assert_eq!(second.undo_id, None);
    assert_eq!(second.redo_id, None);
}

#[test]
fn participant_push_during_shared_undo_preserves_its_new_branch() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let shared = copy("/shared/old.txt", true);
    histories.push(FIRST, Some(shared.clone()), true).unwrap();
    let reservation = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();

    let newer = copy("/second/new.txt", true);
    histories.push(SECOND, Some(newer.clone()), false).unwrap();
    let newer_id = histories.summary(SECOND).undo_id.unwrap();
    histories.finish(reservation, &completed(&shared, Some(shared.clone())));

    assert!(histories.summary(FIRST).redo_id.is_some());
    let second = histories.summary(SECOND);
    assert_eq!(second.stack_size, 1);
    assert_eq!(second.undo_id, Some(newer_id));
    assert_eq!(second.redo_id, None);
    let admitted = histories.begin(SECOND, Direction::Undo, newer_id).unwrap();
    assert_eq!(admitted.action, newer);
}

#[test]
fn participant_clear_during_shared_execution_retires_only_its_publication() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let action = copy("/shared/clear.txt", true);
    histories.push(FIRST, Some(action.clone()), true).unwrap();
    let reservation = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();

    histories.clear(SECOND);
    histories.finish(reservation, &completed(&action, Some(action.clone())));

    assert!(histories.summary(FIRST).redo_id.is_some());
    let second = histories.summary(SECOND);
    assert_eq!(second.stack_size, 0);
    assert_eq!(second.undo_id, None);
    assert_eq!(second.redo_id, None);
}

#[test]
fn retiring_the_admitting_participant_does_not_abandon_other_shared_participants() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let action = copy("/shared/retire.txt", true);
    histories.push(FIRST, Some(action.clone()), true).unwrap();
    let reservation = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();

    histories.retire(FIRST);
    assert!(histories.summary(SECOND).busy);
    histories.finish(reservation, &completed(&action, Some(action.clone())));

    assert!(histories.summary(SECOND).redo_id.is_some());
    histories.register(FIRST);
    let first = histories.summary(FIRST);
    assert_eq!(first.stack_size, 0);
    assert_eq!(first.redo_id, None);
}

#[test]
fn partial_path_subsets_retry_only_remaining_work_and_redo_in_lifo_order() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let all = deleted(&["/trash/a.txt", "/trash/b.txt"]);
    histories.push(FIRST, Some(all.clone()), false).unwrap();
    let first = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    let a = deleted(&["/trash/a.txt"]);
    let b = deleted(&["/trash/b.txt"]);
    histories.finish(
        first,
        &Execution {
            completed: Some(a.clone()),
            opposite: Some(a.clone()),
            remaining: Some(b.clone()),
            error: Some("b restore failed".into()),
        },
    );

    let remaining_id = histories.summary(FIRST).undo_id.unwrap();
    let retry = histories
        .begin(FIRST, Direction::Undo, remaining_id)
        .unwrap();
    assert_eq!(retry.action, b);
    histories.finish(retry, &completed(&b, Some(b.clone())));
    assert_eq!(histories.summary(FIRST).undo_id, None);

    let redo_b = histories
        .begin(
            FIRST,
            Direction::Redo,
            histories.summary(FIRST).redo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(redo_b.action, b);
    histories.finish(redo_b, &completed(&b, Some(b.clone())));
    let redo_a = histories
        .begin(
            FIRST,
            Direction::Redo,
            histories.summary(FIRST).redo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(redo_a.action, a);
}

#[test]
fn admitted_partial_redo_retains_its_remaining_work_after_a_new_push() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let all = deleted(&["/trash/a.txt", "/trash/b.txt"]);
    histories.push(FIRST, Some(all.clone()), false).unwrap();
    let undo = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    histories.finish(undo, &completed(&all, Some(all.clone())));
    let redo = histories
        .begin(
            FIRST,
            Direction::Redo,
            histories.summary(FIRST).redo_id.unwrap(),
        )
        .unwrap();

    let newer = copy("/new/new.txt", true);
    histories.push(FIRST, Some(newer.clone()), false).unwrap();
    let a = deleted(&["/trash/a.txt"]);
    let b = deleted(&["/trash/b.txt"]);
    histories.finish(
        redo,
        &Execution {
            completed: Some(a.clone()),
            opposite: Some(a),
            remaining: Some(b.clone()),
            error: Some("b delete failed".into()),
        },
    );

    let summary = histories.summary(FIRST);
    assert_eq!(summary.stack_size, 2);
    let retry = histories
        .begin(FIRST, Direction::Redo, summary.redo_id.unwrap())
        .unwrap();
    assert_eq!(retry.action, b);
}

#[test]
fn completed_one_way_copy_has_no_redo_entry() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let action = copy("/one-way/copied.txt", false);
    histories.push(FIRST, Some(action.clone()), false).unwrap();
    let undo = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();

    histories.finish(undo, &completed(&action, None));

    let summary = histories.summary(FIRST);
    assert_eq!(summary.undo_id, None);
    assert_eq!(summary.redo_id, None);
    assert_eq!(summary.stack_size, 0);
}

#[test]
fn shared_null_push_clears_every_participant_redo_without_replacing_their_undo() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let retained = copy("/shared/retained.txt", true);
    histories.push(FIRST, Some(retained.clone()), true).unwrap();
    let retained_id = histories.summary(FIRST).undo_id.unwrap();

    for (client, name) in [(FIRST, "first-redo"), (SECOND, "second-redo")] {
        let local = copy(&format!("/local/{name}.txt"), true);
        histories.push(client, Some(local.clone()), false).unwrap();
        let reservation = histories
            .begin(
                client,
                Direction::Undo,
                histories.summary(client).undo_id.unwrap(),
            )
            .unwrap();
        histories.finish(reservation, &completed(&local, Some(local.clone())));
        let summary = histories.summary(client);
        assert_eq!(summary.undo_id, Some(retained_id));
        assert!(summary.redo_id.is_some());
        assert_eq!(summary.stack_size, 1);
    }

    histories.push(FIRST, None, true).unwrap();

    for client in [FIRST, SECOND] {
        let summary = histories.summary(client);
        assert_eq!(summary.undo_id, Some(retained_id));
        assert_eq!(summary.redo_id, None);
        assert_eq!(summary.stack_size, 1);
    }
    let reservation = histories
        .begin(SECOND, Direction::Undo, retained_id)
        .unwrap();
    assert_eq!(reservation.action, retained);
}

#[test]
fn history_count_bound_evicts_oldest_entries_and_keeps_the_latest_admissible() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories
        .push(FIRST, Some(copy("/bounded/first.txt", true)), false)
        .unwrap();
    let oldest = histories.summary(FIRST).undo_id.unwrap();
    for index in 1..300 {
        histories
            .push(
                FIRST,
                Some(copy(&format!("/bounded/{index}.txt"), true)),
                false,
            )
            .unwrap();
    }

    let summary = histories.summary(FIRST);
    assert_eq!(summary.stack_size, 256);
    assert!(histories
        .begin(FIRST, Direction::Undo, oldest)
        .unwrap_err()
        .contains("changed"));
    let latest = histories
        .begin(FIRST, Direction::Undo, summary.undo_id.unwrap())
        .unwrap();
    assert_eq!(latest.action, copy("/bounded/299.txt", true));
}

#[test]
fn history_byte_bound_evicts_the_older_large_entry() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let first_path = format!("/large/{}", "a".repeat(17 * 1024 * 1024));
    histories
        .push(FIRST, Some(copy(&first_path, true)), false)
        .unwrap();
    let first_id = histories.summary(FIRST).undo_id.unwrap();
    let second_path = format!("/large/{}", "b".repeat(17 * 1024 * 1024));
    histories
        .push(FIRST, Some(copy(&second_path, true)), false)
        .unwrap();

    let summary = histories.summary(FIRST);
    assert_eq!(summary.stack_size, 1);
    assert!(histories
        .begin(FIRST, Direction::Undo, first_id)
        .unwrap_err()
        .contains("changed"));
    let latest = histories
        .begin(FIRST, Direction::Undo, summary.undo_id.unwrap())
        .unwrap();
    assert_eq!(latest.action, copy(&second_path, true));
}
