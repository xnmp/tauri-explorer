//! Pure retention policy (ADR 0023). No filesystem or coordinator ownership.
use super::*;
use crate::files::recovery::coordinator::test_fixture::fixture;
use crate::files::recovery::model::{ReplacementState, StagedPayload};

fn spec() -> OperationSpec {
    let (_directory, _coordinator, reservation, spec) = fixture();
    reservation.finish().unwrap();
    spec
}

fn staged(spec: &OperationSpec) -> StagedPayload {
    let OperationSpec::CopyReplacement(replacement) = spec else {
        panic!("copy replacement fixture");
    };
    // A staged payload is only shape evidence here; retention never reads it.
    StagedPayload {
        version: replacement.source_version.clone(),
        final_mode: None,
    }
}

fn state(spec: &OperationSpec, phase: Phase, error: Option<&str>) -> OperationState {
    let published = matches!(
        phase,
        Phase::Staged
            | Phase::DisplaceIntent
            | Phase::Displaced
            | Phase::PublishIntent
            | Phase::Published
            | Phase::RestoreIntent
            | Phase::Restored
            | Phase::ReapplyIntent
            | Phase::DiscardIntent
            | Phase::Discarded
    )
    .then(|| staged(spec));
    OperationState::Replacement(ReplacementState {
        effect_revision: 0,
        retained_bytes: None,
        root: None,
        phase,
        published,
        error: error.map(str::to_owned),
    })
}

#[test]
fn a_completed_overwrite_retains_the_only_original_and_needs_an_explicit_decision() {
    let spec = spec();
    assert_eq!(
        retention(&spec, &state(&spec, Phase::Published, None)),
        Retention::Settled {
            retained: Retained::Original,
            disposal: Disposal::ExplicitOnly,
        }
    );
}

#[test]
fn a_completed_restoration_retains_a_copy_that_automatic_retirement_may_reclaim() {
    let spec = spec();
    assert_eq!(
        retention(&spec, &state(&spec, Phase::Restored, None)),
        Retention::Settled {
            retained: Retained::Publication,
            disposal: Disposal::AutomaticWhenSourceIntact,
        }
    );
}

#[test]
fn every_incomplete_phase_is_unresolved_and_never_retirable() {
    let spec = spec();
    for phase in [
        Phase::Planned,
        Phase::RootIntent,
        Phase::Rooted,
        Phase::ManifestIntent,
        Phase::Prepared,
        Phase::StageIntent,
        Phase::Staged,
        Phase::DisplaceIntent,
        Phase::Displaced,
        Phase::PublishIntent,
        Phase::RestoreIntent,
        Phase::ReapplyIntent,
    ] {
        let retention = retention(&spec, &state(&spec, phase, None));
        assert_eq!(retention, Retention::Unresolved, "{phase:?}");
        assert!(!retention.retirable(), "{phase:?}");
        assert!(retention.settled().is_none(), "{phase:?}");
    }
}

#[test]
fn a_recorded_error_preserves_evidence_instead_of_offering_disposal() {
    let spec = spec();
    for phase in [Phase::Published, Phase::Restored] {
        assert_eq!(
            retention(&spec, &state(&spec, phase, Some("cleanup failed"))),
            Retention::Unresolved,
            "{phase:?}"
        );
    }
    // A retirement already under way stays resumable while reporting its error.
    assert_eq!(
        retention(
            &spec,
            &state(&spec, Phase::DiscardIntent, Some("cleanup failed"))
        ),
        Retention::Retiring
    );
    assert_eq!(
        retention(
            &spec,
            &state(&spec, Phase::Discarded, Some("cleanup failed"))
        ),
        Retention::Residue
    );
}

#[test]
fn retirement_phases_are_retirable_without_offering_a_user_discard() {
    let spec = spec();
    for (phase, expected) in [
        (Phase::DiscardIntent, Retention::Retiring),
        (Phase::Discarded, Retention::Residue),
    ] {
        let retention = retention(&spec, &state(&spec, phase, None));
        assert_eq!(retention, expected);
        assert!(retention.retirable());
        assert!(retention.settled().is_none());
    }
}

#[test]
fn an_operation_kind_without_a_retention_plan_is_never_retired() {
    let spec = spec();
    // A checkpoint of another kind never adopts the replacement plan, and a
    // replacement checkpoint never authorizes another kind's artifacts.
    let other_kind = OperationState::Move(crate::files::recovery::move_model::MoveState::default());
    let retention = retention(&spec, &other_kind);
    assert_eq!(retention, Retention::Unresolved);
    assert!(!retention.retirable());
    assert_eq!(measured_bytes(&other_kind), None);
}

#[test]
fn budget_defaults_survive_absent_malformed_and_out_of_range_settings() {
    let default = Budget::default();
    assert_eq!(default.records, DEFAULT_RECORD_BUDGET);
    assert_eq!(default.bytes, DEFAULT_BYTE_BUDGET);
    for settings in [
        serde_json::json!({}),
        serde_json::json!({ "recoveryRetainedBytesBudget": "8", "recoveryRetainedRecordBudget": [] }),
        serde_json::json!({ "recoveryRetainedBytesBudget": 0, "recoveryRetainedRecordBudget": 0 }),
        serde_json::json!({ "recoveryRetainedBytesBudget": -4, "recoveryRetainedRecordBudget": -1 }),
        serde_json::json!({
            "recoveryRetainedBytesBudget": u64::MAX,
            "recoveryRetainedRecordBudget": u64::MAX,
        }),
        // A record budget above the catalog cap cannot become the bound.
        serde_json::json!({ "recoveryRetainedRecordBudget": 4096 }),
        serde_json::json!({ "recoveryRetainedBytesBudget": 1.5 }),
    ] {
        assert_eq!(Budget::from_settings(&settings), default, "{settings}");
    }
}

#[test]
fn budget_accepts_in_range_settings() {
    let budget = Budget::from_settings(&serde_json::json!({
        "recoveryRetainedBytesBudget": 4096,
        "recoveryRetainedRecordBudget": 3,
    }));
    assert_eq!(
        budget,
        Budget {
            bytes: 4096,
            records: 3
        }
    );
}

#[test]
fn every_durable_record_consumes_the_record_bound_even_when_unresolved() {
    // The record bound exists so retention refuses new work before the catalog
    // exhausts itself; an unresolved record retains artifacts and must count.
    let budget = Budget {
        bytes: u64::MAX,
        records: 2,
    };
    let mut usage = Usage::default();
    usage.add(Retention::Unresolved, None, true);
    assert!(!usage.at_capacity(&budget));
    usage.add(Retention::Unresolved, None, true);
    assert!(usage.at_capacity(&budget));
    assert_eq!(usage.discardable, 0);
}

#[test]
fn usage_counts_records_and_separates_unmeasured_from_unavailable() {
    let settled = Retention::Settled {
        retained: Retained::Original,
        disposal: Disposal::ExplicitOnly,
    };
    let mut usage = Usage::default();
    usage.add(settled, Some(100), true);
    usage.add(settled, None, true);
    usage.add(settled, Some(u64::MAX), false);
    usage.add(Retention::Retiring, Some(7), true);
    usage.add(Retention::Unresolved, Some(9), true);
    usage.add(Retention::Unresolved, Some(9), false);
    assert_eq!(
        usage,
        Usage {
            records: 6,
            bytes: 116,
            unmeasured: 1,
            unavailable: 2,
            discardable: 2,
        }
    );
}

#[test]
fn capacity_is_reached_by_either_bound_and_unmeasured_records_still_consume_it() {
    let budget = Budget {
        bytes: 1000,
        records: 2,
    };
    let settled = Retention::Settled {
        retained: Retained::Publication,
        disposal: Disposal::AutomaticWhenSourceIntact,
    };
    let mut under = Usage::default();
    under.add(settled, Some(999), true);
    assert!(!under.at_capacity(&budget));

    let mut by_bytes = under;
    by_bytes.add(settled, Some(1), true);
    assert!(by_bytes.at_capacity(&budget));

    let mut by_records = Usage::default();
    by_records.add(settled, None, true);
    by_records.add(settled, None, true);
    assert!(by_records.at_capacity(&budget));
    assert_eq!(by_records.bytes, 0);
}
