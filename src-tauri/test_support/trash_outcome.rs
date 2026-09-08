use super::{
    classify_delete, DeleteCompletionEvidence, DeleteItemCompletion, DeleteOutcome, DeletedArtifact,
};

fn evidence(item: DeleteItemCompletion) -> DeleteCompletionEvidence {
    DeleteCompletionEvidence {
        item,
        other_activity: false,
        rejected_transfer_flags: None,
        perform_error: None,
        aborted: Ok(false),
    }
}

#[test]
fn exact_s_ok_with_nonempty_locator_is_recycled() {
    let locator = vec![b':' as u16, b':' as u16, 1];
    assert_eq!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0,
            artifact: DeletedArtifact::ParsingName(locator.clone()),
        })),
        DeleteOutcome::Recycled(locator)
    );
}

#[test]
fn null_created_item_is_known_completion_without_a_recoverable_artifact() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0,
            artifact: DeletedArtifact::Missing,
        })),
        DeleteOutcome::CommittedWithoutArtifact(message)
            if message.contains("did not provide a recoverable Recycle Bin item")
                && message.contains("Undo is unavailable")
    ));
}

#[test]
fn committed_delete_with_unreadable_locator_is_not_retried() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0,
            artifact: DeletedArtifact::Unavailable("bad locator".into()),
        })),
        DeleteOutcome::CommittedWithoutArtifact(message)
            if message.contains("could not be retained") && message.contains("bad locator")
    ));
}

#[test]
fn explicit_user_ignored_status_is_known_unchanged() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0x0027_0005,
            artifact: DeletedArtifact::Missing,
        })),
        DeleteOutcome::Unchanged(message) if message.contains("USER_IGNORED")
    ));
}

#[test]
fn other_nonnegative_status_is_not_generic_success() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0x0027_000B,
            artifact: DeletedArtifact::Missing,
        })),
        DeleteOutcome::Uncertain(message) if message.contains("0x0027000B")
    ));
}

#[test]
fn failed_status_after_perform_is_uncertain() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0x8027_0001u32 as i32,
            artifact: DeletedArtifact::Missing,
        })),
        DeleteOutcome::Uncertain(message) if message.contains("0x80270001")
    ));
}

#[test]
fn empty_locator_cannot_create_recoverable_history() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0,
            artifact: DeletedArtifact::ParsingName(Vec::new()),
        })),
        DeleteOutcome::Uncertain(message) if message.contains("Recycle Bin item")
    ));
}

#[test]
fn contradictory_skipped_status_and_artifact_is_uncertain() {
    assert!(matches!(
        classify_delete(evidence(DeleteItemCompletion::One {
            hresult: 0x0027_0005,
            artifact: DeletedArtifact::ParsingName(vec![1]),
        })),
        DeleteOutcome::Uncertain(message)
            if message.contains("0x00270005") && message.contains("Recycle Bin item")
    ));
}

#[test]
fn missing_duplicate_and_wrong_source_callbacks_are_uncertain() {
    for item in [
        DeleteItemCompletion::Missing,
        DeleteItemCompletion::Duplicate,
        DeleteItemCompletion::InvalidSource("descendant only".into()),
    ] {
        assert!(matches!(
            classify_delete(evidence(item)),
            DeleteOutcome::Uncertain(_)
        ));
    }
}

#[test]
fn rejected_predelete_flags_are_unchanged_only_without_later_activity() {
    let rejected = |item| DeleteCompletionEvidence {
        item,
        other_activity: false,
        rejected_transfer_flags: Some(0x40),
        perform_error: Some("E_ABORT".into()),
        aborted: Ok(true),
    };
    assert!(matches!(
        classify_delete(rejected(DeleteItemCompletion::Missing)),
        DeleteOutcome::Unchanged(message) if message.contains("canceled before it began")
    ));
    assert!(matches!(
        classify_delete(rejected(DeleteItemCompletion::InvalidSource(
            "descendant callback".into()
        ))),
        DeleteOutcome::Uncertain(message) if message.contains("deletion activity")
    ));
}

#[test]
fn skipped_root_with_descendant_activity_is_uncertain() {
    assert!(matches!(
        classify_delete(DeleteCompletionEvidence {
            item: DeleteItemCompletion::One {
                hresult: 0x0027_0005,
                artifact: DeletedArtifact::Missing,
            },
            other_activity: true,
            rejected_transfer_flags: None,
            perform_error: None,
            aborted: Ok(false),
        }),
        DeleteOutcome::Uncertain(message)
            if message.contains("deletion activity") && message.contains("another Shell item")
    ));
}

#[test]
fn exact_root_artifact_remains_authoritative_for_recursive_directory_activity() {
    let locator = vec![1, 2, 3];
    assert_eq!(
        classify_delete(DeleteCompletionEvidence {
            item: DeleteItemCompletion::One {
                hresult: 0,
                artifact: DeletedArtifact::ParsingName(locator.clone()),
            },
            other_activity: true,
            rejected_transfer_flags: None,
            perform_error: None,
            aborted: Ok(false),
        }),
        DeleteOutcome::Recycled(locator)
    );
}

#[test]
fn exact_item_callback_is_authoritative_over_global_status() {
    let locator = vec![1, 2, 3];
    assert_eq!(
        classify_delete(DeleteCompletionEvidence {
            item: DeleteItemCompletion::One {
                hresult: 0,
                artifact: DeletedArtifact::ParsingName(locator.clone()),
            },
            other_activity: false,
            rejected_transfer_flags: None,
            perform_error: Some("operation-level failure".into()),
            aborted: Ok(true),
        }),
        DeleteOutcome::Recycled(locator)
    );
}
