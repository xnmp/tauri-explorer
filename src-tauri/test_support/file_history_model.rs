use super::{Action, Direction, Execution, ForwardEffect, Histories};

const FIRST: u64 = 11;
const SECOND: u64 = 22;

fn copy(path: &str, restore_supported: bool) -> Action {
    Action::Copy {
        recovery: super::Recovery::Capture,
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
        recovery: super::Recovery::Capture,
        paths: paths.iter().map(|path| (*path).into()).collect(),
        parent_dir: "/trash".into(),
    }
}

fn completed(action: &Action, opposite: Option<Action>) -> Execution {
    Execution {
        uncertain: None,
        completed: Some(action.clone()),
        opposite,
        remaining: None,
        error: None,
        ..Execution::default()
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
            uncertain: None,
            completed: Some(a.clone()),
            opposite: Some(a.clone()),
            remaining: Some(b.clone()),
            error: Some("b restore failed".into()),
            ..Execution::default()
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
            uncertain: None,
            completed: Some(a.clone()),
            opposite: Some(a),
            remaining: Some(b.clone()),
            error: Some("b delete failed".into()),
            ..Execution::default()
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
fn admitted_redo_settles_below_a_newer_local_action() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let shared = copy("/ordered/shared.txt", true);
    histories.push(FIRST, Some(shared.clone()), false).unwrap();

    let undo = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(undo.action, shared);
    histories.finish(undo, &completed(&shared, Some(shared.clone())));

    let redo = histories
        .begin(
            FIRST,
            Direction::Redo,
            histories.summary(FIRST).redo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(redo.action, shared);

    let later = copy("/ordered/later.txt", true);
    histories.push(FIRST, Some(later.clone()), false).unwrap();
    histories.finish(redo, &completed(&shared, Some(shared.clone())));

    let undo_later = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(undo_later.action, later);
    histories.finish(undo_later, &completed(&later, Some(later.clone())));

    let undo_shared = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(undo_shared.action, shared);
}

#[test]
fn forward_slots_preserve_admission_order_when_work_finishes_out_of_order() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let older_action = copy("/forward/older.txt", true);
    let newer_action = copy("/forward/newer.txt", true);
    let older = histories.begin_forward(FIRST, false).unwrap();
    let newer = histories.begin_forward(FIRST, false).unwrap();

    let pending = histories.summary(FIRST);
    assert!(pending.busy);
    assert_eq!(pending.undo_id, None);
    assert_eq!(pending.stack_size, 0);

    histories.finish_forward(newer, ForwardEffect::Changed(Some(newer_action.clone())));
    let newer_id = histories.summary(FIRST).undo_id.unwrap();
    assert!(histories
        .begin(FIRST, Direction::Undo, newer_id)
        .unwrap_err()
        .contains("still in progress"));

    histories.finish_forward(older, ForwardEffect::Changed(Some(older_action.clone())));
    assert!(!histories.summary(FIRST).busy);
    let undo_newer = histories.begin(FIRST, Direction::Undo, newer_id).unwrap();
    assert_eq!(undo_newer.action, newer_action);
    histories.finish(
        undo_newer,
        &completed(&newer_action, Some(newer_action.clone())),
    );
    let undo_older = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(undo_older.action, older_action);
}

#[test]
fn legacy_push_after_forward_admission_remains_the_newer_undo_intent() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let older_action = copy("/forward/reserved.txt", true);
    let newer_action = copy("/forward/legacy-push.txt", true);
    let older = histories.begin_forward(FIRST, false).unwrap();
    histories
        .push(FIRST, Some(newer_action.clone()), false)
        .unwrap();
    let newer_id = histories.summary(FIRST).undo_id.unwrap();
    assert!(histories.summary(FIRST).busy);

    histories.finish_forward(older, ForwardEffect::Changed(Some(older_action.clone())));
    let undo_newer = histories.begin(FIRST, Direction::Undo, newer_id).unwrap();
    assert_eq!(undo_newer.action, newer_action);
    histories.finish(
        undo_newer,
        &completed(&newer_action, Some(newer_action.clone())),
    );
    let undo_older = histories
        .begin(
            FIRST,
            Direction::Undo,
            histories.summary(FIRST).undo_id.unwrap(),
        )
        .unwrap();
    assert_eq!(undo_older.action, older_action);
}

#[test]
fn unchanged_forward_preserves_redo_but_committed_without_inverse_clears_it() {
    for committed in [false, true] {
        let mut histories = Histories::default();
        histories.register(FIRST);
        let action = copy("/forward/redo.txt", true);
        histories.push(FIRST, Some(action.clone()), false).unwrap();
        let undo = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        histories.finish(undo, &completed(&action, Some(action.clone())));
        let redo_id = histories.summary(FIRST).redo_id.unwrap();

        let forward = histories.begin_forward(FIRST, false).unwrap();
        histories.finish_forward(
            forward,
            if committed {
                ForwardEffect::Changed(None)
            } else {
                ForwardEffect::Unchanged
            },
        );

        if committed {
            let summary = histories.summary(FIRST);
            assert_eq!(summary.redo_id, None);
            assert_eq!(summary.undo_id, None);
        } else {
            assert_eq!(histories.summary(FIRST).redo_id, Some(redo_id));
            let redo = histories.begin(FIRST, Direction::Redo, redo_id).unwrap();
            assert_eq!(redo.action, action);
        }
    }
}

#[test]
fn shared_forward_tracks_only_captured_live_participants() {
    const LATE: u64 = 33;
    let mut histories = Histories::default();
    histories.register(FIRST);
    histories.register(SECOND);
    let action = copy("/forward/shared.txt", true);
    let forward = histories.begin_forward(FIRST, true).unwrap();
    assert!(histories.summary(FIRST).busy);
    assert!(histories.summary(SECOND).busy);

    histories.clear(FIRST);
    histories.retire(SECOND);
    histories.register(LATE);
    assert!(!histories.summary(LATE).busy);
    histories.finish_forward(forward, ForwardEffect::Changed(Some(action)));

    for client in [FIRST, LATE] {
        let summary = histories.summary(client);
        assert!(!summary.busy);
        assert_eq!(summary.undo_id, None);
        assert_eq!(summary.stack_size, 0);
    }
}

#[test]
fn peer_summary_is_busy_only_when_its_shared_top_entry_has_a_pending_participant() {
    const UNRELATED: u64 = 33;
    for direction in [Direction::Undo, Direction::Redo] {
        let mut histories = Histories::default();
        histories.register(FIRST);
        histories.register(SECOND);
        let shared = copy("/forward/shared-top.txt", true);
        histories.push(FIRST, Some(shared.clone()), true).unwrap();
        if direction == Direction::Redo {
            let undo = histories
                .begin(
                    FIRST,
                    Direction::Undo,
                    histories.summary(FIRST).undo_id.unwrap(),
                )
                .unwrap();
            histories.finish(undo, &completed(&shared, Some(shared.clone())));
        }
        let shared_id = match direction {
            Direction::Undo => histories.summary(SECOND).undo_id.unwrap(),
            Direction::Redo => histories.summary(SECOND).redo_id.unwrap(),
        };

        histories.register(UNRELATED);
        let unrelated = copy("/forward/unrelated.txt", true);
        histories
            .push(UNRELATED, Some(unrelated.clone()), false)
            .unwrap();
        let forward = histories.begin_forward(FIRST, false).unwrap();

        assert!(histories.summary(SECOND).busy);
        assert!(!histories.summary(UNRELATED).busy);
        let unrelated_undo = histories
            .begin(
                UNRELATED,
                Direction::Undo,
                histories.summary(UNRELATED).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(unrelated_undo.action, unrelated);
        histories.finish(
            unrelated_undo,
            &completed(&unrelated, Some(unrelated.clone())),
        );
        assert!(histories
            .begin(SECOND, direction, shared_id)
            .unwrap_err()
            .contains("still in progress"));

        histories.finish_forward(forward, ForwardEffect::Unchanged);
        let restored = histories.summary(SECOND);
        assert!(!restored.busy);
        assert_eq!(
            match direction {
                Direction::Undo => restored.undo_id,
                Direction::Redo => restored.redo_id,
            },
            Some(shared_id)
        );
        let shared_operation = histories.begin(SECOND, direction, shared_id).unwrap();
        assert_eq!(shared_operation.action, shared);
    }
}

#[test]
fn duplicate_forward_settlement_cannot_publish_an_action_twice() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let action = copy("/forward/once.txt", true);
    let forward = histories.begin_forward(FIRST, false).unwrap();
    histories.finish_forward(
        forward.clone(),
        ForwardEffect::Changed(Some(action.clone())),
    );
    histories.finish_forward(forward, ForwardEffect::Changed(Some(action.clone())));

    let summary = histories.summary(FIRST);
    assert_eq!(summary.stack_size, 1);
    let undo = histories
        .begin(FIRST, Direction::Undo, summary.undo_id.unwrap())
        .unwrap();
    assert_eq!(undo.action, action);
    histories.finish(undo, &completed(&action, Some(action.clone())));
    assert_eq!(histories.summary(FIRST).undo_id, None);
}

#[test]
fn pending_forward_count_is_bounded_and_capacity_is_reclaimed() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let reservations = (0..128)
        .map(|_| histories.begin_forward(FIRST, false).unwrap())
        .collect::<Vec<_>>();
    assert!(histories.summary(FIRST).busy);
    assert!(histories
        .begin_forward(FIRST, false)
        .unwrap_err()
        .contains("Too many"));

    for reservation in reservations {
        histories.finish_forward(reservation, ForwardEffect::Unchanged);
    }
    assert!(!histories.summary(FIRST).busy);
    let recovered = histories.begin_forward(FIRST, false).unwrap();
    histories.finish_forward(recovered, ForwardEffect::Unchanged);
}

#[test]
fn unchanged_forward_at_undo_capacity_preserves_every_ready_action() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let actions = (0..256)
        .map(|index| copy(&format!("/capacity/undo-{index}.txt"), true))
        .collect::<Vec<_>>();
    for action in &actions {
        histories.push(FIRST, Some(action.clone()), false).unwrap();
    }
    let before = histories.summary(FIRST);
    assert_eq!(before.stack_size, 256);

    let forward = histories.begin_forward(FIRST, false).unwrap();
    histories.finish_forward(forward, ForwardEffect::Unchanged);
    let after = histories.summary(FIRST);
    assert_eq!(after.stack_size, 256);
    assert_eq!(after.undo_id, before.undo_id);

    for expected in actions.iter().rev() {
        let reservation = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(&reservation.action, expected);
        histories.finish(reservation, &completed(expected, None));
    }
    assert_eq!(histories.summary(FIRST).undo_id, None);
}

#[test]
fn unchanged_forward_at_redo_capacity_preserves_exact_sequence() {
    let mut histories = Histories::default();
    histories.register(FIRST);
    let actions = (0..256)
        .map(|index| copy(&format!("/capacity/redo-{index}.txt"), true))
        .collect::<Vec<_>>();
    for action in &actions {
        histories.push(FIRST, Some(action.clone()), false).unwrap();
    }
    for expected in actions.iter().rev() {
        let reservation = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(&reservation.action, expected);
        histories.finish(reservation, &completed(expected, Some(expected.clone())));
    }
    let redo_id = histories.summary(FIRST).redo_id.unwrap();

    let forward = histories.begin_forward(FIRST, false).unwrap();
    histories.finish_forward(forward, ForwardEffect::Unchanged);
    assert_eq!(histories.summary(FIRST).redo_id, Some(redo_id));

    for expected in &actions {
        let reservation = histories
            .begin(
                FIRST,
                Direction::Redo,
                histories.summary(FIRST).redo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(&reservation.action, expected);
        histories.finish(reservation, &completed(expected, None));
    }
    assert_eq!(histories.summary(FIRST).redo_id, None);
}

#[test]
fn admitted_redo_opposite_stays_below_a_newer_forward_in_both_finish_orders() {
    for forward_finishes_first in [false, true] {
        let mut histories = Histories::default();
        histories.register(FIRST);
        let older_action = copy("/ordered/redo.txt", true);
        histories
            .push(FIRST, Some(older_action.clone()), false)
            .unwrap();
        let undo = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        histories.finish(undo, &completed(&older_action, Some(older_action.clone())));
        let redo = histories
            .begin(
                FIRST,
                Direction::Redo,
                histories.summary(FIRST).redo_id.unwrap(),
            )
            .unwrap();

        let newer_action = copy("/ordered/forward.txt", true);
        let forward = histories.begin_forward(FIRST, false).unwrap();
        if forward_finishes_first {
            histories.finish_forward(forward, ForwardEffect::Changed(Some(newer_action.clone())));
            histories.finish(redo, &completed(&older_action, Some(older_action.clone())));
        } else {
            histories.finish(redo, &completed(&older_action, Some(older_action.clone())));
            histories.finish_forward(forward, ForwardEffect::Changed(Some(newer_action.clone())));
        }

        let undo_newer = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(undo_newer.action, newer_action);
        histories.finish(
            undo_newer,
            &completed(&newer_action, Some(newer_action.clone())),
        );
        let undo_older = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(undo_older.action, older_action);
    }
}

#[test]
fn admitted_partial_redo_keeps_its_retry_and_opposite_below_a_newer_forward() {
    for forward_finishes_first in [false, true] {
        let mut histories = Histories::default();
        histories.register(FIRST);
        let original = deleted(&["/ordered/a.txt", "/ordered/b.txt"]);
        histories
            .push(FIRST, Some(original.clone()), false)
            .unwrap();
        let undo = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        histories.finish(undo, &completed(&original, Some(original.clone())));

        let original_redo_id = histories.summary(FIRST).redo_id.unwrap();
        let redo = histories
            .begin(FIRST, Direction::Redo, original_redo_id)
            .unwrap();
        let newer_action = copy("/ordered/forward-after-partial-redo.txt", true);
        let forward = histories.begin_forward(FIRST, false).unwrap();
        let completed_subset = deleted(&["/ordered/a.txt"]);
        let remaining_subset = deleted(&["/ordered/b.txt"]);
        let partial = Execution {
            uncertain: None,
            completed: Some(completed_subset.clone()),
            opposite: Some(completed_subset.clone()),
            remaining: Some(remaining_subset.clone()),
            error: Some("b failed".into()),
            ..Execution::default()
        };

        if forward_finishes_first {
            histories.finish_forward(forward, ForwardEffect::Changed(Some(newer_action.clone())));
            histories.finish(redo, &partial);
        } else {
            histories.finish(redo, &partial);
            histories.finish_forward(forward, ForwardEffect::Changed(Some(newer_action.clone())));
        }

        let retry = histories
            .begin(
                FIRST,
                Direction::Redo,
                histories.summary(FIRST).redo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(retry.action, remaining_subset);
        histories.finish(
            retry,
            &Execution {
                uncertain: None,
                completed: None,
                opposite: None,
                remaining: Some(remaining_subset.clone()),
                error: Some("still unavailable".into()),
                ..Execution::default()
            },
        );
        assert!(histories
            .begin(FIRST, Direction::Redo, original_redo_id)
            .unwrap_err()
            .contains("changed"));

        let undo_newer = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(undo_newer.action, newer_action);
        histories.finish(
            undo_newer,
            &completed(&newer_action, Some(newer_action.clone())),
        );
        let undo_completed_subset = histories
            .begin(
                FIRST,
                Direction::Undo,
                histories.summary(FIRST).undo_id.unwrap(),
            )
            .unwrap();
        assert_eq!(undo_completed_subset.action, completed_subset);
    }
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
