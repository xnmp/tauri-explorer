//! Pure structural validation before a provider receipt can change ownership.
use super::model::{Admission, AdmissionPhase, ArtifactDescriptor};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// Host policy never starts a request. Recovery only drives an existing result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AutoSettlement {
    Recover,
    Settle,
    Leave,
}
pub(crate) fn auto_settlement(
    _state: AdmissionPhase,
    execution: &str,
    _delivery: &str,
    active: bool,
) -> AutoSettlement {
    if active {
        return AutoSettlement::Leave;
    }
    // A successful execution is never automatically discarded, even when
    // delivery is missing, corrupt, or already explicitly disposed. Only the
    // original handoff/recovery may advance it; later passes silently retry.
    if execution == "succeeded" {
        AutoSettlement::Recover
    } else {
        AutoSettlement::Settle
    }
}

/// A user may dismiss an operation only when nothing remains to recover:
/// recovery was explicitly stopped, the provider's outcome is unknown and it
/// holds no retained output. A succeeded execution keeps its bytes until
/// discarded; an unstopped one is still recoverable.
pub(crate) fn dismissable(stopped: bool, execution: &str, delivery: &str) -> bool {
    stopped && execution == "unknown" && delivery == "none"
}
/// Whether a dismissal marker still hides an operation. The marker pins the
/// provider receipt revision the user accepted; any newer provider evidence
/// (for example a later success with retained bytes) or any change that makes
/// the operation no longer dismissable brings it back.
pub(crate) fn dismissal_holds(
    marked_revision: Option<u64>,
    receipt_revision: Option<u64>,
    stopped: bool,
    execution: &str,
    delivery: &str,
) -> bool {
    matches!((marked_revision, receipt_revision), (Some(m), Some(r)) if m == r)
        && dismissable(stopped, execution, delivery)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    version: u32,
    operation_id: String,
    request_fingerprint: String,
    provider: Provider,
    revision: u64,
    execution: Execution,
    delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostics: Option<OperationDiagnostics>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    package_id: String,
    service_id: String,
    major: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Execution {
    Accepted {},
    Running {},
    Succeeded { metadata: Metadata },
    Failed { error: SafeError },
    Cancelled {},
    Unknown { error: SafeError },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Delivery {
    None {},
    Available {
        output: ArtifactDescriptor,
    },
    Acquired {
        #[serde(rename = "transferReceipt")]
        transfer_receipt: String,
    },
    Discarded {},
    Unavailable {
        reason: UnavailableReason,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UnavailableReason {
    Missing,
    Corrupt,
    StorageUnavailable,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SafeError {
    code: String,
    message: String,
    correlation_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    adapter: String,
    endpoint_identity: String,
    requested_model: Option<String>,
    actual_model: Option<String>,
    external_request_id: Option<String>,
    thread_id: Option<String>,
    options: Options,
    remote_charge_uncertain: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Options {
    size: String,
    resolution: Option<String>,
    aspect_ratio: Option<String>,
    quality: String,
    background: String,
}
impl Options {
    pub(crate) fn valid(&self) -> bool {
        let size = if self.size == "auto" {
            true
        } else {
            self.size
                .split_once('x')
                .and_then(|(w, h)| Some((w.parse::<u64>().ok()?, h.parse::<u64>().ok()?)))
                .is_some_and(|(w, h)| {
                    w > 0
                        && h > 0
                        && w <= 3840
                        && h <= 3840
                        && w % 16 == 0
                        && h % 16 == 0
                        && w <= h * 3
                        && h <= w * 3
                        && (655360..=8294400).contains(&(w * h))
                })
        };
        size && matches!(self.quality.as_str(), "auto" | "low" | "medium" | "high")
            && matches!(self.background.as_str(), "auto" | "opaque" | "transparent")
            && self
                .resolution
                .as_deref()
                .is_none_or(|v| matches!(v, "1k" | "2k" | "4k"))
            && self.aspect_ratio.as_deref().is_none_or(|v| {
                matches!(
                    v,
                    "keep" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "16:9" | "9:16"
                )
            })
    }
}
pub(crate) fn model(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}
pub(crate) fn identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
/// An image adapter identifier such as `openai-images`, `codex-cli` or
/// `gemini`: providers add adapters without a host change, so the host checks
/// the identifier's shape rather than a fixed list.
pub(crate) fn adapter(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn bounded(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(char::is_control)
}
fn valid_error(error: &SafeError) -> bool {
    !error.code.is_empty()
        && error.code.len() <= 64
        && error.code.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.')
        })
        && bounded(&error.message, 2048)
        && error
            .correlation_id
            .as_ref()
            .is_none_or(|id| bounded(id, 128))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CodexTurnState {
    Completed,
    Failed,
    Incomplete,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExplanationKind {
    Reply,
    Error,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailedExplanation {
    pub kind: ExplanationKind,
    pub text: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum OperationDiagnostics {
    CodexImageTurn {
        thread_id: String,
        turn_state: CodexTurnState,
        usage: Option<TokenUsage>,
        explanation: Option<FailedExplanation>,
    },
}
impl OperationDiagnostics {
    pub fn valid(&self, succeeded: bool) -> bool {
        match self {
            Self::CodexImageTurn {
                thread_id,
                usage,
                explanation,
                ..
            } => {
                thread_id.len() == 36
                    && thread_id.bytes().enumerate().all(|(i, b)| {
                        if matches!(i, 8 | 13 | 18 | 23) {
                            b == b'-'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })
                    && usage.as_ref().is_none_or(|u| {
                        [u.input_tokens, u.cached_input_tokens, u.output_tokens]
                            .iter()
                            .all(|v| v.is_none_or(|v| v <= 9_007_199_254_740_991))
                    })
                    && explanation.as_ref().is_none_or(|e| {
                        !succeeded
                            && !e.text.trim().is_empty()
                            && e.text.len() <= 4096
                            && !e
                                .text
                                .chars()
                                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                    })
            }
        }
    }
}

pub(crate) fn validate(value: &Value, admission: &Admission) -> Result<Value, AppError> {
    let invalid = || AppError::Other("Invalid image service receipt".into());
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > 16 * 1024 {
        return Err(invalid());
    }
    let receipt: Receipt = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    if receipt.version != 1
        || receipt.operation_id != admission.operation_id
        || receipt.request_fingerprint != admission.fingerprint
        || receipt.provider.package_id != admission.provider.package_id
        || receipt.provider.service_id != admission.target.service_id
        || receipt.provider.major != admission.target.major
        || receipt.revision == 0
        || receipt.revision > 9_007_199_254_740_991
    {
        return Err(invalid());
    }
    if receipt
        .diagnostics
        .as_ref()
        .is_some_and(|d| !d.valid(matches!(receipt.execution, Execution::Succeeded { .. })))
    {
        return Err(invalid());
    }
    match &receipt.execution {
        Execution::Succeeded { metadata } => {
            if !adapter(&metadata.adapter)
                || !bounded(&metadata.endpoint_identity, 8192)
                || metadata.requested_model.as_ref().is_some_and(|v| !model(v))
                || metadata.actual_model.as_ref().is_some_and(|v| !model(v))
                || metadata
                    .external_request_id
                    .as_ref()
                    .is_some_and(|v| !bounded(v, 128))
                || metadata
                    .thread_id
                    .as_ref()
                    .is_some_and(|v| !bounded(v, 128))
                || !bounded(&metadata.options.size, 64)
                || !bounded(&metadata.options.quality, 32)
                || !bounded(&metadata.options.background, 32)
                || metadata
                    .options
                    .resolution
                    .as_ref()
                    .is_some_and(|v| !bounded(v, 32))
                || metadata
                    .options
                    .aspect_ratio
                    .as_ref()
                    .is_some_and(|v| !bounded(v, 32))
            {
                return Err(invalid());
            }
            if matches!(receipt.delivery, Delivery::None {}) {
                return Err(invalid());
            }
        }
        Execution::Failed { error } | Execution::Unknown { error } => {
            if !valid_error(error) || !matches!(receipt.delivery, Delivery::None {}) {
                return Err(invalid());
            }
        }
        _ => {
            if !matches!(receipt.delivery, Delivery::None {}) {
                return Err(invalid());
            }
        }
    }
    match &receipt.delivery {
        Delivery::Available { output } => {
            if output.handle.len() != 48
                || !output.handle.bytes().all(|b| b.is_ascii_hexdigit())
                || output.sha256.len() != 64
                || !output.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || output.byte_length == 0
                || output.byte_length > 50 * 1024 * 1024
                || output.media_type != "image/png"
            {
                return Err(invalid());
            }
        }
        Delivery::Acquired { transfer_receipt }
            if transfer_receipt.len() != 48
                || !transfer_receipt.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            return Err(invalid());
        }
        _ => {}
    }
    serde_json::to_value(receipt).map_err(|_| invalid())
}
pub(crate) fn validate_transition(previous: &Value, next: &Value) -> Result<(), AppError> {
    let reject = || AppError::Other("Image receipt conflicts with its durable outcome".into());
    // Unknown fences replay; it does not disprove a delayed original result.
    // Only authoritative success can refine it, never a new execution start.
    let late_success =
        previous["execution"]["state"] == "unknown" && next["execution"]["state"] == "succeeded";
    if let Some(d) = previous.get("diagnostics") {
        let n = &next["diagnostics"];
        if d["kind"] != n["kind"]
            || d["threadId"] != n["threadId"]
            || (!late_success
                && d["explanation"].is_object()
                && d["explanation"] != n["explanation"])
            || (previous["execution"]["state"] != "running"
                && previous["execution"]["state"] != "accepted"
                && !late_success
                && d != n)
        {
            return Err(reject());
        }
    }
    let before = previous["execution"]["state"].as_str();
    let after = next["execution"]["state"].as_str();
    if matches!(
        before,
        Some("succeeded" | "failed" | "cancelled" | "unknown")
    ) && !late_success
        && previous["execution"] != next["execution"]
    {
        return Err(reject());
    }
    if before == Some("running") && after == Some("accepted") {
        return Err(reject());
    }
    if matches!(
        previous["delivery"]["state"].as_str(),
        Some("acquired" | "discarded")
    ) && previous["delivery"] != next["delivery"]
    {
        return Err(reject());
    }
    if previous["delivery"]["state"] == "available"
        && next["delivery"]["state"] == "available"
        && previous["delivery"]["output"] != next["delivery"]["output"]
    {
        return Err(reject());
    }
    Ok(())
}

#[cfg(test)]
mod dismissal_tests {
    use super::{dismissable, dismissal_holds};
    #[test]
    fn only_stopped_unknown_with_no_delivery_is_dismissable() {
        assert!(dismissable(true, "unknown", "none"));
    }
    #[test]
    fn an_operation_that_is_not_stopped_is_not_dismissable() {
        assert!(!dismissable(false, "unknown", "none"));
    }
    #[test]
    fn a_succeeded_execution_is_discarded_not_dismissed() {
        for delivery in ["available", "unavailable", "none"] {
            assert!(!dismissable(true, "succeeded", delivery), "{delivery}");
        }
    }
    #[test]
    fn retained_delivery_is_never_dismissable() {
        for delivery in ["available", "unavailable", "acquired", "discarded"] {
            assert!(!dismissable(true, "unknown", delivery), "{delivery}");
        }
    }
    #[test]
    fn other_execution_states_are_not_dismissable() {
        for execution in [
            "accepted",
            "running",
            "failed",
            "cancelled",
            "unconfirmed",
            "",
        ] {
            assert!(!dismissable(true, execution, "none"), "{execution}");
        }
    }
    #[test]
    fn a_marker_at_the_current_revision_hides_a_dismissable_operation() {
        assert!(dismissal_holds(Some(2), Some(2), true, "unknown", "none"));
    }
    #[test]
    fn no_marker_or_no_receipt_hides_nothing() {
        assert!(!dismissal_holds(None, Some(2), true, "unknown", "none"));
        assert!(!dismissal_holds(Some(2), None, true, "unknown", "none"));
    }
    #[test]
    fn newer_provider_evidence_resurfaces_the_operation() {
        assert!(!dismissal_holds(Some(2), Some(3), true, "unknown", "none"));
    }
    #[test]
    fn output_arriving_later_resurfaces_the_operation_even_at_the_same_revision() {
        assert!(!dismissal_holds(
            Some(2),
            Some(2),
            true,
            "succeeded",
            "available"
        ));
        assert!(!dismissal_holds(
            Some(2),
            Some(2),
            true,
            "unknown",
            "available"
        ));
    }
    #[test]
    fn a_marker_never_hides_an_operation_that_is_no_longer_stopped() {
        assert!(!dismissal_holds(Some(2), Some(2), false, "unknown", "none"));
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::adapter;
    #[test]
    fn adapter_identifiers_are_checked_by_shape() {
        for ok in ["openai-images", "codex-cli", "gemini", "bfl", "a", "x2"] {
            assert!(adapter(ok), "{ok}");
        }
        let long = "a".repeat(65);
        for bad in [
            "",
            "Gemini",
            "2fast",
            "-x",
            "open_ai",
            "a b",
            "é",
            long.as_str(),
        ] {
            assert!(!adapter(bad), "{bad}");
        }
    }
}

#[cfg(test)]
mod auto_settlement_tests {
    use super::*;
    #[test]
    fn every_state_execution_delivery_and_activity_combination() {
        for phase in [
            AdmissionPhase::Reserved,
            AdmissionPhase::Forwarding,
            AdmissionPhase::Accepted,
            AdmissionPhase::Terminal,
            AdmissionPhase::Released,
        ] {
            for execution in [
                "accepted",
                "running",
                "succeeded",
                "failed",
                "cancelled",
                "unknown",
                "unconfirmed",
                "",
                "malformed",
            ] {
                for delivery in [
                    "none",
                    "available",
                    "unavailable",
                    "acquired",
                    "discarded",
                    "",
                    "malformed",
                    "unrecoverable",
                ] {
                    assert_eq!(
                        auto_settlement(phase, execution, delivery, true),
                        AutoSettlement::Leave
                    );
                    let decision = auto_settlement(phase, execution, delivery, false);
                    if execution == "unknown" {
                        assert_ne!(
                            decision,
                            AutoSettlement::Recover,
                            "Unknown must never be replayed"
                        );
                    }
                    if execution == "succeeded" {
                        assert_eq!(decision, AutoSettlement::Recover,
                            "successful output must be retained for every delivery state: {phase:?}/{delivery}");
                    } else {
                        assert_eq!(decision, AutoSettlement::Settle);
                    }
                }
            }
        }
    }
}
