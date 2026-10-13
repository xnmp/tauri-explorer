//! Host-authored presentation identity. Provider success is not consumer completion.
use super::model::PackageGeneration;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum JobState {
    Accepting,
    Running,
    Recovering,
    NeedsAttention,
    Completed,
    Error,
    Cancelled,
    Discarded,
}
impl JobState {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Error | Self::Cancelled | Self::Discarded
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobRecord {
    pub job_key: String,
    pub owner: PackageGeneration,
    /// Host-authorized preparation ownership transfers; never consumer-authored.
    #[serde(default)]
    pub ownership_epoch: u64,
    pub operation_id: String,
    pub job_id: u64,
    pub kind: String,
    pub label: String,
    /// Opaque timing cohort, pinned by the first prepared consumer receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_key: Option<String>,
    pub origin_window: String,
    pub revision: u64,
    #[serde(default)]
    pub source_revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// When the row first became retained (terminal or parked). Unlike
    /// `updated_at_ms` it never moves afterwards, so it is the end of the
    /// job's duration. Absent on rows settled before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at_ms: Option<u64>,
    pub state: JobState,
    pub phase: Option<String>,
    pub output_path: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_cost"
    )]
    pub cost: Option<JobCost>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_reveal"
    )]
    pub reveal: Option<JobReveal>,
    pub run_id: Option<i64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobSnapshot {
    pub watermark: u64,
    pub jobs: Vec<JobRecord>,
}

/// Optional job metadata is untrusted: discard it without losing the job.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobCost {
    pub amount: String,
    pub currency: String,
    pub estimated: bool,
    pub source: String,
}
impl JobCost {
    pub(crate) fn valid(&self) -> bool {
        let mut parts = self.amount.split('.');
        let whole = parts.next().unwrap_or("");
        let fraction = parts.next();
        !whole.is_empty()
            && whole.bytes().all(|b| b.is_ascii_digit())
            && fraction.is_none_or(|s| {
                !s.is_empty() && s.len() <= 6 && s.bytes().all(|b| b.is_ascii_digit())
            })
            && parts.next().is_none()
            && self.currency.len() == 3
            && self.currency.bytes().all(|b| b.is_ascii_uppercase())
            && !self.source.is_empty()
            && self.source.chars().count() <= 64
            && !self.source.chars().any(char::is_control)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum JobReveal {
    File {
        path: String,
    },
    View {
        view_id: String,
        directory: String,
        target_id: String,
    },
}
impl JobReveal {
    pub(crate) fn valid(&self) -> bool {
        let text =
            |s: &str, max| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control);
        match self {
            Self::File { path } => text(path, 4096),
            Self::View {
                view_id,
                directory,
                target_id,
            } => {
                text(directory, 4096)
                    && text(target_id, 128)
                    && !view_id.is_empty()
                    && view_id.len() <= 128
                    && view_id.as_bytes()[0].is_ascii_alphanumeric()
                    && view_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            }
        }
    }
}
pub(crate) fn cost(value: &serde_json::Value) -> Option<JobCost> {
    serde_json::from_value::<JobCost>(value.clone())
        .ok()
        .filter(JobCost::valid)
}
pub(crate) fn reveal(value: &serde_json::Value) -> Option<JobReveal> {
    serde_json::from_value::<JobReveal>(value.clone())
        .ok()
        .filter(JobReveal::valid)
}
fn deserialize_cost<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<JobCost>, D::Error> {
    Ok(cost(&serde_json::Value::deserialize(d)?))
}
fn deserialize_reveal<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<JobReveal>, D::Error> {
    Ok(reveal(&serde_json::Value::deserialize(d)?))
}
