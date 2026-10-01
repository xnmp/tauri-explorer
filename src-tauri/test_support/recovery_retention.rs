//! Pure retention policy (ADR 0023). No filesystem or coordinator ownership.
use super::*;
use crate::files::recovery::checkpoint::{
    Checkpoint, Decision, Phase, RetirementState, Sides, State, Step,
};
use crate::files::recovery::coordinator::test_fixture::fixture;
use crate::files::recovery::model::{OperationSpec, ReplacementSpec, StagedPayload};

fn spec() -> ReplacementSpec {
    let (_directory, _coordinator, reservation, spec) = fixture();
    reservation.finish().unwrap();
    let OperationSpec::CopyReplacement(spec) = spec else {
        panic!("copy replacement fixture");
    };
    spec
}

fn state(spec: &ReplacementSpec, phase: Phase, error: Option<&str>) -> State {
    // A staged payload is only shape evidence here; retention never reads it.
    let staged = !matches!(
        phase,
        Phase::Planned
            | Phase::RootIntent
            | Phase::Rooted
            | Phase::ManifestIntent
            | Phase::Prepared
            | Phase::StageIntent
    );
    State {
        phase,
        staged: staged.then(|| StagedPayload {
            version: spec.source_version.clone(),
            final_mode: None,
        }),
        error: error.map(str::to_owned),
        ..State::default()
    }
}

fn retention(spec: &ReplacementSpec, state: &State) -> Retention {
    Checkpoint { spec, state }.retention()
}

fn retiring(mut state: State, completed: bool) -> State {
    state.retirement = Some(RetirementState {
        decision: Decision::Explicit,
        steps: Sides {
            source: None,
            target: Some(if completed {
                Step::Removed
            } else {
                Step::Pending
            }),
        },
        plans: Sides::default(),
        completed,
    });
    state
}

#[test]
fn a_completed_overwrite_retains_the_only_original_and_needs_an_explicit_decision() {
    let spec = spec();
    assert_eq!(
        retention(&spec, &state(&spec, Phase::Published, None)),
        Retention::Settled {
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
        assert!(!retention.settled(), "{phase:?}");
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
    let failed = state(&spec, Phase::Published, Some("cleanup failed"));
    assert_eq!(
        retention(&spec, &retiring(failed.clone(), false)),
        Retention::Retiring
    );
    assert_eq!(
        retention(&spec, &retiring(failed, true)),
        Retention::Residue
    );
}

#[test]
fn retirement_is_retirable_without_offering_a_user_discard() {
    let spec = spec();
    for (completed, expected) in [(false, Retention::Retiring), (true, Retention::Residue)] {
        let retention = retention(
            &spec,
            &retiring(state(&spec, Phase::Restored, None), completed),
        );
        assert_eq!(retention, expected);
        assert!(retention.retirable());
        assert!(!retention.settled());
    }
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

#[test]
fn interrupted_retirement_without_a_measurement_is_reported_as_unknown() {
    let mut usage = Usage::default();
    usage.add(Retention::Retiring, None, true);
    assert_eq!(usage.records, 1);
    assert_eq!(usage.unmeasured, 1);
}
