//! Pure structural validation before a provider receipt can change ownership.
use super::model::{Admission, ArtifactDescriptor};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    pub(crate) fn valid(&self)->bool {
        let size=if self.size=="auto" {true} else {self.size.split_once('x').and_then(|(w,h)|Some((w.parse::<u64>().ok()?,h.parse::<u64>().ok()?))).is_some_and(|(w,h)|w>0&&h>0&&w<=3840&&h<=3840&&w%16==0&&h%16==0&&w<=h*3&&h<=w*3&&(655360..=8294400).contains(&(w*h)))};
        size&&matches!(self.quality.as_str(),"auto"|"low"|"medium"|"high")&&matches!(self.background.as_str(),"auto"|"opaque"|"transparent")&&self.resolution.as_deref().is_none_or(|v|matches!(v,"1k"|"2k"|"4k"))&&self.aspect_ratio.as_deref().is_none_or(|v|matches!(v,"keep"|"1:1"|"4:3"|"3:4"|"3:2"|"2:3"|"16:9"|"9:16"))
    }
}
pub(crate) fn model(value:&str)->bool {!value.trim().is_empty()&&value.chars().count()<=256&&!value.chars().any(char::is_control)}
pub(crate) fn identity(value:&str)->bool {!value.is_empty()&&value.len()<=128&&value.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))}
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
enum CodexTurnState { Completed, Failed, Incomplete }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExplanationKind { Reply, Error }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailedExplanation {
    pub kind: ExplanationKind,
    pub text: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
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
            Self::CodexImageTurn { thread_id, usage, explanation, .. } => {
                thread_id.len() == 36 && thread_id.bytes().enumerate().all(|(i,b)| if matches!(i,8|13|18|23) { b == b'-' } else { b.is_ascii_hexdigit() })
                    && usage.as_ref().is_none_or(|u| [u.input_tokens,u.cached_input_tokens,u.output_tokens].iter().all(|v|v.is_none_or(|v|v <= 9_007_199_254_740_991)))
                    && explanation.as_ref().is_none_or(|e| !succeeded && !e.text.trim().is_empty() && e.text.len() <= 4096 && !e.text.chars().any(|c|c.is_control() && !matches!(c,'\n'|'\r'|'\t')))
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
    if receipt.diagnostics.as_ref().is_some_and(|d| !d.valid(matches!(receipt.execution, Execution::Succeeded { .. }))) { return Err(invalid()); }
    match &receipt.execution {
        Execution::Succeeded { metadata } => {
            if !matches!(metadata.adapter.as_str(), "openai-images" | "codex-cli")
                || !bounded(&metadata.endpoint_identity, 8192)
                || metadata
                    .requested_model
                    .as_ref()
                    .is_some_and(|v| !model(v))
                || metadata
                    .actual_model
                    .as_ref()
                    .is_some_and(|v| !model(v))
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
        Delivery::Acquired { transfer_receipt } => {
            if transfer_receipt.len() != 48
                || !transfer_receipt.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
        }
        _ => {}
    }
    serde_json::to_value(receipt).map_err(|_| invalid())
}
pub(crate) fn validate_transition(previous: &Value, next: &Value) -> Result<(), AppError> {
    let reject = || AppError::Other("Image receipt conflicts with its durable outcome".into());
    if let Some(d) = previous.get("diagnostics") {
        let n = &next["diagnostics"];
        if d["kind"] != n["kind"] || d["threadId"] != n["threadId"]
            || (d["explanation"].is_object() && d["explanation"] != n["explanation"])
            || (previous["execution"]["state"] != "running" && previous["execution"]["state"] != "accepted" && d != n)
        { return Err(reject()); }
    }
    let before = previous["execution"]["state"].as_str();
    let after = next["execution"]["state"].as_str();
    if matches!(
        before,
        Some("succeeded" | "failed" | "cancelled" | "unknown")
    ) && previous["execution"] != next["execution"]
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
